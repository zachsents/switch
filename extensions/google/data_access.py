"""Data Access: the scopes an OAuth app's consent screen lists, and what Google's verification asks of them (a
justification per group of sensitive and restricted scopes, how a restricted API's data is used, a demo video), set in
one step instead of by hand in the console.

Google has no API for this page (Google Auth Platform's Data Access, console.cloud.google.com/auth/scopes), so it's
driven in a background tab of the Mac mini's Chrome, signed in to the user's Google accounts, the way a person would:

- `consent_scopes(project)` reads the page: every scope by tier (non-sensitive, sensitive, restricted by API), each
  justification box's words, the restricted APIs' uses, the video link. It records what it saw as
  google-consent:<project>, so the brain knows how the consent screen stands.
- `set_consent_scopes(project, scopes, justifications, video, uses)` makes the page say exactly that: ticks and unticks
  the scope picker's rows (pasting the scopes it doesn't list into Manually add scopes), presses its Update, types each
  justification and the video link, picks the uses, reads it all back, and stops before Save. It holds that tab and
  answers an approval card's parts (Approve runs save_consent_scopes, the tab live on the card), since Save changes
  what Google reviews and what every user's consent shows.
- `save_consent_scopes(apply)` presses Save on that tab (filling it again first if the tab lost it), reloads the page
  and checks Google kept every scope and word, then lets the tab go; with discard, it drops the edits unsaved.

The page scripts (JS below) find things by what the page itself names them (its table components, the test classes on
its fields, its headings), never by coordinates, and step through every page of each table (they show ten rows).
"""

import json
import os
import re
import threading
import time
import urllib.parse

import consent
import oauth
import server
from server import part

app = part("oauth")
app.event("scopes", "An OAuth app's Data Access page as last read or saved: its scopes by tier, justifications, uses and video",
          stream="google/oauth", kind="observation")

HOME = oauth.HOME
PLANS_PATH = os.path.join(HOME, "scopes.json")
HOLD_HOURS = 72
"""How long a filled page waits on the user's approval, its tab held all the while."""
BOX_MAX = 1000
"""Google's limit on each justification box (the textarea's maxlength)."""
GOOGLEAPIS = "https://www.googleapis.com/"
VIDEO = re.compile(r"^https://(\w+\.)?(youtube\.com|youtu\.be)/.{8,}")
"""What the page's video field accepts (its own pattern)."""
ALIASES = {"email": GOOGLEAPIS + "auth/userinfo.email", "profile": GOOGLEAPIS + "auth/userinfo.profile"}

pause = time.sleep
"""How it waits on the page between reads (its tests don't)."""
lock = threading.RLock()
state = {"reads": 0, "fills": 0, "saves": 0, "failed": 0, "last_error": None, "last_save": None}


# Scopes as the page writes them, and as callers do

def full(scope):
    """A scope as Google names it: gmail.send, .../auth/gmail.send, auth/gmail.send and its URL are one scope; email and
    profile are userinfo's; openid and other hosts' URLs (https://mail.google.com/) stay as they are."""
    s = (scope or "").strip()
    if not s:
        raise ValueError("an empty scope")
    if s in ALIASES:
        return ALIASES[s]
    if s == "openid" or re.match(r"^https?://", s):
        return s
    if s.startswith(".../"):
        return GOOGLEAPIS + s[4:]
    if s.startswith("auth/"):
        return GOOGLEAPIS + s
    if re.fullmatch(r"[a-z][a-z0-9._-]*", s, re.I):
        return GOOGLEAPIS + "auth/" + s
    raise ValueError(f"not a scope: {scope!r}")


def short(scope):
    """The scope's last part, as people say it (gmail.send), for summaries."""
    s = full(scope)
    return s[len(GOOGLEAPIS + "auth/"):] if s.startswith(GOOGLEAPIS + "auth/") else s


def wanted(scopes):
    out, seen = [], set()
    for s in scopes or []:
        f = full(s)
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def configured(page):
    """Every scope the page lists, in every tier."""
    t = page.get("tiers") or {}
    out = list(t.get("non_sensitive") or []) + list(t.get("sensitive") or [])
    for rows in (t.get("restricted") or {}).values():
        out += rows
    return [full(s) for s in out]


def box_key(key):
    """A justification box's name: sensitive, or the restricted API's (drive, gmail)."""
    k = re.sub(r"[^a-z]+", "", (key or "").lower())
    k = re.sub(r"(scopes?|restricted)$", "", k) or k
    return "sensitive" if k in ("sensitive", "sensitivescope", "sensitivescopes") else k


def texts_of(justifications):
    """{box: text}, each value its words or {"file": a path on this Mac}; each checked against Google's limit."""
    out = {}
    for key, value in (justifications or {}).items():
        if isinstance(value, dict):
            path = value.get("file") or value.get("path")
            if not path:
                raise ValueError(f"justification {key}: give its text, or {{\"file\": path}}")
            with open(os.path.expanduser(path), encoding="utf-8") as f:
                value = f.read()
        text = (value or "").strip()
        if not text:
            raise ValueError(f"justification {key} is empty")
        # The page counts as the browser does: UTF-16 code units.
        n = len(text.encode("utf-16-le")) // 2
        if n > BOX_MAX:
            raise ValueError(f"justification {key} is {n} characters; Google's box takes {BOX_MAX}")
        out[box_key(key)] = text
    return out


def uses_of(uses):
    out = {}
    for key, value in (uses or {}).items():
        labels = [value] if isinstance(value, str) else list(value or [])
        labels = [re.sub(r"\s+", " ", x).strip() for x in labels if (x or "").strip()]
        if not labels:
            raise ValueError(f"uses {key}: name at least one, as the page words it (Drive productivity)")
        out[box_key(key)] = labels
    return out


def picked(shown):
    """A select's labels as it shows them ("Drive productivity and Drive backup", "A, B and C")."""
    return sorted(x.strip() for x in re.split(r",\s*(?:and\s+)?|\s+and\s+", shown or "") if x.strip())


def mismatches(page, want=None, texts=None, video=None, uses=None):
    """What the page says differently from what was asked: [] when it says exactly that."""
    out = []
    if want is not None:
        have = set(configured(page))
        extra = [short(s) for s in configured(page) if s not in set(want)]
        missing = [short(s) for s in want if s not in have]
        if missing:
            out.append("missing scopes: " + ", ".join(missing))
        if extra:
            out.append("scopes not asked for: " + ", ".join(extra))
    boxes = page.get("justifications") or {}
    for key, text in (texts or {}).items():
        if key not in boxes:
            out.append(f"no {key} justification box on the page (it has: {', '.join(boxes) or 'none'})")
        elif (boxes[key] or "").strip() != text:
            out.append(f"the {key} justification reads differently")
    if video and (page.get("video") or "").strip() != video:
        out.append(f"the video link reads {page.get('video')!r}")
    shown = page.get("uses") or {}
    for key, labels in (uses or {}).items():
        if key not in shown:
            out.append(f"no {key} uses on the page (it has: {', '.join(shown) or 'none'})")
        elif picked(shown[key]) != sorted(labels):
            out.append(f"{key} uses read {shown[key]!r}")
    return out


def changes(before, after):
    """What a fill changed, for the card and the answer."""
    b, a = configured(before), configured(after)
    out = {"added": [short(s) for s in a if s not in set(b)], "removed": [short(s) for s in b if s not in set(a)]}
    bj, aj = before.get("justifications") or {}, after.get("justifications") or {}
    out["justifications"] = sorted(k for k in aj if (aj.get(k) or "").strip() != (bj.get(k) or "").strip())
    bu, au = before.get("uses") or {}, after.get("uses") or {}
    out["uses"] = {k: au[k] for k in au if picked(au.get(k)) != picked(bu.get(k))}
    if (after.get("video") or "") != (before.get("video") or ""):
        out["video"] = after.get("video")
    return {k: v for k, v in out.items() if v}


def summary(page):
    """The page in a few words a card or a person reads: tiers as scope names, boxes as their length."""
    t = page.get("tiers") or {}
    return {
        "scopes": len(configured(page)),
        "non_sensitive": [short(s) for s in t.get("non_sensitive") or []],
        "sensitive": [short(s) for s in t.get("sensitive") or []],
        "restricted": {k: [short(s) for s in v] for k, v in (t.get("restricted") or {}).items() if v},
        "justifications": {k: len(v or "") for k, v in (page.get("justifications") or {}).items()},
        "uses": page.get("uses") or {},
        "video": page.get("video"),
    }


def said(c):
    """Changes in one line."""
    bits = []
    if c.get("added"):
        bits.append("adds " + ", ".join(c["added"]))
    if c.get("removed"):
        bits.append("removes " + ", ".join(c["removed"]))
    if c.get("justifications"):
        bits.append("new justification for " + ", ".join(c["justifications"]))
    if c.get("uses"):
        bits.append("uses " + "; ".join(f"{k}: {v}" for k, v in c["uses"].items()))
    if c.get("video"):
        bits.append("video " + c["video"])
    return "; ".join(bits) or "no change"


# The page scripts. Each starts with its name in a comment (the tests' fake page goes by it), and takes its arguments
# as A. They wait on the page themselves, so a call is one round trip.

COMMON = r"""
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const full = (s) => { s = norm(s); return s.startsWith(".../") ? "https://www.googleapis.com/" + s.slice(4) : s; };
const picker = () => document.querySelector("apis-oauth-app-scope-picker");
const mine = (e) => !e.closest("apis-oauth-app-scope-picker");
const heads = () => [...document.querySelectorAll("h1, h2, h3, h4")].filter(mine);
const headBefore = (el) => { let last = null; for (const h of heads()) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = h; return last ? norm(last.innerText) : ""; };
const groupOf = (el) => { const h = headBefore(el); if (/non-sensitive/i.test(h)) return "non_sensitive"; if (/sensitive/i.test(h)) return "sensitive"; const m = h.match(/^(.+?) scopes$/i); if (m && !/^your /i.test(h)) return "restricted:" + m[1].toLowerCase().replace(/[^a-z]+/g, ""); if (/restricted/i.test(h)) return "restricted:restricted"; return "other:" + h; };
const boxKey = (t) => { const c = String(t.className); if (/p6ntest-sensitiveScopeJustification/.test(c)) return "sensitive"; const m = c.match(/p6ntest-([A-Za-z]+)-scopeJustification/); if (m) return m[1].toLowerCase(); const g = groupOf(t); return g.startsWith("restricted:") ? g.slice(11) : g; };
const button = (root, words) => [...root.querySelectorAll("button")].find((b) => norm(b.innerText) === words || b.getAttribute("aria-label") === words);
const enabled = (b) => b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
const setValue = (el, v) => { el.focus(); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new Event("blur", { bubbles: true })); el.blur(); };
const firstPage = async (root) => { for (let i = 0; i < 80; i++) { const p = root.querySelector(".cfc-table-pagination-nav-button-previous"); if (!enabled(p)) return; p.click(); await sleep(120); } };
const nextPage = async (root) => { const n = root.querySelector(".cfc-table-pagination-nav-button-next"); if (!enabled(n)) return false; n.click(); await sleep(350); return true; };
const scopeOf = (row) => { const cells = [...row.querySelectorAll("td")].map((c) => norm(c.innerText)).filter(Boolean); const s = cells.find((c) => /^(\.\.\.\/|https?:\/\/)/.test(c)) || cells.find((c) => /^(openid|email|profile)$/.test(c)); return s ? full(s) : null; };
const snack = "mat-snack-bar-container, .mat-mdc-snack-bar-container, cfc-snack-bar, .cfc-toast, [role=status], [role=alert]";
const dialogs = () => [...document.querySelectorAll("mat-dialog-container, cfc-dialog, [role=alertdialog], .cdk-overlay-pane [role=dialog]")].filter((d) => d.getBoundingClientRect().width > 0 && !d.closest(".cfc-select-panel") && !d.querySelector(".cfc-select-panel") && !d.closest(snack) && !d.matches(snack) && [...d.querySelectorAll("button")].some((b) => !/^(dismiss|close)?$/i.test(norm(b.innerText))));
const toasts = () => [...document.querySelectorAll(snack + ", .cdk-overlay-pane")].map((e) => norm(e.innerText)).filter(Boolean);
"""

READ_JS = "/*read*/ await (async (A) => {" + COMMON + r"""
  const href = location.href;
  if (/(^|\.)accounts\.google\.com$/.test(location.hostname)) return { href, signin: true };
  const text = document.body ? norm(document.body.innerText) : "";
  const h1 = norm((document.querySelector("h1") || {}).innerText);
  if (/don.t have permission|permission denied|You need additional access/i.test(text) && h1 !== "Data Access") return { href, denied: text.slice(0, 300) };
  if (/Google Auth Platform not configured yet/i.test(text) && !document.querySelector("apis-oauth-app-scope-table")) return { href, unconfigured: text.slice(0, 300) };
  const tables = [...document.querySelectorAll("apis-oauth-app-scope-table")].filter(mine);
  if (h1 !== "Data Access" || !document.querySelector("apis-oauth-app-scope-viewer, apis-oauth-app-scope-table")) return { href, loading: true, h1 };
  const tiers = { non_sensitive: [], sensitive: [], restricted: {} };
  for (const t of tables) {
    const g = groupOf(t), rows = [];
    await firstPage(t);
    for (let page = 0; page < 60; page++) {
      for (const r of t.querySelectorAll("tbody tr")) { const s = scopeOf(r); if (s) rows.push(s); }
      if (!(await nextPage(t))) break;
    }
    await firstPage(t);
    if (g.startsWith("restricted:")) tiers.restricted[g.slice(11)] = (tiers.restricted[g.slice(11)] || []).concat(rows);
    else if (g in tiers) tiers[g] = tiers[g].concat(rows);
  }
  const justifications = {};
  for (const t of [...document.querySelectorAll("textarea")].filter(mine)) if (/scopeJustification/i.test(String(t.className)) || /justification/i.test(headBefore(t) + " " + (t.getAttribute("placeholder") || ""))) justifications[boxKey(t)] = t.value;
  const uses = {};
  for (const s of [...document.querySelectorAll("cfc-select")].filter(mine)) {
    if (s.closest("cfc-table-pagination")) continue;
    const g = groupOf(s);
    uses[g.startsWith("restricted:") ? g.slice(11) : g] = norm((s.querySelector(".cfc-select-value-text") || s).innerText);
  }
  const v = document.querySelector("input.p6ntest-videoLink, input[formcontrolname=videoLink]");
  const save = button(document, "Save");
  const errors = [...document.querySelectorAll("mat-error, .mat-mdc-form-field-error")].filter(mine).map((e) => norm(e.innerText)).filter(Boolean);
  return { href, tiers, justifications, uses, video: v ? v.value : null, save_enabled: enabled(save), picker_open: !!picker(), errors };
})(__ARGS__)"""

PICK_JS = "/*pick*/ await (async (A) => {" + COMMON + r"""
  let p = picker();
  if (!p) {
    const b = button(document, "Add or remove scopes");
    if (!b) return { error: "the page has no Add or remove scopes button" };
    b.click();
    for (let i = 0; i < 60 && !(p = picker()); i++) await sleep(250);
    if (!p) return { error: "the scope picker didn't open" };
  }
  for (let i = 0; i < 60 && !p.querySelector("tbody tr"); i++) await sleep(250);
  const want = new Set(A.want), seen = new Set(), ticked = [], unticked = [], stuck = [];
  const box = (r) => r.querySelector("mat-pseudo-checkbox[aria-label='Select row']") || r.querySelector("[data-selection-cell] mat-pseudo-checkbox, mat-pseudo-checkbox, [role=checkbox]");
  const on = (b) => b.getAttribute("aria-checked") === "true";
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    await firstPage(p);
    for (let page = 0; page < 80; page++) {
      for (const r of p.querySelectorAll("tbody tr")) {
        const s = scopeOf(r), b = box(r);
        if (!s || !b) continue;
        seen.add(s);
        if (on(b) === want.has(s)) continue;
        b.click(); await sleep(150);
        if (on(b) !== want.has(s)) { (r.querySelector("[data-selection-cell]") || r).click(); await sleep(200); }
        if (on(b) === want.has(s)) { (want.has(s) ? ticked : unticked).push(s); changed++; } else stuck.push(s);
      }
      if (!(await nextPage(p))) break;
    }
    if (!changed) break;
  }
  const missing = A.want.filter((s) => !seen.has(s));
  let pasted = [], errors = [];
  if (missing.length) {
    const ta = p.querySelector("textarea");
    if (!ta) return { error: "the picker has no Manually add scopes box", ticked, unticked };
    setValue(ta, missing.join("\n"));
    const add = button(p, "Add to table");
    for (let i = 0; i < 40 && !enabled(add); i++) await sleep(150);
    if (!enabled(add)) return { error: "Add to table stayed disabled for " + missing.join(", "), ticked, unticked };
    add.click(); await sleep(1500);
    errors = [...p.querySelectorAll("mat-error, .mat-mdc-form-field-error, .cfc-form-error")].map((e) => norm(e.innerText)).filter(Boolean);
    pasted = missing;
  }
  return { table: seen.size, ticked, unticked: [...new Set(unticked)], stuck: [...new Set(stuck)], pasted, errors };
})(__ARGS__)"""

UPDATE_JS = "/*update*/ await (async (A) => {" + COMMON + r"""
  const p = picker();
  if (!p) return { error: "the scope picker isn't open" };
  const b = button(p, "Update");
  if (!enabled(b)) return { error: "the picker's Update is disabled" };
  b.click();
  for (let i = 0; i < 60 && picker(); i++) await sleep(250);
  const d = dialogs().map((x) => norm(x.innerText));
  return { closed: !picker(), dialogs: d };
})(__ARGS__)"""

FILL_JS = "/*fill*/ await (async (A) => {" + COMMON + r"""
  const out = { boxes: {}, video: null };
  const boxes = {};
  for (const t of [...document.querySelectorAll("textarea")].filter(mine)) if (/scopeJustification/i.test(String(t.className)) || /justification/i.test(headBefore(t))) boxes[boxKey(t)] = t;
  for (const [k, v] of Object.entries(A.texts || {})) {
    const t = boxes[k];
    if (!t) { out.boxes[k] = "missing"; continue; }
    if (t.value !== v) { setValue(t, v); await sleep(150); }
    out.boxes[k] = t.value === v ? "ok" : "differs";
  }
  if (A.video) {
    const v = document.querySelector("input.p6ntest-videoLink, input[formcontrolname=videoLink]");
    if (!v) out.video = "missing";
    else { if (v.value !== A.video) { setValue(v, A.video); await sleep(150); } out.video = v.value === A.video ? "ok" : "differs"; }
  }
  out.available = Object.keys(boxes);
  return out;
})(__ARGS__)"""

USES_JS = "/*uses*/ await (async (A) => {" + COMMON + r"""
  const selects = [...document.querySelectorAll("cfc-select")].filter((s) => mine(s) && !s.closest("cfc-table-pagination"));
  const s = selects.find((x) => { const g = groupOf(x); return (g.startsWith("restricted:") ? g.slice(11) : g) === A.key; });
  if (!s) return { error: "no " + A.key + " uses on the page" };
  (s.querySelector(".cfc-select-trigger") || s).click();
  let panel = null;
  for (let i = 0; i < 40 && !(panel = document.querySelector(".cfc-select-panel")); i++) await sleep(150);
  if (!panel) return { error: "the " + A.key + " uses list didn't open" };
  const want = new Set(A.labels), seen = [];
  for (const o of panel.querySelectorAll("mat-option")) {
    const label = norm(o.innerText); seen.push(label);
    const sel = o.getAttribute("aria-selected") === "true";
    if (sel !== want.has(label)) { o.click(); await sleep(150); }
  }
  const unknown = A.labels.filter((l) => !seen.includes(l));
  const root = panel.closest(".cdk-overlay-pane") || document;
  if (unknown.length) { const c = button(root, "Cancel"); if (c) c.click(); await sleep(400); return { error: "no such " + A.key + " use: " + unknown.join(", ") + " (it offers: " + seen.join(", ") + ")" }; }
  const ok = button(root, "OK");
  if (ok) ok.click();
  await sleep(900);
  const said = [];
  for (const d of dialogs()) { said.push(norm(d.innerText).slice(0, 600)); const c = button(d, "Continue"); if (c) { c.click(); await sleep(700); } }
  return { shown: norm((s.querySelector(".cfc-select-value-text") || s).innerText), offered: seen, dialogs: said };
})(__ARGS__)"""

SAVE_JS = "/*save*/ await (async (A) => {" + COMMON + r"""
  const before = toasts();
  const save = button(document, "Save");
  if (!save) return { error: "the page has no Save button" };
  if (!(A.confirm && dialogs().length)) {
    if (!enabled(save)) return { error: "Save is disabled: the page has nothing unsaved" };
    save.click();
  }
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const t = toasts().filter((x) => !before.includes(x));
    const bad = t.find((x) => /error|fail|couldn.t|unable|went wrong|try again/i.test(x) && !/saved/i.test(x));
    if (bad) return { error: bad };
    const good = t.find((x) => /changes saved|saved!|has been saved|were saved/i.test(x));
    if (good) return { saved: good };
    const ds = dialogs();
    if (ds.length) {
      const d = ds[0], words = norm(d.innerText).slice(0, 800);
      if (!A.confirm) return { confirm: words, buttons: [...d.querySelectorAll("button")].map((b) => norm(b.innerText)).filter(Boolean) };
      const c = [...d.querySelectorAll("button")].reverse().find((b) => enabled(b) && !/cancel|back|close|no$/i.test(norm(b.innerText)));
      if (!c) return { error: "the dialog has nothing to confirm with: " + words };
      c.click(); A.confirm = false; await sleep(800); continue;
    }
    const errs = [...document.querySelectorAll("mat-error, .mat-mdc-form-field-error")].filter(mine).map((e) => norm(e.innerText)).filter(Boolean);
    if (errs.length && enabled(save)) return { error: errs.join("; ") };
    if (i > 20 && !enabled(save)) return { saved: "Save went grey again" };
  }
  return { error: "the page never said it saved" };
})(__ARGS__)"""

DISCARD_JS = "/*discard*/ await (async (A) => {" + COMMON + r"""
  const p = picker();
  if (p) { const c = button(p, "Close") || button(p, "Cancel"); if (c) { c.click(); await sleep(600); } }
  const d = button(document, "Discard changes");
  if (enabled(d)) {
    d.click(); await sleep(800);
    for (const x of dialogs()) { const b = [...x.querySelectorAll("button")].find((b) => /discard|leave|ok|yes/i.test(norm(b.innerText))); if (b) { b.click(); await sleep(600); } }
  }
  return { discarded: true, save_enabled: enabled(button(document, "Save")) };
})(__ARGS__)"""


def script(js, **args):
    return js.replace("__ARGS__", json.dumps(args))


# The tab

def tab_for(mac, session):
    return consent.Tab(mac or oauth.MAC, session, ask=oauth.ask)


def run(tab, js, timeout=90, **args):
    """One page script's answer."""
    return consent.parsed(tab.op({"op": "js", "code": script(js, **args), "timeout": timeout}, timeout + 30))


def page_url(project, account):
    return (f"https://console.cloud.google.com/auth/scopes?project={urllib.parse.quote(project)}"
            f"&authuser={urllib.parse.quote(account or oauth.OWNER)}")


def open_page(tab, project, account, seconds=75):
    """Navigates the tab to Data Access and waits until every table is read: the page, as READ_JS says it."""
    url = page_url(project, account)
    try:
        tab.op({"op": "navigate", "url": url}, 60)
    except consent.Failed as e:
        if not re.search(r"dialog|beforeunload|leave", str(e), re.I):
            raise
        tab.op({"op": "dialog", "accept": True}, 30)  # Unsaved edits of a fill this replaces: they go.
        tab.op({"op": "navigate", "url": url}, 60)
    return wait_read(tab, project, account, seconds)


def same(a, b):
    return (sorted(configured(a)), a.get("justifications"), a.get("uses"), a.get("video")) == \
        (sorted(configured(b)), b.get("justifications"), b.get("uses"), b.get("video"))


def wait_read(tab, project, account, seconds=75):
    """The page once it's loaded and two reads a moment apart agree (its tables fill in after its headings)."""
    until, last, prev = time.time() + seconds, None, None
    while time.time() < until:
        try:
            page = run(tab, READ_JS)
        except (consent.Failed, ValueError) as e:
            last = str(e)
            pause(2)
            continue
        if page.get("signin"):
            raise RuntimeError(f"the Mac's Chrome isn't signed in to the Cloud console as {account or oauth.OWNER}")
        if page.get("denied"):
            raise RuntimeError(f"{account or oauth.OWNER} can't open project {project}'s Data Access: {page['denied'][:200]}")
        if page.get("unconfigured"):
            raise RuntimeError(f"project {project} has no Google Auth Platform set up yet (its consent screen): {page['unconfigured'][:200]}")
        if not page.get("loading"):
            if prev is not None and same(prev, page):
                return page
            prev, last = page, "its tables were still filling in"
            pause(1.5)
            continue
        last = f"still loading ({page.get('h1') or page.get('href')})"
        pause(2)
    raise RuntimeError(f"project {project}'s Data Access page didn't load in {seconds} s: {last}")


def plans():
    return oauth.read_json(PLANS_PATH, {})


def keep_plan(pid, plan):
    with lock:
        stored = plans()
        if plan is None:
            stored.pop(pid, None)
        else:
            stored[pid] = plan
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        oauth.write_private(PLANS_PATH, json.dumps(stored))


def waiting_for(project):
    return {pid: p for pid, p in plans().items() if p.get("project") == project and not p.get("replaced_by")}


def observe(project, page, **facts):
    s = summary(page)
    app.emit("scopes", {"entity": f"google-consent:{project}",
                        "summary": f"{project}'s consent screen: {s['scopes']} scopes ({len(s['sensitive'])} sensitive, "
                                   f"{sum(len(v) for v in s['restricted'].values())} restricted)",
                        "facts": {"project": project, **s, "read_at": int(time.time() * 1000), **facts}},
             about=[f"google-consent:{project}"])


def screenshot(tab):
    try:
        tab.op({"op": "js", "code": "(() => { const h = document.querySelector('h1'); if (h) h.scrollIntoView({ block: 'start' }); return 1 })()"}, 30)
    except consent.Failed:
        pass
    shot = tab.screenshot()
    if shot:
        shot["name"] = "data-access.jpg"
    return shot


# Filling

def fill(tab, plan, progress, page=None):
    """Makes the page in the tab say what the plan asks (scopes, words, uses, video), short of Save: the page after."""
    want, texts, video, uses = plan.get("want"), plan.get("texts") or {}, plan.get("video"), plan.get("uses") or {}
    page = page or wait_read(tab, plan["project"], plan.get("account"))
    if want is not None and set(configured(page)) != set(want):
        progress("Ticking the scopes in Add or remove scopes")
        picked_ = run(tab, PICK_JS, timeout=240, want=want)
        if picked_.get("error"):
            raise RuntimeError(f"scope picker: {picked_['error']}")
        if picked_.get("stuck"):
            raise RuntimeError("these rows wouldn't tick or untick: " + ", ".join(short(s) for s in picked_["stuck"]))
        if picked_.get("errors"):
            raise RuntimeError("Manually add scopes said: " + "; ".join(picked_["errors"]))
        updated = run(tab, UPDATE_JS, timeout=60)
        if updated.get("error"):
            raise RuntimeError(f"scope picker: {updated['error']}")
        if not updated.get("closed"):
            raise RuntimeError("the scope picker didn't close after Update" + (f": {updated['dialogs']}" if updated.get("dialogs") else ""))
        plan.setdefault("steps", []).append({"picker": {k: picked_.get(k) for k in ("ticked", "unticked", "pasted")}})
        page = wait_read(tab, plan["project"], plan.get("account"))
        off = mismatches(page, want)
        if off:
            raise RuntimeError("after Update the page still differs: " + "; ".join(off))
    for key, labels in uses.items():
        if picked((page.get("uses") or {}).get(key)) != sorted(labels):
            progress(f"Picking how {key}'s data is used")
            u = run(tab, USES_JS, timeout=60, key=key, labels=labels)
            if u.get("error"):
                raise RuntimeError(u["error"])
            if u.get("dialogs"):
                plan.setdefault("said", []).extend(u["dialogs"])
    if texts or video:
        missing = [k for k in texts if k not in (page.get("justifications") or {})]
        if missing:
            raise RuntimeError(f"the page has no justification box for {', '.join(missing)}: it has "
                               f"{', '.join(page.get('justifications') or {}) or 'none'} (sensitive, and one per restricted API)")
        progress("Typing the justifications" if texts else "Setting the video link")
        f = run(tab, FILL_JS, timeout=60, texts=texts, video=video)
        bad = {k: v for k, v in (f.get("boxes") or {}).items() if v != "ok"}
        if bad or (video and f.get("video") != "ok"):
            raise RuntimeError(f"couldn't type into the page: {bad or ''} {'video ' + str(f.get('video')) if video and f.get('video') != 'ok' else ''}".strip())
    page = wait_read(tab, plan["project"], plan.get("account"))
    off = mismatches(page, want, texts, video, uses)
    if off:
        raise RuntimeError("the filled page differs from what was asked: " + "; ".join(off))
    if page.get("errors"):
        raise RuntimeError("the page shows errors: " + "; ".join(page["errors"]))
    return page


def approval_parts(pid, plan, shot):
    """An approval card's parts for the caller to put up: Approve runs save_consent_scopes; the tab is live on it."""
    target = f"macos@{plan['mac']}"
    parts = {
        "assists": [{"label": "Save", "target": oauth.INSTANCE, "action": "save_consent_scopes", "args": {"apply": pid}},
                    {"label": "Show the tab", "target": target, "action": "browser", "args": {"op": "show", "session": plan["session"]}}],
        "portal": {"target": target, "session": plan["session"]},
        "resolve_when": f'entities | where id == "google-consent:{plan["project"]}" and facts.saved_apply == "{pid}"',
    }
    if shot:
        parts["blobs"] = [{"blob": shot["blob"], "type": shot.get("type", "image/jpeg"), "name": shot.get("name", "data-access.jpg")}]
    return parts


def set_scopes(project, scopes=None, justifications=None, video=None, uses=None, account=None, mac=None, save=False,
               dry_run=False, ctx=None):
    progress = ctx.progress if ctx else (lambda m: None)
    want = wanted(scopes) if scopes is not None else None
    texts, uses_ = texts_of(justifications), uses_of(uses)
    video = (video or "").strip() or None
    if video and not VIDEO.match(video):
        raise ValueError(f"the page takes a YouTube link (https://youtu.be/... or youtube.com/...), not {video!r}")
    if want is None and not texts and not video and not uses_:
        raise ValueError("nothing to set: give scopes, justifications, video or uses")
    mac = mac or oauth.MAC
    session = f"google-scopes-{oauth.slug(project)}"
    waiting = waiting_for(project)
    tab = tab_for(mac, f"{session}-look" if dry_run else session)
    state["fills"] += 1
    progress(f"Opening {project}'s Data Access")
    before = open_page(tab, project, account)
    plan = {"project": project, "account": account, "mac": mac, "session": session, "want": want, "texts": texts,
            "video": video, "uses": uses_, "at": int(time.time() * 1000), "work": ctx.work if ctx else None}
    off = mismatches(before, want, texts, video, uses_)
    if dry_run or not off:
        tab.release()
        out = {"project": project, "page": summary(before), "differs": off}
        if not off:
            out["note"] = "Data Access says exactly this already: nothing to fill or save."
        else:
            want_ = set(want) if want is not None else set(configured(before))
            out["would"] = {"add": [short(s) for s in want_ if s not in set(configured(before))],
                            "remove": [short(s) for s in configured(before) if s not in want_],
                            "justifications": sorted(k for k in texts if (before.get("justifications") or {}).get(k, "").strip() != texts[k]),
                            "video": video if video and video != before.get("video") else None,
                            "uses": {k: v for k, v in uses_.items() if picked((before.get("uses") or {}).get(k)) != sorted(v)}}
            out["note"] = "Dry run: nothing was ticked, typed or saved."
        if waiting:
            out["waiting"] = sorted(waiting)
        return out
    try:
        after = fill(tab, plan, progress, before)
    except Exception as e:
        shot = screenshot(tab)
        try:
            run(tab, DISCARD_JS, timeout=30)
        except (consent.Failed, ValueError):
            pass
        tab.release()
        raise RuntimeError(f"{e} (nothing was saved; the page as it stood: {shot['blob'] if shot else 'no picture'})") from e
    pid = oauth.new_id()
    for old in waiting:
        if old != pid:
            keep_plan(old, {**plans()[old], "replaced_by": pid})
    plan.update({"before": summary(before), "changes": changes(before, after)})
    if save:
        keep_plan(pid, plan)
        return save_plan(pid, tab=tab, progress=progress)
    tab.hold(HOLD_HOURS)
    shot = screenshot(tab)
    keep_plan(pid, plan)
    out = {"apply": pid, "project": project, "changes": plan["changes"], "said": said(plan["changes"]),
           "page": summary(after), "approval": approval_parts(pid, plan, shot),
           "note": (f"{project}'s Data Access is filled, unsaved, in a held tab ({session} on {mac}). Put the approval "
                    f"parts on the user's card: Approve runs save_consent_scopes, which saves it and checks Google kept it. "
                    f"On a card that also does something else (an email), call save_consent_scopes yourself once he "
                    f"approved.")}
    if plan.get("said"):
        out["page_said"] = plan["said"]
    if waiting:
        out["replaced"] = sorted(waiting)
    return out


# Saving

def save_plan(pid, discard=False, confirm=False, tab=None, progress=lambda m: None):
    plan = plans().get(pid)
    if not plan:
        raise ValueError(f"no filled Data Access {pid} waiting (it was saved, discarded, or never filled)")
    if plan.get("replaced_by"):
        raise ValueError(f"{pid} was replaced by {plan['replaced_by']}, a newer fill of {plan['project']}'s Data Access: save that one")
    project, account = plan["project"], plan.get("account")
    tab = tab or tab_for(plan["mac"], plan["session"])
    if discard:
        try:
            run(tab, DISCARD_JS, timeout=30)
        except (consent.Failed, ValueError):
            pass
        tab.release()
        keep_plan(pid, None)
        return {"discarded": pid, "project": project, "note": "Nothing was saved; the tab is let go."}
    state["saves"] += 1
    try:
        page = wait_read(tab, project, account, 20)
    except RuntimeError:
        page = None
    if page is None or not page.get("save_enabled") or mismatches(page, plan.get("want"), plan.get("texts"), plan.get("video"), plan.get("uses")):
        progress("Filling the page again")  # The tab was reloaded, closed or lapsed: its edits went with it.
        page = open_page(tab, project, account)
        if not mismatches(page, plan.get("want"), plan.get("texts"), plan.get("video"), plan.get("uses")):
            tab.release()
            keep_plan(pid, None)
            observe(project, page, saved_apply=pid, saved_at=int(time.time() * 1000))
            return {"saved": pid, "project": project, "page": summary(page), "note": "Data Access already said exactly this: nothing to save."}
        page = fill(tab, plan, progress, page)
    progress("Pressing Save")
    out = run(tab, SAVE_JS, timeout=90, confirm=confirm)
    if out.get("confirm"):
        keep_plan(pid, {**plan, "confirm": out["confirm"]})
        return {"apply": pid, "project": project, "confirm": out["confirm"], "buttons": out.get("buttons"),
                "note": ("Google asked this before saving, and I pressed nothing. If the user's approval covers it, call "
                         "save_consent_scopes again with confirm: true; otherwise tell him what it says.")}
    if out.get("error"):
        keep_plan(pid, {**plan, "last_error": out["error"]})
        raise RuntimeError(f"Save didn't go through: {out['error']} (the filled tab is still held; save_consent_scopes tries again)")
    progress("Checking Google kept it")
    kept = open_page(tab, project, account)
    off = mismatches(kept, plan.get("want"), plan.get("texts"), plan.get("video"), plan.get("uses"))
    if off:
        keep_plan(pid, {**plan, "last_error": "; ".join(off)})
        raise RuntimeError(f"Google said {out.get('saved')!r}, but the reloaded page differs: " + "; ".join(off))
    now = int(time.time() * 1000)
    observe(project, kept, saved_apply=pid, saved_at=now)
    tab.release()
    keep_plan(pid, None)
    state["last_save"] = {"project": project, "apply": pid, "at": now}
    return {"saved": pid, "project": project, "said": said(plan.get("changes") or {}), "google_said": out.get("saved"),
            "page": summary(kept), "note": "Saved, and the reloaded page says exactly what was asked."}


def tracked(fn):
    def call(*a, **k):
        try:
            return fn(*a, **k)
        except Exception as e:
            state["failed"] += 1
            state["last_error"] = f"{type(e).__name__}: {e}"[:400]
            raise
    return call


PROJECT = {"type": "string", "description": "The Cloud project's id, as its console URL says it."}
ACCOUNT = {"type": "string", "description": "The Google account the console is opened as (default: The user's own, which owns both projects)."}
MAC_ARG = {"type": "string", "description": "The Mac whose Chrome drives the console (default local)."}


@app.tool(name="consent_scopes", read_only=True, schema={"type": "object", "required": ["project"], "properties": {
    "project": PROJECT, "account": ACCOUNT, "mac": MAC_ARG,
    "words": {"type": "boolean", "description": "Answer each justification box's words too, not only its length."}}},
    description=("An OAuth app's Data Access page (Google Auth Platform) as it is now, read in the Mac mini's Chrome: "
                 "every scope by tier (non-sensitive, sensitive, restricted by API), each justification box (sensitive, "
                 "and one per restricted API like drive and gmail), each restricted API's uses, the demo video link, "
                 "and any fill of it waiting on the user's approval. Records it as google-consent:<project>."))
def consent_scopes(project, account=None, mac=None, words=False):
    def read():
        state["reads"] += 1
        tab = tab_for(mac, f"google-scopes-{oauth.slug(project)}-look")
        try:
            page = open_page(tab, project, account)
        finally:
            tab.release()
        observe(project, page)
        out = {"project": project, **summary(page)}
        if words:
            out["justification_words"] = page.get("justifications") or {}
        w = waiting_for(project)
        if w:
            out["waiting"] = {pid: {"said": said(p.get("changes") or {}), "since": p["at"]} for pid, p in w.items()}
        return out
    return tracked(read)()


@app.tool(name="set_consent_scopes", schema={"type": "object", "required": ["project"], "properties": {
    "project": PROJECT,
    "scopes": {"type": "array", "items": {"type": "string"}, "description": (
        "Every scope the app should list, and only those (the rest are unticked; [] lists none): gmail.send, "
        "https://www.googleapis.com/auth/gmail.send, openid, email, profile, https://mail.google.com/. Ones the picker "
        "doesn't list (an API not enabled) are pasted into Manually add scopes. Leave out to keep the scopes as they are.")},
    "justifications": {"type": "object", "additionalProperties": {"anyOf": [{"type": "string"}, {"type": "object", "properties": {"file": {"type": "string"}}}]},
                       "description": ("Each justification box's words, by box: sensitive (one for every sensitive scope) "
                                       "and each restricted API's (drive, gmail), at most 1000 characters each; a value may "
                                       "be {\"file\": path} on the Mac mini (like ~/Documents/.../field-gmail.txt). Boxes "
                                       "left out keep their words.")},
    "video": {"type": "string", "description": "The demo video's YouTube link (https://youtu.be/...)."},
    "uses": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}},
             "description": "How each restricted API's data is used, as the page words them: {\"drive\": [\"Drive productivity\"], \"gmail\": [\"Email productivity\"]}."},
    "account": ACCOUNT, "mac": MAC_ARG,
    "save": {"type": "boolean", "description": "Press Save too: only when the user asked for exactly this change, or approved it already."},
    "dry_run": {"type": "boolean", "description": "Only read the page and say what would change; touches nothing."},
}}, description=(
    "Make an OAuth app's Data Access page (Google Auth Platform's consent-screen scopes) say exactly this in one step, in "
    "the Mac mini's Chrome: ticks and unticks the Add or remove scopes picker's rows (pasting scopes it doesn't list "
    "into Manually add scopes) and presses its Update, types each justification and the video link, picks the "
    "restricted APIs' uses, then reads the whole page back and checks it says what was asked. It stops before Save, "
    "holds the tab, and answers what changed with an approval card's parts (assists: Save, which runs "
    "save_consent_scopes, and Show the tab; the tab as a portal; a picture of the page; resolve_when): Save changes what "
    "Google's verification reviews and every user's consent screen, so it's the user's. Nothing to change answers so and "
    "holds nothing; a newer fill of the same project replaces one still waiting."))
def set_consent_scopes(project, scopes=None, justifications=None, video=None, uses=None, account=None, mac=None,
                       save=False, dry_run=False, ctx=None):
    return tracked(set_scopes)(project, scopes, justifications, video, uses, account, mac, save, dry_run, ctx)


@app.tool(name="save_consent_scopes", schema={"type": "object", "required": ["apply"], "properties": {
    "apply": {"type": "string", "description": "The fill's id, as set_consent_scopes answered it."},
    "discard": {"type": "boolean", "description": "Drop the edits unsaved and let the tab go (The user declined, or it's moot)."},
    "confirm": {"type": "boolean", "description": "Press the confirming button of a dialog Google showed on Save, once the approval covers what it says."}}},
    description=("Press Save on a Data Access page set_consent_scopes filled, once the user approved it (his card's Approve "
                 "runs this): fills it again first if the tab lost its edits, saves, reloads the page and checks Google "
                 "kept every scope and word, records google-consent:<project> with saved_apply (which closes the card), "
                 "and lets the tab go. A dialog Google shows on Save is answered back, unpressed. With discard: drop it "
                 "unsaved."))
def save_consent_scopes(apply, discard=False, confirm=False, ctx=None):
    return tracked(save_plan)(apply, discard, confirm, progress=ctx.progress if ctx else (lambda m: None))


def health():
    """For status and the heartbeat: the fills waiting on the user and how the page driving has gone."""
    w = {pid: {"project": p["project"], "since": p["at"], "said": said(p.get("changes") or {})}
         for pid, p in plans().items() if not p.get("replaced_by")}
    audits = server.local.get("scope_audit_health")
    return {"waiting": w, **state, **({"audits": audits()} if audits else {})}


server.local["data_access_health"] = health
