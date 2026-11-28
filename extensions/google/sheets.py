"""google-sheets: any of the user's Google Sheets, read in one call: a tab's cells exactly as the sheet shows them, as
CSV, rows or records, by the sheet's id or link and the tab's name.

It reads through the Mac mini's Chrome, which is signed in to every one of the user's Google accounts, so any sheet one of
them can open is readable with no consent or token of its own: Docs picks the account that has access, or `account`
names one. A background tab on docs.google.com asks Sheets' own export for the tab (`/export?format=csv&gid=`, which
gives each cell as displayed; gviz's CSV guesses a type per column and blanks the cells that don't fit, so it isn't
used), and `/htmlview` for the tab names and their gids, kept per sheet in state.json. Big tabs come back gzipped in
pages, since the browser action answers at most 24 KB a call. The tab is let go once it's idle.

Writing goes through Google's Sheets API instead, as a connected account, since the browser's sign-ins can't call
it: an account grants the spreadsheets scope once (connect gives a consent link that works in any browser; Google
sends it back to the core's callback, which calls finish), and its refresh token stays in secrets.json in its own
SB_HOME (google_oauth.py), never in a record. write sets a range's cells (refusing to write over a formula, or over
cells that don't show what expect says) and reads back what they show; append puts rows after a tab's last row, by
position or by its header's names. Both say before and after for every cell they wrote.

What it records: each connected account as sheets-account:<account> in sheets/accounts, each write as an
observation of google-sheet:<id> in sheets/writes (what changed, cell by cell), and a heartbeat of itself in
vitals/google-sheets. What it reads goes only to whoever asked.
"""

import base64
import csv
import itertools
import gzip
import html
import io
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import client as httpclient

import sbmcp
from server import part, home as home_of
from google_oauth import CONNECT, OPENS, SWITCH, Disconnected, Google

NAME = "google-sheets"
HOME = home_of("sheets")
"""Where it keeps what lasts between runs: its keeper's SB_HOME, or .home by hand."""
HEARTBEAT_S = float(os.environ.get("GOOGLE_SHEETS_HEARTBEAT_S") or 600)
"""How often it says how it is, in vitals/google-sheets: what --health-every 1800000 promises, with room."""
BROWSERS = [b for b in (os.environ.get("GOOGLE_SHEETS_BROWSERS") or "macos@local,macos@laptop").split(",") if b]
"""Whose Chrome reads the sheets, in order: the Mac mini's (always awake), else the Air's."""
SESSION = "google-sheets"
HOME_PAGE = "https://docs.google.com/robots.txt"
"""A light page on docs.google.com, so the tab's requests to Sheets are same-origin and carry its sign-ins."""
IDLE_S = 300
"""A tab nobody used for this long is let go."""
INLINE_BYTES = 15000
PAGE = 16000
"""The browser action cuts what a script returns at 24 KB: a tab under 15 KB comes back in one answer, a bigger one
gzipped and base64'd, 16,000 characters a page."""
TABS_TTL_S = 6 * 3600
"""How long a sheet's tab names and gids are trusted before they're read again (a miss reads them at once)."""
DEFAULT_CHARS = 20000
MAX_CHARS = 200000
LOGIN = re.compile(r"accounts\.google\.com/(v3/signin|ServiceLogin|AccountChooser|signin)")

app = part("sheets", {"connect": "sheets_connect", "accounts": "sheets_accounts", "status": "sheets_status", "read": "sheets_read"}, shared={"read"})
app.event("heartbeat", "How it is itself", stream=f"vitals/{NAME}", kind="observation", retention="signal")
app.event("account", "A Google account connected for writing: whether it still works", stream="sheets/accounts", kind="observation")
app.event("write", "Cells it wrote in a sheet: where, as which account, and each one's before and after",
          stream="sheets/writes", kind="observation")

lock = threading.RLock()
tab_lock = threading.Lock()
status_ = {"started_at": int(time.time() * 1000), "reads": 0, "writes": 0, "last_write": None, "failed": 0, "last_error": None, "last_error_at": None,
           "last_problem": None, "last_problem_at": None, "last_read": None, "browser": None}
"""last_error is any call's (a tab that isn't there, too); last_problem only what's wrong with the reading itself: no
Mac's Chrome answered, or it's signed out of Google."""


order = itertools.count(1)
"""Which came last, a failed read or a good one: two in the same millisecond still have an order."""


def failed(e, op):
    keep_failure(op, e)
    status_["failed"] += 1
    status_["last_error"] = f"{type(e).__name__}: {e}"
    status_["last_error_at"] = int(time.time() * 1000)
    if isinstance(e, Unavailable) or "isn't signed in to Google" in str(e):
        status_["last_problem"], status_["last_problem_at"] = status_["last_error"], status_["last_error_at"]
        status_["problem_n"] = next(order)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Unavailable(Exception):
    """The Mac's browser couldn't do it: asleep, offline, or the tab went away."""

    def __init__(self, message, body=None):
        super().__init__(message)
        self.body = body


class Refused(LookupError):
    """Sheets didn't give what was asked (no such sheet, not shared, signed out): its status and the start of its page."""

    def __init__(self, message, meta):
        super().__init__(message)
        self.status, self.body = meta.get("status"), meta.get("snippet") or meta.get("title") or meta.get("url")


# Failed calls, kept to look back on: sqlite3 failures.db "select * from failures order by at desc limit 20".

FAILURES = os.path.join(HOME, "failures.db")
FAILURES_KEPT = 2000
BODY_CHARS = 300
SECRET = re.compile(r"ya29\.[\w-]+|1//[\w-]{20,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?i:bearer)\s+[\w.~+/-]+=*")
SECRET_FIELD = re.compile(r"((?i:access_token|refresh_token|id_token|client_secret)[\"']?\s*[:=]\s*[\"']?|[?&](?:code|state)=)[^\"'&\s,}]+")
"""Credentials a body or error could carry (OAuth tokens, a consent's code), masked before anything is kept."""


def masked(text, n=BODY_CHARS):
    if text is None:
        return None
    text = SECRET_FIELD.sub(r"\1…", SECRET.sub("…", str(text)))
    return text if len(text) <= n else text[:n] + "…"


def keep_failure(op, e):
    """One failed call in failures.db: when, which tool, the status Sheets or the browser answered, the error, and the
    start of what came back, secrets masked. Never fails the call it's about."""
    cause = e.__context__ if e.__context__ is not None else e.__cause__
    status = getattr(e, "status", None) or getattr(cause, "status", None)
    body = getattr(e, "body", None) or getattr(cause, "body", None)
    try:
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        with lock, sqlite3.connect(FAILURES, timeout=5) as db:
            db.execute("create table if not exists failures (at integer, op text, kind text, status integer, error text,"
                       " body text, browser text)")
            db.execute("insert into failures values (?, ?, ?, ?, ?, ?, ?)",
                       (int(time.time() * 1000), op, type(e).__name__, status if isinstance(status, int) else None,
                        masked(str(e), 500), masked(body), status_.get("browser")))
            db.execute("delete from failures where rowid <= (select max(rowid) from failures) - ?", (FAILURES_KEPT,))
    except Exception as x:
        log(f"couldn't keep the failure in {FAILURES}: {x}")


def recent_failures(n=10):
    try:
        with lock, sqlite3.connect(FAILURES, timeout=5) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute("select * from failures order by rowid desc limit ?", (n,))]
    except sqlite3.Error:
        return []


# State: what it learned of each sheet (title, tabs and gids). Nothing secret, nothing read from a sheet's cells.

STATE = os.path.join(HOME, "state.json")


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


state = {"sheets": {}, **load_state()}


def save_state():
    with lock:
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        with open(STATE + ".new", "w") as f:
            json.dump(state, f)
        os.replace(STATE + ".new", STATE)


# The world outside, in one place: one call of a Mac's browser action. Its tests put a fake here.


def browse(target, args, timeout=60):
    cmd = ["sb", "request", target, "browser", "--args", json.dumps(args), "--timeout", str(int(timeout) + 15)]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)
    except subprocess.TimeoutExpired:
        raise Unavailable(f"{target}'s browser didn't answer in {timeout + 30} s")
    except OSError as e:
        raise Unavailable(f"couldn't run sb to reach {target}: {e}")
    try:
        res = json.loads(p.stdout)
    except ValueError:
        raise Unavailable(f"{target}'s browser: {(p.stderr or p.stdout).strip()[:300]}")
    if not res.get("ok"):
        raise Unavailable(f"{target}'s browser: {str(res.get('error') or res.get('output'))[:300]}")
    return answer_text(res.get("output"))


def answer_text(out):
    """What the browser action printed. Switch's browser extension answers {"text": ...} (and its images), Switchboard's
    answered the text itself; anything else is a browser this doesn't understand, said as such rather than read as text."""
    if out is None or isinstance(out, str):
        return out
    if isinstance(out, dict) and isinstance(out.get("text"), str):
        return out["text"]
    raise Unavailable(f"the browser answered in a shape this doesn't read: {json.dumps(out)[:200]}")


class Tab:
    """The one background tab on docs.google.com, in the first browser that answers, let go when idle."""

    def __init__(self):
        self.target = None
        self.used = 0.0

    def _open(self, target):
        last = None
        for _ in range(2):  # a brand-new tab sometimes detaches during its first navigation
            try:
                browse(target, {"op": "navigate", "session": SESSION, "url": HOME_PAGE}, 60)
                host = browse(target, {"op": "js", "session": SESSION, "code": "location.host"}, 30)
                if "docs.google.com" in str(host):
                    return
                last = Unavailable(f"the tab in {target}'s Chrome is on {host}, not docs.google.com")
            except Unavailable as e:
                last = e
        raise last

    def js(self, code, timeout=60):
        """Runs an expression in the tab and returns its string, opening the tab first (in the next browser if one
        doesn't answer) and opening it again, once, if it went away."""
        with tab_lock:
            errors = []
            order = [self.target] + [b for b in BROWSERS if b != self.target] if self.target else list(BROWSERS)
            for target in order:
                try:
                    if self.target != target:
                        self._open(target)
                        self.target = target
                    try:
                        out = browse(target, {"op": "js", "session": SESSION, "code": code, "timeout": timeout}, timeout)
                    except Unavailable as e:
                        if not re.search(r"etached|closed|no tab|not found|session", str(e), re.I):
                            raise
                        self._open(target)
                        out = browse(target, {"op": "js", "session": SESSION, "code": code, "timeout": timeout}, timeout)
                    self.used = time.time()
                    status_["browser"] = target
                    out = "" if out is None else str(out)
                    if "…(cut:" in out:
                        raise Unavailable("the browser cut its answer short")
                    return out
                except Unavailable as e:
                    errors.append(str(e))
                    self.target = None
            raise Unavailable("; ".join(errors) or "no browser to read sheets with")

    def reopen(self):
        with tab_lock:
            target = self.target or BROWSERS[0]
            self._open(target)
            self.target = target

    def release_if_idle(self):
        if self.target and time.time() - self.used > IDLE_S and tab_lock.acquire(blocking=False):
            try:
                browse(self.target, {"op": "release", "session": SESSION}, 30)
            except Unavailable:
                pass
            finally:
                self.target = None
                tab_lock.release()


TAB = Tab()

GET_JS = r"""
(() => {
  if (location.host !== 'docs.google.com') return JSON.stringify({wrong_page: location.href});
  const g = window.__gsheets = window.__gsheets || {};
  const key = __KEY__, url = __URL__, tabs = __TABS__;
  const x = new XMLHttpRequest();
  let err = null;
  try { x.open('GET', url, false); x.send(); } catch (e) { err = String(e); }
  const text = err ? '' : (x.responseText || '');
  const type = err ? '' : (x.getResponseHeader('content-type') || '');
  const meta = {status: err ? 0 : x.status, url: err ? url : x.responseURL, type: type, length: text.length, error: err};
  const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1];
  if (tabs) {
    const un = s => s.replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
                     .replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    meta.title = title || null;
    meta.tabs = [...text.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*?gid=(\d+)/g)].map(m => ({name: un(m[1]), gid: m[2]}));
    if (!meta.tabs.length) meta.snippet = text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    return JSON.stringify(meta);
  }
  if (!/text\/(csv|tab-separated)/.test(type)) {
    meta.title = title || null;
    meta.snippet = text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    return JSON.stringify(meta);
  }
  if (new TextEncoder().encode(text).length <= __INLINE__) { meta.text = text; return JSON.stringify(meta); }
  g[key] = {text: text, done: false};
  try {
    new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then(b => {
      const u = new Uint8Array(b); let s = '';
      for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      g[key].gz = btoa(s); g[key].done = true;
    }, e => { g[key].gzerr = String(e); g[key].done = true; });
    meta.pending = true;
  } catch (e) { g[key].done = true; g[key].gzerr = String(e); meta.pending = true; }
  return JSON.stringify(meta);
})()
"""

POLL_JS = r"""JSON.stringify((() => { const e = (window.__gsheets || {})[__KEY__];
  return e ? {done: e.done, gz: e.gz ? e.gz.length : null, gzerr: e.gzerr || null} : {gone: true}; })())"""


def get(url, tabs=False):
    """One GET of a docs.google.com URL in the tab: its status, final URL, type and title, and its text (a CSV's) or
    the spreadsheet's tabs (htmlview's). Big texts come back gzipped, a page at a time."""
    key = secrets.token_hex(6)
    code = (GET_JS.replace("__KEY__", json.dumps(key)).replace("__URL__", json.dumps(url))
            .replace("__TABS__", "true" if tabs else "false").replace("__INLINE__", str(INLINE_BYTES)))
    for attempt in range(2):
        raw = TAB.js(code, timeout=90)
        try:
            meta = json.loads(raw)
        except ValueError:
            raise Unavailable(f"the tab answered {raw[:200]!r}", body=raw)
        if "wrong_page" not in meta:
            break
        if attempt:
            raise Unavailable(f"the tab won't stay on docs.google.com (it's on {meta['wrong_page'][:100]})")
        log(f"the tab was on {meta['wrong_page'][:100]}, not docs.google.com: opening it again")
        TAB.reopen()  # closed, or moved, since it was last used
    if not meta.get("pending"):
        return meta
    try:
        for _ in range(100):
            p = json.loads(TAB.js(POLL_JS.replace("__KEY__", json.dumps(key)), 30))
            if p.get("gone"):
                raise Unavailable("the tab was reloaded while reading")
            if p.get("done"):
                break
            time.sleep(0.2)
        else:
            raise Unavailable("the browser took too long to pack the tab's text")
        field, size = ("gz", p["gz"]) if p.get("gz") else ("text", meta["length"])
        page = PAGE if field == "gz" else 5000  # raw text may be 3 bytes a character
        parts = [TAB.js(f"window.__gsheets[{json.dumps(key)}].{field}.slice({i}, {i + page})", 30) for i in range(0, size, page)]
        body = "".join(parts)
        if len(body) != size:
            raise Unavailable(f"read {len(body)} of {size} characters back from the tab")
        meta["text"] = gzip.decompress(base64.b64decode(body)).decode("utf-8") if field == "gz" else body
        return meta
    finally:
        try:
            TAB.js(f"(delete (window.__gsheets || {{}})[{json.dumps(key)}], 'ok')", 20)
        except Unavailable:
            pass


# What it's asked for: a sheet, a tab, a range.

ID = re.compile(r"/spreadsheets/(?:u/\d+/)?d/(?:e/)?([A-Za-z0-9_-]{20,})")


def parse_sheet(sheet):
    """A sheet's id and the gid its link names, if any, from its id or any link to it."""
    s = (sheet or "").strip()
    if not s:
        raise ValueError("give sheet: the spreadsheet's id or its link")
    m = ID.search(s)
    if m:
        gid = re.search(r"[#?&]gid=(\d+)", s)
        return m.group(1), gid.group(1) if gid else None
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", s):
        return s, None
    raise ValueError(f"{sheet!r} isn't a spreadsheet's id or link (like https://docs.google.com/spreadsheets/d/<id>/edit)")


A1 = re.compile(r"^\$?([A-Za-z]{0,3})\$?(\d*)(?::\$?([A-Za-z]{0,3})\$?(\d*))?$")


def split_range(rng):
    """'Ad spend'!A1:D20 → ('Ad spend', 'A1:D20'); F60:F70 → (None, 'F60:F70')."""
    if not rng:
        return None, None
    r = rng.strip()
    m = re.fullmatch(r"'((?:[^']|'')+)'!(.+)", r) or re.fullmatch(r"([^!']+)!(.+)", r)
    tab, cells = (m.group(1).replace("''", "'"), m.group(2)) if m else (None, r)
    cells = cells.replace(" ", "").upper()
    a = A1.match(cells)
    if not a or not (a.group(1) or a.group(2)):
        raise ValueError(f"{rng!r} isn't a range in A1 notation, like F60:F70, A:C, 5:10 or 'Ad spend'!A1:D20")
    return tab, cells


def col_number(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def col_letters(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def range_origin(cells):
    """The row and column a range's first cell is in, 1-based: what the first exported row and cell are."""
    if not cells:
        return 1, 1
    a = A1.match(cells)
    return (int(a.group(2)) if a.group(2) else 1), (col_number(a.group(1)) if a.group(1) else 1)


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()


def pick_tab(tabs, want, title):
    """The tab asked for: by its exact name, then ignoring case and spaces, then the one whose name contains it, or by
    its gid. None asked for is the first."""
    if not tabs:
        raise LookupError(f"couldn't find the tabs of {title or 'that spreadsheet'}")
    if want is None or str(want).strip() == "":
        return tabs[0]
    w = str(want).strip()
    gid = re.fullmatch(r"(?:gid=)?(\d+)", w)
    for t in tabs:
        if t["name"] == w or (gid and t["gid"] == gid.group(1)):
            return t
    hits = [t for t in tabs if norm(t["name"]) == norm(w)] or [t for t in tabs if norm(w) in norm(t["name"])]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(f"“{t['name']}”" for t in tabs)
    if hits:
        raise LookupError(f"{title or 'the spreadsheet'} has more than one tab like “{w}”: {', '.join(t['name'] for t in hits)}")
    raise LookupError(f"{title or 'the spreadsheet'} has no tab “{w}”; its tabs are {names}")


def base(sheet_id, account=None):
    q = ("?authuser=" + urllib.parse.quote(account)) if account else ""
    return f"https://docs.google.com/spreadsheets/d/{sheet_id}", q


def explain(meta, sheet_id, account):
    """Why Sheets didn't give the tab, in words."""
    s, url, title = meta.get("status"), meta.get("url") or "", meta.get("title") or ""
    if meta.get("error"):
        return f"the request failed in the browser ({meta['error']})"
    if LOGIN.search(url):
        return "the Chrome it reads through isn't signed in to Google (it landed on Google's sign-in page)"
    if s == 404 or "Page Not Found" in title:
        return f"no spreadsheet has the id {sheet_id}"
    if s in (401, 403) or "access" in (meta.get("snippet") or "").lower():
        who = account or "any of the user's Google accounts signed in to that Chrome"
        return f"{who} can't open spreadsheet {sheet_id}: it isn't shared with {'it' if account else 'them'}"
    return f"Sheets answered {s} ({title or meta.get('type') or 'no text'}): {(meta.get('snippet') or '')[:200]}"


def sheet_info(sheet_id, account=None, fresh=False):
    """The spreadsheet's title and tabs, read from htmlview and kept for a while."""
    key = f"{sheet_id}|{account or ''}"
    known = state["sheets"].get(key)
    if known and not fresh and time.time() - known.get("at", 0) < TABS_TTL_S:
        return known
    b, q = base(sheet_id, account)
    meta = get(f"{b}/htmlview{q}", tabs=True)
    if meta.get("status") != 200 or not meta.get("tabs"):
        raise Refused(explain(meta, sheet_id, account), meta)
    title = html.unescape(re.sub(r"\s+-\s+Google (Drive|Sheets)$", "", meta.get("title") or "")).strip() or None
    u = re.search(r"/spreadsheets/u/(\d+)/", meta.get("url") or "")
    info = {"title": title, "tabs": meta["tabs"], "at": time.time(), "authuser": int(u.group(1)) if u else None}
    with lock:
        state["sheets"][key] = info
        if len(state["sheets"]) > 200:
            for k in sorted(state["sheets"], key=lambda k: state["sheets"][k].get("at", 0))[:50]:
                state["sheets"].pop(k, None)
        save_state()
    return info


def export(sheet_id, gid, cells, account=None):
    b, q = base(sheet_id, account)
    params = {"format": "csv", "gid": gid}
    if cells:
        params["range"] = cells
    if account:
        params["authuser"] = account
    return get(f"{b}/export?" + urllib.parse.urlencode(params))


def blob_of(text, name):
    """The whole CSV as a blob, for a caller to fetch with sb blob get."""
    path = os.path.join(HOME, "tmp", re.sub(r"[^A-Za-z0-9._-]+", "-", name)[:80] or "tab.csv")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    try:
        p = subprocess.run(["sb", "blob", "put", "--type", "text/csv", path], capture_output=True, text=True, timeout=60)
        ref = re.search(r"sha256:[0-9a-f]{64}", p.stdout + p.stderr)
        return ref.group(0) if ref else None
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def to_csv(rows):
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    for r in rows:
        w.writerow(r)
    return out.getvalue()


def matcher(match):
    if not match:
        return None
    m = re.fullmatch(r"/(.+)/([i]*)", match.strip())
    if m:
        rx = re.compile(m.group(1), re.I if "i" in m.group(2) else 0)
    else:  # words, or a few alternatives split by |, in any case
        rx = re.compile("|".join(re.escape(w.strip()) for w in match.split("|") if w.strip()), re.I)
    return lambda row: any(rx.search(c or "") for c in row)


def read(sheet, tab=None, rng=None, fmt="csv", header=1, match=None, offset=0, limit=None, max_chars=DEFAULT_CHARS,
         account=None, fresh=False, ctx=None):
    """The tab, read now, shaped as asked: what the read action answers."""
    sheet_id, link_gid = parse_sheet(sheet)
    range_tab, cells = split_range(rng)
    want = tab if tab not in (None, "") else (range_tab if range_tab else (link_gid if link_gid else None))
    fmt = (fmt or "csv").lower()
    if fmt not in ("csv", "rows", "records"):
        raise ValueError("format is csv, rows or records")
    if ctx:
        ctx.progress("Finding the tab")
    info = sheet_info(sheet_id, account, fresh)
    try:
        t = pick_tab(info["tabs"], want, info["title"])
    except LookupError:
        if fresh or (time.time() - info.get("at", 0) < 60):
            raise
        info = sheet_info(sheet_id, account, fresh=True)  # a tab added or renamed since it last looked
        t = pick_tab(info["tabs"], want, info["title"])
    if ctx:
        ctx.progress(f"Reading “{t['name']}”")
    meta = export(sheet_id, t["gid"], cells, account)
    if meta.get("status") == 400 and not fresh:
        info = sheet_info(sheet_id, account, fresh=True)  # its gid went stale: the tab was deleted and made again
        t = pick_tab(info["tabs"], want, info["title"])
        meta = export(sheet_id, t["gid"], cells, account)
    if meta.get("status") != 200 or "text" not in meta:
        raise Refused(explain(meta, sheet_id, account), meta)
    text = meta["text"]
    grid = list(csv.reader(io.StringIO(text)))
    row0, col0 = range_origin(cells)
    numbered = [(row0 + i, r) for i, r in enumerate(grid)]
    width = max((len(r) for r in grid), default=0)

    head_i = (header - row0) if header and header >= row0 else None
    head = numbered[head_i][1] if head_i is not None and 0 <= head_i < len(numbered) else None
    if fmt == "records" and header and header < row0 and width:
        # a range below the header row: read the header's cells over the same columns, for the records' keys
        hm = export(sheet_id, t["gid"], f"{col_letters(col0)}{header}:{col_letters(col0 + width - 1)}{header}", account)
        if hm.get("status") == 200 and "text" in hm:
            head = (list(csv.reader(io.StringIO(hm["text"]))) or [None])[0]
    body = [(n, r) for i, (n, r) in enumerate(numbered) if i != head_i]
    test = matcher(match)
    if test:
        body = [(n, r) for n, r in body if test(r)]
    total = len(body)
    body = body[max(0, offset or 0):]
    if limit is not None and limit >= 0:
        body = body[:limit]

    link = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={t['gid']}"
    out = {"sheet": {"id": sheet_id, "title": info["title"]}, "tab": t["name"], "gid": t["gid"], "link": link,
           "range": f"{col_letters(col0)}{row0}:{col_letters(col0 + max(width, 1) - 1)}{row0 + max(len(grid), 1) - 1}" if grid else None,
           "columns": width, "rows": len(grid), "matched" if test else "data_rows": total}
    if head is not None:
        out["header"] = head
    cap = max(1000, min(int(max_chars or DEFAULT_CHARS), MAX_CHARS))

    def shape(part):
        if fmt == "csv":
            rows = ([head] if head is not None else []) + [r for _, r in part]
            return to_csv(rows)
        if fmt == "rows":
            return [{"row": n, "cells": r} for n, r in part]
        keys, seen = [], set()
        for i in range(width):
            k = (head[i].strip() if head and i < len(head) and head[i].strip() else col_letters(col0 + i))
            while k in seen:
                k += "_"
            seen.add(k)
            keys.append(k)
        return [{"_row": n, **{keys[i]: (r[i] if i < len(r) else "") for i in range(width)}} for n, r in part]

    shown = body
    data = shape(shown)
    if len(json.dumps(data, ensure_ascii=False)) > cap:
        lo, hi = 0, len(body)
        while lo < hi:  # the most rows that fit
            mid = (lo + hi + 1) // 2
            if len(json.dumps(shape(body[:mid]), ensure_ascii=False)) <= cap:
                lo = mid
            else:
                hi = mid - 1
        shown = body[:lo]
        data = shape(shown)
        out["truncated"] = True
        out["blob"] = blob_of(to_csv(grid), f"{info['title'] or sheet_id}-{t['name']}.csv")
        rest = len(body) - len(shown)
        out["note"] = (f"{rest} more row{'s' if rest != 1 else ''} didn't fit in max_chars {cap}: page on with offset "
                       f"{(offset or 0) + len(shown)}, narrow with range or match, or take the whole tab as CSV from "
                       f"its blob (sb blob get {out['blob']} -o tab.csv)" if out["blob"] else
                       f"{rest} more rows didn't fit: page on with offset {(offset or 0) + len(shown)}")
    if shown:
        out["shown"] = {"from_row": shown[0][0], "to_row": shown[-1][0], "count": len(shown)}
    out[fmt if fmt != "csv" else "csv"] = data
    return out


def prop(kind, text, **more):
    return {"type": kind, "description": text, **more}


SHEET = prop("string", "The spreadsheet's id, or any link to it (a link's #gid= picks its tab when tab isn't given).")
ACCOUNT = prop("string", "Read as this Google account (me@example.com, me@example.com...), when Docs picks the "
               "wrong one. Default: whichever signed-in account can open it.")
FRESH = prop("boolean", "Read the tab names again rather than from the last 6 hours.")

READ_SCHEMA = {"type": "object", "required": ["sheet"], "properties": {
    "sheet": SHEET,
    "tab": prop("string", "The tab's name (case and spacing don't matter; a unique part of it will do), or its gid. "
                "Default: the link's tab, else the first."),
    "range": prop("string", "Only these cells, in A1 notation: F60:F70, A:C, 5:10, or with its tab, 'Ad spend'!A1:D20."),
    "format": prop("string", "csv (default), rows ([{row, cells}], each with its row number in the sheet) or records "
                   "([{_row, <header>: value}], keyed by the header row).", enum=["csv", "rows", "records"]),
    "header": prop("integer", "The header row's number in the sheet (default 1; 0 for none). It leads the CSV and keys "
                   "the records, and match, offset and limit leave it out."),
    "match": prop("string", "Only rows with a cell containing these words (any case; a|b for either), or a /regex/."),
    "offset": prop("integer", "Skip this many rows (after the header) first."),
    "limit": prop("integer", "At most this many rows."),
    "max_chars": prop("integer", "Most characters of cells to answer (default 20000, at most 200000); past it, as many "
                      "rows as fit, how to page on, and the whole tab's CSV as a blob."),
    "account": ACCOUNT,
    "fresh": FRESH,
}}


@app.tool(read_only=True, name="read", schema=READ_SCHEMA, description=(
    "A tab of any of the user's Google Sheets, read now, its cells exactly as the sheet shows them (formulas as their "
    "values), by the sheet's id or link and the tab's name: as CSV (default), rows (each with its row number in the "
    "sheet) or records (keyed by the header row), with a range, rows matching words, and paging. Answers the "
    "spreadsheet's title, the tab, its link, how many rows and columns, and the cells; past max_chars, as many rows "
    "as fit, how to page on, and the whole tab's CSV as a blob. Through the Mac mini's Chrome, signed in to all of "
    "The user's Google accounts: any sheet one of them can open."))
def read_tool(sheet, tab=None, range=None, format="csv", header=1, match=None, offset=0, limit=None,
              max_chars=DEFAULT_CHARS, account=None, fresh=False, ctx=None):
    status_["reads"] += 1
    try:
        out = read(sheet, tab, range, format, header, match, offset, limit, max_chars, account, fresh, ctx)
        status_["ok_n"] = next(order)
        status_["last_read"] = {"at": int(time.time() * 1000), "sheet": out["sheet"]["title"], "tab": out["tab"],
                                "rows": out["rows"], "browser": status_["browser"]}
        return out
    except Exception as e:
        failed(e, "read")
        if isinstance(e, Unavailable):
            raise RuntimeError(f"couldn't reach a Mac's Chrome to read the sheet: {e}") from None
        raise


@app.tool(read_only=True, name="tabs", schema={"type": "object", "required": ["sheet"], "properties": {
    "sheet": SHEET, "account": ACCOUNT, "fresh": FRESH}},
    description="A spreadsheet's title and its tabs, in order: each one's name, gid and link.")
def tabs(sheet, account=None, fresh=False):
    sheet_id, _ = parse_sheet(sheet)
    try:
        info = sheet_info(sheet_id, account, fresh)
    except Exception as e:
        failed(e, "tabs")
        if isinstance(e, Unavailable):
            raise RuntimeError(f"couldn't reach a Mac's Chrome to read the sheet: {e}") from None
        raise
    status_["ok_n"] = next(order)
    return {"sheet": {"id": sheet_id, "title": info["title"]},
            "tabs": [{"name": t["name"], "gid": t["gid"],
                      "link": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={t['gid']}"} for t in info["tabs"]]}


# Writing: Google's Sheets API, as a connected account. The browser's sign-ins can't call it, so each account grants
# the spreadsheets scope once (connect, then finish from the core's callback); its refresh token stays in secrets.json.

INSTANCE = os.environ.get("SB_INSTANCE", f"{NAME}@dev")
KEYCHAIN = "switchboard-google-sheets"
SCOPE = "https://www.googleapis.com/auth/spreadsheets"
SCOPES = [SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"]
"""Sheets, and who the account is (its address comes back in the consent's id_token)."""
API = os.environ.get("SHEETS_API", "https://sheets.googleapis.com/v4/spreadsheets")
USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
CHECK_EVERY_S = 6 * 3600
"""How often each connected account's token is tried, so one Google revoked shows before a write needs it."""
SHOWN_CELLS = 100
"""The most cells a write answers before and after for (the record keeps the first 40)."""
NOT_CONNECTED = ("no Google account is connected for writing yet: connect gives the consent link, which the user opens "
                 "once (any browser, his phone's too) to let Switchboard edit the sheets that account can edit")

google = Google(INSTANCE, HOME, KEYCHAIN, SCOPES)


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status, self.body = status, body

    @property
    def message(self):
        try:
            return json.loads(self.body)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            return self.body[:300]


RETRY = {429, 500, 502, 503, 504}


def api(method, url, token, body=None, params=None, timeout=60):
    """The world outside for writes, in one place: one call of Google's API, tried again on its passing failures (rate
    limits, 5xx, a dropped connection). Its tests put a fake here."""
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    head = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        head["Content-Type"] = "application/json; charset=UTF-8"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=head, method=method), timeout=timeout) as res:
                got = res.read()
                return json.loads(got) if got else {}
        except urllib.error.HTTPError as e:
            err = ApiError(e.code, e.read().decode(errors="replace"))
            if e.code not in RETRY or attempt == 4:
                raise err from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, httpclient.HTTPException) as e:
            if attempt == 4:
                raise RuntimeError(f"couldn't reach Google ({e})") from None
        time.sleep(min(2 ** attempt, 20))


def slug(address):
    """An account's key in entity ids: me@example.com is me-example-com."""
    return re.sub(r"[^a-z0-9]+", "-", address.lower()).strip("-")


class Account:
    def __init__(self, address):
        self.address, self.key = address, slug(address)
        self.entity = f"sheets-account:{self.key}"
        self.access_token, self.expires_at = None, 0
        self.connected, self.error = True, None
        self.reported, self.checked_at = None, 0

    def token(self):
        if self.access_token and time.time() < self.expires_at - 120:
            return self.access_token
        try:
            self.access_token, lasts = google.access(self.address)
        except Disconnected as e:
            self.connected, self.error = False, str(e)
            report(self)
            raise RuntimeError(f"{self.address} isn't connected for writing anymore ({e}): connect gives the link to "
                               "connect it again") from None
        self.expires_at = time.time() + lasts
        if not self.connected:
            self.connected, self.error = True, None
            report(self)
        return self.access_token

    def call(self, method, path, body=None, **params):
        return api(method, f"{API}/{path}", self.token(), body, params)


accounts = {}
"""Accounts connected for writing, by address: every one with a refresh token here."""


def load_accounts():
    with lock:
        for a in sorted(google.stored()):
            accounts.setdefault(a, Account(a))


def report(acct, force=False):
    """The account's own observation, recorded when it changes."""
    facts = {"address": acct.address, "connected": acct.connected, "error": acct.error, "scope": "spreadsheets"}
    if facts == acct.reported and not force:
        return
    acct.reported = facts
    summary = (f"{acct.address}: connected, so I can edit the Google Sheets it can edit" if acct.connected else
               f"{acct.address}: no longer connected for editing Sheets ({acct.error})")
    app.emit("account", {"entity": acct.entity, "summary": summary,
                         "facts": {**facts, "checked_at": int(time.time() * 1000)}}, about=[acct.entity])


def check_accounts(now=False, force=False):
    """Tries each account's token now and then (now: at once), so one Google revoked is recorded as such; force records
    each again even if nothing changed (at start)."""
    for acct in list(accounts.values()):
        if now or force or time.time() - acct.checked_at > CHECK_EVERY_S:
            acct.checked_at = time.time()
            try:
                acct.access_token = None
                acct.token()
            except RuntimeError:
                continue  # token() recorded it
            except Exception as e:
                log(f"{acct.address}: {e}")
                continue
            report(acct, force=force)


def find_account(address):
    a = (address or "").strip().lower()
    with lock:
        for acct in accounts.values():
            if a in (acct.address.lower(), acct.key):
                return acct
    raise LookupError(f"{address} isn't connected for writing (connected: {', '.join(sorted(accounts)) or 'none'}); "
                      "connect gives the link to connect it")


def quote_tab(name):
    return "'" + name.replace("'", "''") + "'"


def path_range(sheet_id, a1):
    return f"{sheet_id}/values/{urllib.parse.quote(a1, safe='')}"


def open_sheet(sheet_id, account=None, skip=()):
    """The spreadsheet's title and tabs (with their size), and the connected account that opens it: the one named, else
    the one that wrote it last, else each in turn (but those in skip, which opened it and couldn't edit it)."""
    if account:
        order = [find_account(account)]
    else:
        with lock:
            if not accounts:
                raise LookupError(NOT_CONNECTED)
            last = state.get("writers", {}).get(sheet_id)
            order = sorted((a for a in accounts.values() if a.address not in skip), key=lambda x: (x.address != last, x.address))
        if not order:
            raise PermissionError(f"{' and '.join(skip)} can open spreadsheet {sheet_id} but not edit it: share it with "
                                  "edit access, or connect an account that can edit it (connect)")
    tried = []
    for acct in order:
        try:
            meta = acct.call("GET", sheet_id, fields="properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))")
        except ApiError as e:
            if e.status == 404 and not tried and len(order) == 1:
                raise LookupError(f"no spreadsheet has the id {sheet_id}") from None
            if e.status in (403, 404):
                tried.append((acct.address, e.status))
                continue
            raise LookupError(f"Sheets answered {e.status} for {acct.address}: {e.message}") from None
        tabs = [{"name": t["properties"]["title"], "gid": str(t["properties"].get("sheetId", 0)),
                 "rows": t["properties"].get("gridProperties", {}).get("rowCount", 1000),
                 "columns": t["properties"].get("gridProperties", {}).get("columnCount", 26)} for t in meta.get("sheets", [])]
        return acct, {"title": meta.get("properties", {}).get("title"), "tabs": tabs}
    if skip and not tried:
        raise PermissionError(f"{' and '.join(skip)} can open spreadsheet {sheet_id} but not edit it: share it with edit "
                              "access, or connect an account that can edit it (connect)")
    if all(s == 404 for _, s in tried):
        raise LookupError(f"no spreadsheet has the id {sheet_id}, or none of {', '.join(a for a, _ in tried)} can see it")
    raise LookupError(f"{' and '.join(a for a, _ in tried)} can't open spreadsheet {sheet_id}: connect the account that owns "
                      "it (connect), or share it with one that's connected")


def with_editor(sheet_id, account, do):
    """do(account, info) as the first account that opens the sheet, and as the next one when Google refuses that one
    the edit itself (it can view the sheet but not edit it): nothing is written before that refusal."""
    skip = []
    while True:
        acct, info = open_sheet(sheet_id, account, skip)
        try:
            out = do(acct, info)
        except ApiError as e:
            if e.status != 403 or account:
                raise
            skip.append(acct.address)
            continue
        with lock:
            writers = state.setdefault("writers", {})
            writers.pop(sheet_id, None)
            writers[sheet_id] = acct.address
            while len(writers) > 200:
                writers.pop(next(iter(writers)))
            save_state()
        return out


def which_tab(info, want, verb):
    """The tab a write goes to: one must be named when the spreadsheet has several, so nothing lands in the first by
    default."""
    if (want is None or str(want).strip() == "") and len(info["tabs"]) > 1:
        names = ", ".join(f"“{t['name']}”" for t in info["tabs"])
        raise ValueError(f"say which tab to {verb} ({info['title']} has {names}): tab, or a range like 'Ad spend'!B2")
    return pick_tab(info["tabs"], want, info["title"])


CELL = re.compile(r"^([A-Z]{1,3})(\d+)$")


def cell_bounds(cells):
    """A write's range as its first cell's column and row and, when it's a whole range, its last's (None when only the
    first cell is given: the values say how far it goes)."""
    first, _, last = cells.replace("$", "").partition(":")
    a = CELL.match(first)
    if not a:
        raise ValueError(f"a write starts at one cell, like F66 or F66:F70, not {cells} (whole columns and rows aren't written)")
    c1, r1 = col_number(a.group(1)), int(a.group(2))
    if not last:
        return c1, r1, None, None
    b = CELL.match(last)
    if not b:
        raise ValueError(f"{cells} must end at one cell, like F70")
    c2, r2 = col_number(b.group(1)), int(b.group(2))
    if c2 < c1 or r2 < r1 or r1 < 1:
        raise ValueError(f"{cells}: a range goes from its top left cell to its bottom right one")
    return c1, r1, c2, r2


SCALAR = (str, int, float, bool, type(None))


def grid_of(values, bounds, what="values"):
    """values as rows of cells: a list of rows, one row or column as a list (a column when the range is one column), or
    one value (for one cell, or every cell of the range given). None leaves a cell as it is; "" empties it."""
    c1, r1, c2, r2 = bounds
    if isinstance(values, SCALAR):
        h, w = ((r2 - r1 + 1), (c2 - c1 + 1)) if c2 is not None else (1, 1)
        grid = [[values] * w for _ in range(h)]
    elif isinstance(values, list) and values and all(isinstance(r, list) for r in values):
        grid = values
    elif isinstance(values, list) and values and all(isinstance(v, SCALAR) for v in values):
        grid = [[v] for v in values] if c2 is not None and c1 == c2 and r2 > r1 else [list(values)]
    else:
        raise ValueError(f"{what} is a list of rows (each a list of cells), one row or column as a list, or one value")
    for row in grid:
        for v in row:
            if not isinstance(v, SCALAR) or (isinstance(v, float) and v != v):
                raise ValueError(f"{what}' cells are text, numbers, true/false or null (to leave a cell as it is), not {v!r}")
    height, width = len(grid), max(len(r) for r in grid)
    if not width:
        raise ValueError(f"{what} has no cells")
    if c2 is not None and (height, width) != (r2 - r1 + 1, c2 - c1 + 1):
        raise ValueError(f"the range is {r2 - r1 + 1} row{'s' if r2 != r1 else ''} by {c2 - c1 + 1} column{'s' if c2 != c1 else ''}, "
                         f"but {what} {'are' if height * width > 1 else 'is'} {height} by {width}")
    return grid, (c1, r1, c1 + width - 1, r1 + height - 1)


def cells_now(acct, sheet_id, a1):
    """What each cell of a range shows now, and its formula if it holds one: {(row, column): (shown, formula)}."""
    got = acct.call("GET", sheet_id, ranges=a1, includeGridData="true",
                    fields="sheets(data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue))))")
    out = {}
    for s in got.get("sheets", []):
        for d in s.get("data", []):
            r0, c0 = d.get("startRow", 0), d.get("startColumn", 0)
            for i, row in enumerate(d.get("rowData", [])):
                for j, v in enumerate(row.get("values", [])):
                    out[(r0 + i + 1, c0 + j + 1)] = (v.get("formattedValue", ""), (v.get("userEnteredValue") or {}).get("formulaValue"))
    return out


def as_text(v):
    return "" if v is None else ("TRUE" if v is True else "FALSE" if v is False else str(v))


def input_option(value):
    v = (value or "user").lower()
    if v not in ("user", "raw"):
        raise ValueError("input is user (as if typed: =formulas, numbers, dates and $ amounts are understood) or raw (stored as given)")
    return "USER_ENTERED" if v == "user" else "RAW"


def grow(acct, sheet_id, t, rows, columns):
    """Adds rows or columns to a tab that's too small for a write, as Sheets needs before it takes one there."""
    asks = [{"appendDimension": {"sheetId": int(t["gid"]), "dimension": d, "length": n}}
            for d, n in (("ROWS", rows - t["rows"]), ("COLUMNS", columns - t["columns"])) if n > 0]
    if asks:
        acct.call("POST", f"{sheet_id}:batchUpdate", {"requests": asks})


def recorded(info, sheet_id, t, acct, what, cells):
    """Keeps a write in the brain: where, as whom, and each cell's before and after."""
    try:
        app.emit("write", {"entity": f"google-sheet:{sheet_id}", "summary": what,
                           "facts": {"title": info["title"], "tab": t["name"], "account": acct.address,
                                     "link": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={t['gid']}",
                                     "cells": cells[:40], "at": int(time.time() * 1000)}}, about=[f"google-sheet:{sheet_id}"])
    except Exception as e:
        log(f"couldn't record the write: {e}")


def write(sheet, rng, values, tab=None, input="user", expect=None, over_formulas=False, account=None, dry_run=False, ctx=None):
    sheet_id, link_gid = parse_sheet(sheet)
    range_tab, cells = split_range(rng)
    if not cells:
        raise ValueError("give range: where to write, like F66, F66:F70 or 'Ad spend'!B2")
    grid, (c1, r1, c2, r2) = grid_of(values, cell_bounds(cells))
    if not any(v is not None for row in grid for v in row):
        raise ValueError("every value is null, so there's nothing to write")
    option = input_option(input)
    if ctx:
        ctx.progress("Opening the spreadsheet")

    def go(acct, info):
        t = which_tab(info, tab if tab not in (None, "") else (range_tab or link_gid), "write in")
        span = f"{col_letters(c1)}{r1}" + (f":{col_letters(c2)}{r2}" if (c1, r1) != (c2, r2) else "")
        a1 = f"{quote_tab(t['name'])}!{col_letters(c1)}{r1}:{col_letters(c2)}{r2}"
        now = cells_now(acct, sheet_id, a1) if r1 <= t["rows"] and c1 <= t["columns"] else {}
        given = [((r1 + i, c1 + j), v) for i, row in enumerate(grid) for j, v in enumerate(row) if v is not None]
        if not given:
            raise ValueError("every value is null, so there's nothing to write")

        def name(rc):
            return f"{col_letters(rc[1])}{rc[0]}"

        formulas = [(rc, now[rc][1]) for rc, v in given if rc in now and now[rc][1] and as_text(v) != now[rc][1]]
        if formulas and not over_formulas:
            listed = ", ".join(f"{name(rc)} ({f[:60]})" for rc, f in formulas[:8])
            raise ValueError(f"{len(formulas)} of those cells hold{'s' if len(formulas) == 1 else ''} a formula, so nothing was "
                             f"written: {listed}{'…' if len(formulas) > 8 else ''}. over_formulas: true writes over them")
        if expect is not None:
            eg, _ = grid_of(expect, (c1, r1, c2, r2), "expect")
            wrong = [(rc, as_text(e), now.get(rc, ("", None))[0]) for rc, e in
                     (((r1 + i, c1 + j), e) for i, row in enumerate(eg) for j, e in enumerate(row)) if e is not None
                     and as_text(e) != now.get(rc, ("", None))[0]]
            if wrong:
                listed = "; ".join(f"{name(rc)} shows “{shows}”, not “{want}”" for rc, want, shows in wrong[:8])
                raise ValueError(f"the cells don't show what expect says, so nothing was written: {listed}"
                                 f"{'…' if len(wrong) > 8 else ''}")
        before = {rc: now.get(rc, ("", None)) for rc, _ in given}
        where = f"“{t['name']}” {span} in {info['title']}"
        out = {"sheet": {"id": sheet_id, "title": info["title"]}, "tab": t["name"], "range": span, "account": acct.address,
               "link": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={t['gid']}&range={span}"}
        if dry_run:
            cells_ = [{"cell": name(rc), "before": before[rc][0], **({"formula": before[rc][1]} if before[rc][1] else {}),
                       "value": v} for rc, v in given]
            return {**out, "dry_run": True, "would_write": len(given), "cells": cells_[:SHOWN_CELLS],
                    "summary": f"Would write {len(given)} cell{'s' if len(given) != 1 else ''} of {where} as {acct.address}; nothing written."}
        if ctx:
            ctx.progress(f"Writing {span} of “{t['name']}”")
        grow(acct, sheet_id, t, r2, c2)
        res = acct.call("PUT", path_range(sheet_id, a1), {"range": a1, "majorDimension": "ROWS", "values": grid},
                        valueInputOption=option, includeValuesInResponse="true", responseValueRenderOption="FORMATTED_VALUE")
        shown = (res.get("updatedData") or {}).get("values") or []
        cells_ = []
        for rc, v in given:
            i, j = rc[0] - r1, rc[1] - c1
            after = shown[i][j] if i < len(shown) and j < len(shown[i]) else ""
            cell = {"cell": name(rc), "before": before[rc][0], "after": after}
            if before[rc][1]:
                cell["formula_before"] = before[rc][1]
            if isinstance(v, str) and v.startswith("=") and option == "USER_ENTERED":
                cell["formula"] = v
            cells_.append(cell)
        changed = [c for c in cells_ if c["before"] != c["after"] or c.get("formula_before") or c.get("formula")]
        summary = (f"Wrote {len(given)} cell{'s' if len(given) != 1 else ''} of {where} as {acct.address}: "
                   f"{len(changed)} changed" if changed else
                   f"Wrote {len(given)} cell{'s' if len(given) != 1 else ''} of {where} as {acct.address}: they already showed that")
        recorded(info, sheet_id, t, acct, summary, changed or cells_)
        status_["last_write"] = {"at": int(time.time() * 1000), "sheet": info["title"], "tab": t["name"], "range": span,
                                 "cells": len(given), "changed": len(changed), "account": acct.address}
        return {**out, "written": len(given), "changed": len(changed), "cells": cells_[:SHOWN_CELLS],
                **({"more": len(cells_) - SHOWN_CELLS} if len(cells_) > SHOWN_CELLS else {}), "summary": summary}

    return with_editor(sheet_id, account, go)


def append(sheet, rows, tab=None, header=1, input="user", account=None, dry_run=False, ctx=None):
    sheet_id, link_gid = parse_sheet(sheet)
    option = input_option(input)
    if not isinstance(rows, list) or not rows:
        raise ValueError("rows is a list of rows: each a list of cells in column order from A, or an object keyed by the header's names")
    if ctx:
        ctx.progress("Opening the spreadsheet")

    def go(acct, info):
        t = which_tab(info, tab if tab not in (None, "") else link_gid, "append to")
        q = quote_tab(t["name"])
        have = acct.call("GET", path_range(sheet_id, q), valueRenderOption="FORMATTED_VALUE", majorDimension="ROWS").get("values") or []
        if all(isinstance(r, dict) for r in rows):
            head = have[header - 1] if header and len(have) >= header else None
            if not head or not any(h.strip() for h in head):
                raise ValueError(f"“{t['name']}” has no header in row {header or 0} to match the rows' names against: give the rows as lists, or header")
            index = {}
            for i, h in enumerate(head):
                index.setdefault(norm(h), i)
            grid = []
            for n, r in enumerate(rows, 1):
                unknown = [k for k in r if norm(k) not in index]
                if unknown:
                    raise ValueError(f"row {n} names {', '.join(map(repr, unknown))}, which “{t['name']}”'s header doesn't have; "
                                     f"its columns are {', '.join(h for h in head if h.strip())}")
                cells = [None] * (max(index[norm(k)] for k in r) + 1) if r else []
                for k, v in r.items():
                    cells[index[norm(k)]] = v
                grid.append(cells)
        elif all(isinstance(r, list) for r in rows):
            grid = rows
        else:
            raise ValueError("rows are all lists of cells, or all objects keyed by the header's names")
        grid, _ = grid_of(grid, (1, 1, None, None), "rows")
        if not any(v is not None for r in grid for v in r):
            raise ValueError("every cell of the rows is empty")
        start = max(len(have), header or 0) + 1
        end, width = start + len(grid) - 1, max(len(r) for r in grid)
        span = f"A{start}:{col_letters(width)}{end}"
        out = {"sheet": {"id": sheet_id, "title": info["title"]}, "tab": t["name"], "range": span, "account": acct.address,
               "link": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid={t['gid']}&range={span}"}
        where = f"“{t['name']}” in {info['title']}"
        if dry_run:
            return {**out, "dry_run": True, "rows": [{"row": start + i, "cells": [as_text(v) if v is not None else None for v in r]}
                                                     for i, r in enumerate(grid)],
                    "summary": f"Would add {len(grid)} row{'s' if len(grid) != 1 else ''} to {where} at {span}, after its last "
                               f"row ({start - 1}), as {acct.address}; nothing written."}
        a1 = f"{q}!{span}"
        if end <= t["rows"] and width <= t["columns"]:
            landed = acct.call("GET", path_range(sheet_id, a1), valueRenderOption="FORMATTED_VALUE").get("values") or []
            if any(any(c != "" for c in r) for r in landed):
                raise RuntimeError(f"rows {start}-{end} of “{t['name']}” filled up while I was adding to it, so nothing was written: try again")
        if ctx:
            ctx.progress(f"Adding {len(grid)} rows to “{t['name']}”")
        grow(acct, sheet_id, t, end, width)
        res = acct.call("PUT", path_range(sheet_id, a1), {"range": a1, "majorDimension": "ROWS", "values": grid},
                        valueInputOption=option, includeValuesInResponse="true", responseValueRenderOption="FORMATTED_VALUE")
        shown = (res.get("updatedData") or {}).get("values") or []
        written = [{"row": start + i, "cells": shown[i] if i < len(shown) else []} for i in range(len(grid))]
        summary = f"Added {len(grid)} row{'s' if len(grid) != 1 else ''} to {where} at {span} as {acct.address}"
        recorded(info, sheet_id, t, acct, summary, [{"row": w["row"], "after": w["cells"]} for w in written])
        status_["last_write"] = {"at": int(time.time() * 1000), "sheet": info["title"], "tab": t["name"], "range": span,
                                 "rows": len(grid), "account": acct.address}
        return {**out, "appended": len(grid), "rows": written, "summary": summary}

    return with_editor(sheet_id, account, go)


def connect(address=None):
    url = google.consent_url(address)
    opens = OPENS if SWITCH else "Opens in any browser, a phone's included: Google comes back to Switchboard's own callback, which finishes it."
    out = {"url": url, "note": (
        opens + " "
        "It asks to see and edit the account's Google Sheets (and its email address, to know which account it is). "
        "Google shows its unverified-app warning first: Advanced, then Go to switchboard.")}
    if address:
        out["resolve_when"] = f'entities | where id == "sheets-account:{slug(address)}" and facts.connected == true'
    return out


def email_of(t):
    """Whose account a consent was: its id_token's email (straight from Google's token endpoint), else userinfo's."""
    try:
        part = t["id_token"].split(".")[1]
        email = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email")
        if email:
            return email
    except (KeyError, IndexError, ValueError):
        pass
    return api("GET", USERINFO, t["access_token"])["email"]


def finish(code=None, state=None, redirect_uri=None):
    t = google.finish({"code": code, "state": state, "redirect_uri": redirect_uri},
                      "Sheets access wasn't granted: start again from Switchboard and tick “See, edit, create and delete "
                      "all your Google Sheets spreadsheets”.")
    address = email_of(t)
    google.keep(address, t)
    with lock:
        acct = accounts.get(address) or Account(address)
        acct.access_token, acct.expires_at = t["access_token"], time.time() + t.get("expires_in", 3600)
        acct.connected, acct.error, acct.checked_at = True, None, time.time()
        accounts[address] = acct
    report(acct, force=True)
    return {"address": address, "connected": True,
            "note": "I can edit the Google Sheets this account can edit now, and I say what I changed each time. You can close this tab."}


VALUES = {"description": "What to write: a list of rows (each a list of cells), one row or column as a list (a column "
          "when range is one column), or one value (for one cell, or every cell of a whole range). A cell is text, a "
          "number, true/false, or null to leave it as it is; \"\" empties it."}
INPUT = prop("string", "user (default: as if typed, so =formulas, numbers, dates and $25.23 are understood, as the sheet "
             "formats them) or raw (stored exactly as given).", enum=["user", "raw"])
WRITE_ACCOUNT = prop("string", "Write as this connected account (accounts lists them). Default: the one that wrote this "
                     "sheet last, else whichever can open it.")
SPEAKS = (" Writing a sheet someone else owns or shares with the user changes it for them too: only with his say.")


@app.tool(name="write", destructive=True, idempotent=True, schema={"type": "object", "required": ["sheet", "range", "values"], "properties": {
    "sheet": SHEET,
    "range": prop("string", "Where: one cell where the values start (F66), or the whole range they fill (F66:F70), "
                  "with its tab if tab isn't given ('Ad spend'!B2)."),
    "values": VALUES,
    "tab": prop("string", "The tab's name (or gid). Needed when the spreadsheet has more than one and range doesn't say."),
    "input": INPUT,
    "expect": {"description": "What the cells must show now, shaped like values (null for any): if one doesn't, "
               "nothing is written. For changing a value only if it's still what you read."},
    "over_formulas": prop("boolean", "Write over cells that hold formulas (default false: refuses, naming them)."),
    "dry_run": prop("boolean", "Say what each cell shows now and what would go in it; write nothing."),
    "account": WRITE_ACCOUNT}}, description=(
    "Set cells of one of the user's Google Sheets: a range's values, written as if typed (or raw), then read back. Refuses "
    "to write over a formula unless over_formulas, and over cells that don't show what expect says. Answers each "
    "cell's before and after (what the sheet shows), how many changed, and a link to the range; records it in "
    "sheets/writes. Through Google's Sheets API as a connected account (connect to add one)." + SPEAKS))
def write_tool(sheet, range, values=None, tab=None, input="user", expect=None, over_formulas=False, dry_run=False,
               account=None, ctx=None):
    status_["writes"] += 0 if dry_run else 1
    try:
        return write(sheet, range, values, tab, input, expect, over_formulas, account, dry_run, ctx)
    except ApiError as e:
        failed(e, "write")
        if e.status == 403:
            raise RuntimeError(f"Google refused the write ({e.message}): the account can open the sheet but not edit it, "
                               "or the sheet's range is protected") from None
        raise RuntimeError(f"Sheets answered {e.status}: {e.message}") from None
    except Exception as e:
        failed(e, "write")
        raise


@app.tool(name="append", destructive=True, schema={"type": "object", "required": ["sheet", "rows"], "properties": {
    "sheet": SHEET,
    "rows": {"type": "array", "description": "The rows to add, in order: each a list of cells from column A, or an "
             "object keyed by the header row's names (any case; columns it leaves out stay empty). A cell is text, a "
             "number, true/false or null.", "items": {}},
    "tab": prop("string", "The tab's name (or gid). Needed when the spreadsheet has more than one."),
    "header": prop("integer", "The header row's number, which objects' names are matched against (default 1; 0 for none)."),
    "input": INPUT,
    "dry_run": prop("boolean", "Say which rows they'd land on; write nothing."),
    "account": WRITE_ACCOUNT}}, description=(
    "Add rows to a tab of one of the user's Google Sheets, right after its last row with anything in it: by position, or "
    "by its header's column names. Answers the rows they landed on and what the sheet shows in them; records it in "
    "sheets/writes. Through Google's Sheets API as a connected account (connect to add one)." + SPEAKS))
def append_tool(sheet, rows=None, tab=None, header=1, input="user", dry_run=False, account=None, ctx=None):
    status_["writes"] += 0 if dry_run else 1
    try:
        return append(sheet, rows, tab, header, input, account, dry_run, ctx)
    except ApiError as e:
        failed(e, "append")
        if e.status == 403:
            raise RuntimeError(f"Google refused the write ({e.message}): the account can open the sheet but not edit it, "
                               "or the tab is protected") from None
        raise RuntimeError(f"Sheets answered {e.status}: {e.message}") from None
    except Exception as e:
        failed(e, "append")
        raise


@app.tool(read_only=True, name="accounts", schema={"type": "object", "properties": {}},
          description="The Google accounts connected for writing, and whether each still works.")
def list_accounts():
    check_accounts(now=True)
    return [{"address": a.address, "connected": a.connected, "error": a.error} for a in accounts.values()]


app.tool(connect, name="connect", schema={"type": "object", "properties": {
    "address": prop("string", "The account to suggest on Google's chooser, like me@example.com.")}}, description=(
    "Start connecting a Google account for writing its Sheets (scope spreadsheets): returns the consent URL, with "
    "resolve_when on sheets-account:<account with non-alphanumerics as hyphens, like me-example-com> having facts.connected == true "
    "(returned as resolve_when when address is given). "
    + (CONNECT if SWITCH else "Google sends the browser back to Switchboard's own callback, which finishes it.")
    + " Reading needs none of this."))
app.tool(finish, name="finish", description="Finish a consent with the code Google sent back. The core's OAuth callback calls this.",
         schema={"type": "object", "properties": {"code": {"type": "string"}, "state": {"type": "string"},
                                                  "redirect_uri": {"type": "string"}}, "required": ["code", "state"]})


@app.tool(read_only=True)
def status():
    "How google-sheets itself is: what's failing now (null when nothing is), the reads and writes it answered and failed, its last read, write and error, its last failed calls (status and the start of what came back), the browser it reads through, the accounts it writes as, and the sheets whose tabs it knows."
    return {**status_, "failing": failing(), "recent_failures": recent_failures(), "browsers": BROWSERS, "tab_open": bool(TAB.target),
            "writers": [{"address": a.address, "connected": a.connected, "error": a.error} for a in accounts.values()],
            "sheets_known": [{"id": k.split("|")[0], "title": v.get("title"), "tabs": len(v.get("tabs") or []),
                              **({"account": k.split("|", 1)[1]} if k.split("|", 1)[1] else {})}
                             for k, v in list(state["sheets"].items())[-20:]]}


PROBE = "https://docs.google.com/spreadsheets/u/0/"
"""Sheets' own home: what the heartbeat opens, after a read couldn't, to see whether the Chrome it reads through can
reach Sheets signed in again (none of the user's sheets is read)."""


def unsolved():
    """Reading's last problem (no Mac's Chrome answered, or it's signed out of Google) when no read or probe has worked
    since, else None."""
    if status_["last_problem"] and status_.get("problem_n", 0) > status_.get("ok_n", 0):
        return status_["last_problem"]
    return None


def probe():
    meta = get(PROBE)
    if LOGIN.search(meta.get("url") or ""):
        raise Refused(explain(meta, None, None), meta)
    if meta.get("error") or meta.get("status") != 200:
        raise Unavailable(f"Sheets' home answered {meta.get('status')} in the tab ({meta.get('error') or meta.get('title')})",
                          body=meta.get("snippet"))


def failing():
    """What's wrong with reaching Sheets now, or None: reading's unsolved problem, and each account Google no longer lets
    write. A caller's miss (a sheet not shared, a tab that isn't there, a protected range) is no failing of its own."""
    wrong = [f"can't read sheets: {p}" for p in [unsolved()] if p]
    wrong += [f"{a.address} can't write anymore: {a.error}" for a in list(accounts.values()) if not a.connected]
    return "; ".join(wrong) or None


def heartbeat(look=True):
    """Says how it is, in vitals/google-sheets: what keeps its --health-every promise. A problem no read has cleared
    since is looked at again first (look), so it says failing only while Sheets is still out of reach."""
    if look and unsolved():
        try:
            probe()
            status_["ok_n"] = next(order)
        except Exception as e:
            failed(e, "probe")
    wrong, lr = failing(), status_["last_read"]
    summary = (f"Can't reach Sheets: {wrong}" if wrong else
               f"Ready; last read “{lr['tab']}” of {lr['sheet']} ({lr['rows']} rows)" if lr else "Ready")
    facts = {k: status_[k] for k in ("started_at", "reads", "writes", "failed", "last_error", "last_error_at", "last_problem",
                                     "last_problem_at", "browser")}
    facts["failing"] = wrong
    facts["writers"] = {a.address: a.connected for a in accounts.values()}
    status_["said_failing"] = wrong
    app.emit("heartbeat", {"entity": f"sense:{NAME}", "summary": summary, "facts": facts})


@app.background
def beat():
    n = 0
    while True:
        if n % max(1, int(HEARTBEAT_S // 30)) == 0:
            heartbeat()
        elif failing() != status_.get("said_failing"):
            heartbeat(look=False)  # a read went wrong, or worked again: said at once
        TAB.release_if_idle()
        try:
            check_accounts(force=n == 0)
        except Exception as e:
            log(f"checking the accounts: {e}")
        n += 1
        time.sleep(30)

