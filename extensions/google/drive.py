#!/usr/bin/env python3
"""Google Drive: a file on the person's Drive, and a link anyone with it can open, in one step.

`upload` takes a file or folder on this server, a blob, or a path on any Mac (that Mac's appendage sends it here with
transfer_file), zips a folder, and puts it in a "Switchboard" folder on the account's Drive: resumably, so a dropped
connection picks up where it was, and checked against Drive's MD5 so every byte arrived. Then it shares it view-only
with anyone who has the link (not findable by search) and opens that link from outside, signed out, before it answers
with it. Nobody is told anything: the link goes wherever the caller sends it. `share` turns a file's link on or off,
`trash` takes a file's link down and puts it in the Drive's trash (a trashed file
still opens by its link until it's deleted for good, so the link comes off first), `files` lists what it has uploaded, `accounts` the connected
Drives.

Scope drive.file only: on the Drive it sees and changes nothing but the files and folders it made itself. Connecting an
account is `connect`, a consent URL that works in any browser, the person's phone included; Google sends it back to
the core's callback, which calls `finish`. Secrets never touch the log (google_oauth.py): the OAuth client and each
account's refresh token live in `secrets.json` in its own `SB_HOME`.

What it records: each file as `drive-file:<id>` in drive/files (`gone` once trashed), each account as
`drive-account:<account>` in drive/accounts, an ask in asks when an account's access dies, and a heartbeat of itself
in vitals/google-drive every 15 minutes.
"""

import hashlib
import html
from http import client as httpclient
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

import sbmcp
from server import part, home as home_of
from google_oauth import CONNECT, OPENS, SWITCH, Disconnected, Google, TokenError

INSTANCE = os.environ.get("SB_INSTANCE", "google-drive@dev")
HOME = home_of("drive")
os.makedirs(HOME, mode=0o700, exist_ok=True)
MACHINE = INSTANCE.split("@", 1)[-1]
RECEIVER = os.environ.get("DRIVE_RECEIVER") or (("server@" if MACHINE == "switchboard" else "macos@") + MACHINE)
"""The appendage a Mac sends files to for this one: the keeper of the machine it runs on (the server's, or this Mac's)."""
KEYCHAIN = "switchboard-google-drive"
SCOPE = "https://www.googleapis.com/auth/drive.file"
API = os.environ.get("DRIVE_API", "https://www.googleapis.com/drive/v3")
UPLOAD = os.environ.get("DRIVE_UPLOAD", "https://www.googleapis.com/upload/drive/v3/files")
VIEW = os.environ.get("DRIVE_VIEW", "https://drive.google.com")
ROOT = os.environ.get("DRIVE_FOLDER", "Switchboard")
FOLDER_MIME = "application/vnd.google-apps.folder"
FILE_FIELDS = "id,name,size,mimeType,md5Checksum,webViewLink,webContentLink,createdTime,parents,trashed,permissionIds"
CHUNK = int(os.environ.get("DRIVE_CHUNK", str(16 * 1024 * 1024)))
"""Bytes per request of an upload: a multiple of 256 KiB, as Drive asks."""
HEARTBEAT_S = 15 * 60
QUOTA_EVERY_S = 6 * 3600
BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

app = part("drive", {"connect": "drive_connect", "accounts": "drive_accounts"})
app.event("file", "A file it put on a Drive: uploaded, or its sharing changed", stream="drive/files", kind="observation")
app.event("file.gone", "A file it uploaded was trashed", stream="drive/files", kind="gone")
app.event("account", "A connected Drive: whether it still works, and its storage", stream="drive/accounts", kind="observation")
app.event("ask", "Something the person must do: connect a Drive again", stream="asks", kind="ask")
app.event("heartbeat", "How the sense itself is", stream="vitals/google-drive", kind="observation", retention="signal")

google = Google(INSTANCE, HOME, KEYCHAIN, [SCOPE])
lock = threading.RLock()
wake = threading.Event()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def slug(address):
    """An account's key in entity ids: me@example.com is me-example-com."""
    return re.sub(r"[^a-z0-9]+", "-", address.lower()).strip("-")


def human(n):
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000


# State: the default account and the folders made on each Drive. Nothing secret.

STATE = os.path.join(HOME, "state.json")


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


state = {"default": None, "folders": {}, **load_state()}


def save_state():
    with lock:
        with open(STATE + ".new", "w") as f:
            json.dump(state, f)
        os.replace(STATE + ".new", STATE)


# HTTP


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status, self.body = status, body

    @property
    def reason(self):
        try:
            return json.loads(self.body)["error"]["errors"][0]["reason"]
        except (ValueError, KeyError, IndexError, TypeError):
            return None

    @property
    def message(self):
        try:
            return json.loads(self.body)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            return self.body[:300]


RETRY = {429, 500, 502, 503, 504}


def http(method, url, token, body=None, params=None, headers=None, timeout=60, raw=False):
    """One call to Google's API, tried again on its passing failures (rate limits, 5xx, a dropped connection)."""
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    head = {"Accept": "application/json", "Authorization": f"Bearer {token}", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        head["Content-Type"] = "application/json; charset=UTF-8"
    for attempt in range(5):
        req = urllib.request.Request(url, data=data, headers=head, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                if raw:
                    return res
                got = res.read()
                return json.loads(got) if got else {}
        except urllib.error.HTTPError as e:
            err = HttpError(e.code, e.read().decode(errors="replace"))
            if e.code not in RETRY and err.reason not in ("rateLimitExceeded", "userRateLimitExceeded") or attempt == 4:
                raise err from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, httpclient.HTTPException) as e:
            if attempt == 4:
                raise RuntimeError(f"couldn't reach Google ({e})") from None
        time.sleep(min(2 ** attempt, 20))


# Accounts


class Account:
    def __init__(self, address):
        self.address = address
        self.key = slug(address)
        self.entity = f"drive-account:{self.key}"
        self.access_token = None
        self.expires_at = 0
        self.connected = True
        self.error = None
        self.quota = None
        self.quota_at = 0
        self.reported = None
        self.reported_at = 0
        self.asked = False
        self.folder_lock = threading.Lock()

    def token(self):
        if self.access_token and time.time() < self.expires_at - 120:
            return self.access_token
        try:
            self.access_token, lasts = google.access(self.address)
        except Disconnected as e:
            self.connected, self.error = False, str(e)
            report(self)
            ask_reconnect(self)
            raise RuntimeError(f"{self.address} isn't connected anymore ({e}): I've put connecting it again in the user's queue") from None
        self.expires_at = time.time() + lasts
        return self.access_token

    def call(self, method, path, body=None, **params):
        return http(method, f"{API}/{path}", self.token(), body, params)


accounts = {}
"""Connected accounts by address: every Google connection holding drive.file, read again by load_accounts."""


def load_accounts():
    """Takes up every connected account not known yet. The connections can't be read until the server's handshake is
    done, which is after import, and a consent the core finishes never comes through finish here: so this reads them
    again in the loop and whenever an account asked for (or any) is missing."""
    found = google.stored()
    with lock:
        for a in sorted(found):
            accounts.setdefault(a, Account(a))


def known(address):
    a = address.strip().lower()
    return any(a in (acct.address.lower(), acct.key) for acct in list(accounts.values()))


def find_account(address=None):
    if not (known(address) if address else accounts):
        load_accounts()
    with lock:
        if address:
            a = address.strip().lower()
            for acct in accounts.values():
                if a in (acct.address.lower(), acct.key):
                    return acct
            raise ValueError(f"no Drive connected for {address} (connected: {', '.join(sorted(accounts)) or 'none'}); "
                             "connect gives a link to connect it")
        if not accounts:
            raise ValueError("no Drive is connected yet: connect gives the link the user opens to connect one")
        if state.get("default") in accounts:
            return accounts[state["default"]]
        if len(accounts) == 1:
            return next(iter(accounts.values()))
        raise ValueError(f"say which Drive: {', '.join(sorted(accounts))}")


def report(acct, force=False):
    """The account's own observation: connected or not, and its storage. Recorded when that changes, and every few hours."""
    facts = {"address": acct.address, "connected": acct.connected, "error": acct.error,
             "default": state.get("default") == acct.address, "scope": "drive.file"}
    if acct.quota:
        facts.update(storage_used=int(acct.quota.get("usage", 0)), storage_limit=int(acct.quota["limit"]) if acct.quota.get("limit") else None)
    if facts == acct.reported and not force and time.time() - acct.reported_at < QUOTA_EVERY_S:
        return
    acct.reported, acct.reported_at = facts, time.time()
    if acct.connected:
        used = facts.get("storage_used")
        limit = facts.get("storage_limit")
        room = f", {human(used)} of {human(limit)} used" if used is not None and limit else ""
        summary = f"{acct.address}'s Drive: connected for uploads{room}"
    else:
        summary = f"{acct.address}'s Drive: disconnected ({acct.error})"
    app.emit("account", {"entity": acct.entity, "summary": summary, "facts": {**facts, "checked_at": int(time.time() * 1000)}},
             about=[acct.entity])


def check(acct):
    """Whether the account still works (a token and a small call), and its storage now and then."""
    try:
        if time.time() - acct.quota_at > QUOTA_EVERY_S or not acct.connected:
            acct.quota = acct.call("GET", "about", fields="storageQuota").get("storageQuota")
            acct.quota_at = time.time()
        else:
            acct.token()
        acct.connected, acct.error, acct.asked = True, None, False
    except RuntimeError as e:
        if not acct.connected:
            return  # token() recorded it and asked
        log(f"{acct.address}: {e}")
        return
    except (HttpError, TokenError, OSError, ValueError) as e:
        # Google or the network having a bad moment isn't the account dying: try again next time.
        log(f"{acct.address}: {e}")
        return
    report(acct)


def ask_reconnect(acct):
    """Puts connecting a dead account again in the person's queue, once; it closes itself when the account is back."""
    if acct.asked:
        return
    try:
        link = google.consent_url(acct.address)
    except (RuntimeError, OSError) as e:
        log(f"{acct.address}: can't make a link to connect it again ({e}); I'll try next time")
        return
    acct.asked = True
    app.emit("ask", {
        "type": "task",
        "text": (f"Google stopped letting me put files on **{acct.address}**'s Drive ({acct.error}), so I can't share files "
                 "by link from it. Connect it again from any browser, your phone's too: pick that account, then Allow. "
                 "I only ever see the files I put there myself."),
        "assists": [{"label": f"Connect {acct.address}", "url": link}],
        "resolve_when": f'entities | where id == "{acct.entity}" and facts.connected == true',
    }, about=[acct.entity])


def heartbeat():
    live = sorted(a.address for a in accounts.values() if a.connected)
    down = sorted(a.address for a in accounts.values() if not a.connected)
    summary = (f"Uploads to {len(live)} Drive{'s' if len(live) != 1 else ''}: {', '.join(live)}" if live else "No Drive connected yet")
    if down:
        summary += f"; disconnected: {', '.join(down)}"
    app.emit("heartbeat", {"entity": "sense:google-drive", "summary": summary,
                           "facts": {"connected": live, "disconnected": down, "default": state.get("default"),
                                     "checked_at": int(time.time() * 1000)}}, about=["sense:google-drive"])


def loop():
    while True:
        load_accounts()
        for acct in list(accounts.values()):
            check(acct)
        heartbeat()
        wake.wait(HEARTBEAT_S)
        wake.clear()


# Folders: everything goes in Switchboard at the top of the Drive, or a folder within it.


def quoted(name):
    return name.replace("\\", "\\\\").replace("'", "\\'")


def alive(acct, folder_id):
    try:
        return not acct.call("GET", f"files/{folder_id}", fields="id,trashed", supportsAllDrives="true").get("trashed")
    except HttpError as e:
        if e.status == 404:
            return False
        raise


def folder(acct, sub=None):
    """The id of the folder an upload goes in, and its path: made when missing, remembered after."""
    parts = [ROOT] + [p.strip() for p in re.split(r"[/\\]", sub or "") if p.strip()]
    with acct.folder_lock:
        known = state["folders"].setdefault(acct.address, {})
        parent, path = "root", ""
        for part in parts:
            path = f"{path}/{part}" if path else part
            fid = known.get(path)
            if not fid or not alive(acct, fid):
                found = acct.call("GET", "files", q=f"name = '{quoted(part)}' and mimeType = '{FOLDER_MIME}' and '{parent}' in parents "
                                                    "and trashed = false", fields="files(id)", spaces="drive", pageSize=1).get("files", [])
                fid = found[0]["id"] if found else acct.call(
                    "POST", "files", {"name": part, "mimeType": FOLDER_MIME, "parents": [parent]}, fields="id")["id"]
                known[path] = fid
                save_state()
            parent = fid
        return parent, path


# Getting the file here


def run_sb(args, ctx=None, timeout=None):
    """Runs sb, passing what it says on stderr (a transfer's progress) on as the call's progress. Its stdout's JSON."""
    p = subprocess.Popen(["sb", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    err = []

    def relay():
        for line in p.stderr:
            line = line.strip()
            if line:
                err.append(line)
                if ctx:
                    ctx.progress(line)

    t = threading.Thread(target=relay, daemon=True)
    t.start()
    try:
        out = p.stdout.read()
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        raise RuntimeError(f"sb {args[0]} took too long")
    t.join(timeout=5)
    try:
        return p.returncode, json.loads(out) if out.strip() else None, "\n".join(err)
    except ValueError:
        return p.returncode, None, (out + "\n" + "\n".join(err)).strip()


def mac_instance(mac):
    mac = mac.strip()
    return mac if "@" in mac else f"macos@{mac}"


def receive(args, work, ctx):
    """The file or folder to upload, as a local path, and where it came from."""
    path, mac, blob = args.get("path"), args.get("mac"), args.get("blob")
    if blob:
        out = os.path.join(work, safe_name(args.get("name") or "file"))
        code, _, err = run_sb(["blob", "get", blob, "-o", out], timeout=1800)
        if code != 0 or not os.path.exists(out):
            raise ValueError(f"can't fetch {blob}: {err or 'sb blob get failed'}")
        return out, blob
    if not path:
        raise ValueError("give path (on the server, or on the Mac named in mac) or blob")
    if not mac:
        local = os.path.expanduser(path)
        if not os.path.exists(local):
            raise ValueError(f"no such file on {MACHINE}: {path} (for a file on another Mac, say which in mac)")
        return local, f"{MACHINE}:{path}"
    target = mac_instance(mac)
    if target == RECEIVER:  # on this very Mac: read it where it is, no copy
        local = os.path.expanduser(path)
        if not os.path.exists(local):
            raise ValueError(f"no such file on {MACHINE}: {path}")
        return local, f"{MACHINE}:{path}"
    dest = os.path.join(work, safe_name(os.path.basename(path.rstrip("/")) or "upload"))
    ctx.progress(f"Bringing {os.path.basename(path.rstrip('/'))} from {target.split('@')[-1]}")
    code, res, err = run_sb(["request", target, "transfer_file", "--args", json.dumps({"path": path, "to": RECEIVER, "dest": dest}),
                             "--timeout", "1800"], ctx, timeout=1900)
    if not res or not res.get("ok"):
        why = (res or {}).get("error") or err or "no answer"
        raise ValueError(f"couldn't bring {path} from {target}: {why}")
    written = (res.get("output") or {}).get("written") or {}
    local = written.get("path") or dest
    if not os.path.exists(local):
        raise ValueError(f"{target} said it sent {path}, but nothing arrived at {local}")
    return local, f"{target.split('@')[-1]}:{path}"


def safe_name(name):
    name = os.path.basename(name.strip().replace("\\", "/").rstrip("/")) or "file"
    return name if name not in (".", "..") else "file"


def zipped(folder_path, work, name=None):
    """A folder as one zip, its files under the folder's name; macOS's ._ files and .DS_Store left out."""
    base = os.path.basename(folder_path.rstrip("/")) or "folder"
    out = os.path.join(work, safe_name(name or base + ".zip"))
    if not out.lower().endswith(".zip"):
        out += ".zip"
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(folder_path):
            dirs[:] = sorted(d for d in dirs if d != "__MACOSX")
            for f in sorted(files):
                if f.startswith("._") or f == ".DS_Store":
                    continue
                full = os.path.join(root, f)
                z.write(full, os.path.join(base, os.path.relpath(full, folder_path)))
                count += 1
    if not count:
        raise ValueError(f"{base} has no files in it")
    return out


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# Uploading, resumably: https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable


def start_session(acct, meta, mime, size):
    res = http("POST", UPLOAD, acct.token(), meta, {"uploadType": "resumable", "fields": FILE_FIELDS, "supportsAllDrives": "true"},
               {"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size)}, raw=True)
    location = res.headers.get("Location")
    res.close()
    if not location:
        raise RuntimeError("Drive didn't open an upload session")
    return location


def put(session, data, start, size):
    """Sends bytes from `start` (or, with none, asks where the upload stands). Its status, Range header and body."""
    u = urllib.parse.urlsplit(session)
    conn = (httpclient.HTTPSConnection if u.scheme == "https" else httpclient.HTTPConnection)(u.netloc, timeout=120)
    headers = {"Content-Length": str(len(data)),
               "Content-Range": f"bytes {start}-{start + len(data) - 1}/{size}" if data else f"bytes */{size}"}
    try:
        conn.request("PUT", u.path + (f"?{u.query}" if u.query else ""), body=data, headers=headers)
        res = conn.getresponse()
        return res.status, res.getheader("Range"), res.read()
    finally:
        conn.close()


def upto(rng):
    """The next byte Drive wants, from a 308's Range header (bytes=0-N); none received is 0."""
    return int(rng.rsplit("-", 1)[1]) + 1 if rng else 0


def send_bytes(acct, local, meta, mime, ctx):
    size = os.path.getsize(local)
    for _ in range(3):
        session = start_session(acct, meta, mime, size)
        offset, failures = 0, 0
        with open(local, "rb") as f:
            while True:
                if ctx.cancelled.is_set():
                    raise RuntimeError("cancelled before the upload finished")
                f.seek(offset)
                data = f.read(CHUNK) if offset < size else b""
                try:
                    status, rng, body = put(session, data, offset, size)
                except (OSError, httpclient.HTTPException) as e:
                    status, rng, body = None, None, str(e).encode()
                if status in (200, 201):
                    return json.loads(body)
                if status == 308:
                    offset, failures = upto(rng), 0
                    ctx.progress(f"Uploaded {human(offset)} of {human(size)}")
                    continue
                if status in (404, 410):
                    log(f"upload session for {meta['name']} expired at {human(offset)}; starting a new one")
                    break
                if status is not None and status not in RETRY:
                    raise HttpError(status, body.decode(errors="replace"))
                failures += 1
                if failures > 6:
                    raise RuntimeError(f"Drive kept failing at {human(offset)} of {human(size)}: {body[:200].decode(errors='replace')}")
                time.sleep(min(2 ** failures, 30))
                try:  # ask where it got to before sending more
                    status, rng, body = put(session, b"", None, size)
                    if status in (200, 201):
                        return json.loads(body)
                    if status == 308:
                        offset = upto(rng)
                except (OSError, httpclient.HTTPException):
                    pass
    raise RuntimeError("Drive's upload session kept expiring")


# Sharing


def link_on(acct, file_id):
    try:
        acct.call("POST", f"files/{file_id}/permissions", {"type": "anyone", "role": "reader", "allowFileDiscovery": False},
                  supportsAllDrives="true", fields="id")
    except HttpError as e:
        if e.status == 403:
            raise RuntimeError(f"{acct.address}'s Drive won't share by link ({e.reason}: {e.message}); a Workspace's sharing "
                               "policy may keep files inside its domain") from None
        raise


def link_off(acct, file_id):
    try:
        acct.call("DELETE", f"files/{file_id}/permissions/anyoneWithLink", supportsAllDrives="true")
    except HttpError as e:
        if e.status != 404:
            raise


def signed_out_view(file_id, name):
    """One look at the file's link as a stranger would: no cookies, no account. True when Drive shows the file, False
    when it asks to sign in or refuses (Drive answers a closed link with a sign-in redirect or a 401), None when Drive
    couldn't be reached."""
    url = f"{VIEW}/file/d/{file_id}/view"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER, "Accept-Language": "en"})
        with urllib.request.urlopen(req, timeout=30) as res:
            host = urllib.parse.urlsplit(res.geturl()).netloc
            page = res.read(400_000).decode(errors="replace")
            return res.status == 200 and "accounts.google.com" not in host and (
                name in page or html.escape(name) in page or json.dumps(name)[1:-1] in page)
    except urllib.error.HTTPError as e:
        return False if e.code in (401, 403, 404) else None
    except (urllib.error.URLError, TimeoutError, ConnectionError, httpclient.HTTPException):
        return None


def signed_out_download(file_id):
    """One signed-out try of the file's download link: True when Drive serves it (or its large-file warning), False
    when it sends a stranger to sign in or refuses, None when Drive couldn't be reached. Reads none of the file."""
    try:
        req = urllib.request.Request(f"{VIEW}/uc?id={file_id}&export=download", headers={"User-Agent": BROWSER})
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status == 200 and "accounts.google.com" not in urllib.parse.urlsplit(res.geturl()).netloc
    except urllib.error.HTTPError as e:
        return False if e.code in (401, 403, 404) else None
    except (urllib.error.URLError, TimeoutError, ConnectionError, httpclient.HTTPException):
        return None


def opens_signed_out(file_id, name):
    """Whether the link opens the file signed out, looked at until it does (sharing takes a moment to reach the link)
    or six looks pass: True, False as last seen, or None if Drive was never reachable."""
    seen = None
    for attempt in range(6):
        seen = signed_out_view(file_id, name)
        if seen:
            return True
        time.sleep(2 + attempt * 2)
    return seen


def closes_signed_out(file_id, name):
    """Whether a link taken down has stopped opening the file for a stranger: its page and its download both refuse,
    on two looks in a row. Google's servers catch up at their own pace (a page stayed open for under a minute after
    the download closed, Nov 13), so it looks for about a minute: True, False if it still opened at the last look, or
    None if Drive was never reachable."""
    streak, seen = 0, None
    for attempt in range(8):
        looks = (signed_out_view(file_id, name), signed_out_download(file_id))
        seen = None if None in looks else not any(looks)
        streak = streak + 1 if seen else 0
        if streak == 2:
            return True
        time.sleep(3 + attempt * 2)
    return seen


def file_id_of(file):
    """A file's id from its id, its drive-file:<id> entity, or any Drive link to it."""
    file = (file or "").strip()
    m = re.search(r"/d/([A-Za-z0-9_-]{10,})", file) or re.search(r"[?&]id=([A-Za-z0-9_-]{10,})", file)
    if m:
        return m.group(1)
    file = file.removeprefix("drive-file:")
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,}", file):
        raise ValueError(f"not a Drive file id or link: {file}")
    return file


def describe(acct, f, extra=None):
    shared = "anyoneWithLink" in (f.get("permissionIds") or [])
    return {
        "file_id": f["id"], "entity": f"drive-file:{f['id']}", "name": f.get("name"), "size": int(f.get("size") or 0),
        "account": acct.address, "link": f.get("webViewLink") or f"{VIEW}/file/d/{f['id']}/view",
        "download": f.get("webContentLink"), "shared": "anyone with the link" if shared else "private",
        "md5": f.get("md5Checksum"), "created": f.get("createdTime"), **(extra or {}),
    }


def observe(acct, facts, about=()):
    entity = facts["entity"]
    where = f" in {facts['folder']}" if facts.get("folder") else ""
    summary = (f"{facts['name']} ({human(facts['size'])}) on {acct.address}'s Drive{where}, "
               + ("shared with anyone who has the link" if facts["shared"] != "private" else "private"))
    app.emit("file", {"entity": entity, "summary": summary, "facts": {k: v for k, v in facts.items() if k != "entity"}},
             about=list(dict.fromkeys([entity, acct.entity, *about])))


def get_file(acct, file_id):
    try:
        return acct.call("GET", f"files/{file_id}", fields=FILE_FIELDS, supportsAllDrives="true")
    except HttpError as e:
        if e.status == 404:
            raise ValueError(f"no file {file_id} that I can reach on {acct.address}'s Drive: I only see files I uploaded "
                             "myself (scope drive.file)") from None
        raise


# Actions


def upload(ctx=None, path=None, mac=None, blob=None, name=None, account=None, folder_name=None, link=True, about=None,
           description=None):
    acct = find_account(account)
    work = os.path.join(HOME, "incoming", uuid.uuid4().hex)
    os.makedirs(work, mode=0o700)
    try:
        local, source = receive({"path": path, "mac": mac, "blob": blob, "name": name}, work, ctx)
        if os.path.isdir(local):
            ctx.progress(f"Zipping {os.path.basename(local.rstrip('/'))}")
            local = zipped(local, work, name)
            title = os.path.basename(local)
        else:
            title = safe_name(name or os.path.basename(local))
        size = os.path.getsize(local)
        mime = mimetypes.guess_type(title)[0] or "application/octet-stream"
        parent, where = folder(acct, folder_name)
        meta = {"name": title, "parents": [parent], **({"description": description} if description else {})}
        ctx.progress(f"Uploading {title} ({human(size)}) to {acct.address}'s Drive")
        f = send_bytes(acct, local, meta, mime, ctx)
        local_md5 = md5_of(local)
        if f.get("md5Checksum") and f["md5Checksum"] != local_md5:
            acct.call("PATCH", f"files/{f['id']}", {"trashed": True}, supportsAllDrives="true")
            raise RuntimeError(f"Drive's copy of {title} doesn't match what I sent (MD5 {f['md5Checksum']} vs {local_md5}); I trashed it")
        signed_out = None
        if link:
            ctx.progress("Sharing it by link")
            link_on(acct, f["id"])
            f = get_file(acct, f["id"])
            ctx.progress("Opening the link signed out")
            signed_out = opens_signed_out(f["id"], title)
        facts = describe(acct, f, {"folder": where, "source": source, "md5_verified": True, "opens_signed_out": signed_out,
                                   "uploaded_at": int(time.time() * 1000), "for_work": ctx.work})
        observe(acct, facts, [about] if isinstance(about, str) else about or ())
        out = {k: facts[k] for k in ("link", "download", "name", "size", "account", "folder", "shared", "opens_signed_out",
                                     "md5_verified", "file_id", "entity")}
        if link and not signed_out:
            out["warning"] = "Sharing is on, but the link didn't open signed out when I tried: check it before sending it"
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def share(ctx=None, file=None, link=True, account=None):
    acct = find_account(account)
    fid = file_id_of(file)
    f = get_file(acct, fid)
    if link:
        link_on(acct, fid)
    else:
        link_off(acct, fid)
    f = get_file(acct, fid)
    checked = ({"opens_signed_out": opens_signed_out(fid, f["name"])} if link else
               {"link_closed": closes_signed_out(fid, f["name"])})
    facts = describe(acct, f, checked)
    observe(acct, facts)
    out = {k: facts[k] for k in ("link", "download", "name", "account", "shared", "file_id")} | checked
    if True not in checked.values():
        out["warning"] = ("Sharing is on, but the link didn't open signed out when I tried" if link else
                          "The link is off, but I couldn't confirm signed out that it stopped opening") + ": check it by hand"
    return out


def trash(ctx=None, file=None, account=None):
    acct = find_account(account)
    fid = file_id_of(file)
    f = get_file(acct, fid)
    # Drive keeps serving a trashed file to anyone with its link until it's deleted for good, so the link comes off first.
    link_off(acct, fid)
    acct.call("PATCH", f"files/{fid}", {"trashed": True}, supportsAllDrives="true", fields="id")
    app.emit("file.gone", {"entity": f"drive-file:{fid}"}, about=[f"drive-file:{fid}", acct.entity])
    closed = closes_signed_out(fid, f["name"]) is True
    return {"trashed": f["name"], "file_id": fid, "account": acct.address, "link_closed": closed,
            **({"note": "Its link is taken down (its page and its download both refuse a signed-out visitor) and it's "
                        "in the Drive's trash, which Drive empties after 30 days."} if closed else
               {"warning": "It's in the Drive's trash with its link taken down, but I couldn't confirm signed out "
                           "that the link is closed: check it by hand"})}


def files(account=None, limit=25, query=None):
    acct = find_account(account)
    q = f"trashed = false and mimeType != '{FOLDER_MIME}'"
    if query:
        q += f" and name contains '{quoted(query)}'"
    got = acct.call("GET", "files", q=q, orderBy="createdTime desc", pageSize=min(int(limit), 100),
                    fields=f"files({FILE_FIELDS})", spaces="drive", supportsAllDrives="true", includeItemsFromAllDrives="true")
    return [{k: d[k] for k in ("name", "size", "link", "shared", "created", "file_id")} for d in
            (describe(acct, f) for f in got.get("files", []))]


def list_accounts():
    load_accounts()
    out = []
    for acct in accounts.values():
        check(acct)
        q = acct.quota or {}
        out.append({"address": acct.address, "connected": acct.connected, "error": acct.error,
                    "default": state.get("default") == acct.address or len(accounts) == 1,
                    "storage_used": int(q["usage"]) if q.get("usage") else None,
                    "storage_limit": int(q["limit"]) if q.get("limit") else None})
    return out


def connect(address=None, default=False):
    url = google.consent_url(address)
    with lock:
        started = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["state"][0]
        state.setdefault("make_default", {})[started] = bool(default)
        save_state()
    opens = OPENS if SWITCH else "Opens in any browser, a phone's included: Google comes back to Switchboard's own callback, which finishes it."
    return {"url": url, "note": opens + " It asks only to add files to the Drive and see the ones it added."}


def finish(code=None, state=None, redirect_uri=None):
    states = globals()["state"]
    t = google.finish({"code": code, "state": state, "redirect_uri": redirect_uri},
                      "Drive access wasn't granted: start again from Switchboard and allow Switchboard to add files to your Drive.")
    about = http("GET", f"{API}/about", t["access_token"], params={"fields": "user(emailAddress),storageQuota"})
    address = about["user"]["emailAddress"]
    google.keep(address, t)
    with lock:
        acct = accounts.get(address) or Account(address)
        acct.access_token, acct.expires_at = t["access_token"], time.time() + t.get("expires_in", 3600)
        acct.connected, acct.error, acct.asked = True, None, False
        acct.quota, acct.quota_at = about.get("storageQuota"), time.time()
        accounts[address] = acct
        wanted = states.get("make_default", {}).pop(state or "", False)
        if wanted or not states.get("default"):
            states["default"] = address
        save_state()
    for other in accounts.values():
        report(other, force=True)
    wake.set()
    return {"address": address, "connected": True,
            "note": "I can put files on this Drive and share them by link now. I only ever see the files I put there myself, "
                    "in its Switchboard folder. You can close this tab."}


ACCOUNT = {"type": "string", "description": "Which connected Drive, like me@example.com (default: the default one; see accounts)."}
FILE = {"type": "string", "description": "The file: its id, its drive-file:<id> entity, or its link."}

app.tool(upload, name="upload", description=(
    "Put a file or folder on the user's Google Drive and get back a link anyone with it can open, in one step: from a path on "
    "a Mac (mac and path: that Mac sends it to the server first, so it must be awake), a path on the server, or a blob. "
    "A folder goes up as one zip. It lands in the Drive's Switchboard folder (or folder within it), resumably, and is "
    "checked byte for byte (MD5). With link (the default) it's shared view-only with anyone who has the link (not "
    "findable), and the link is opened signed out to prove it works before it's returned: opens_signed_out says so. "
    "Nobody is told: the link goes only where you send it, with the user's approval when it goes to someone in his name."),
    schema={"type": "object", "properties": {
        "path": {"type": "string", "description": "The file or folder: a path on the Mac named in mac, or on the server without it."},
        "mac": {"type": "string", "description": "The Mac it's on, like laptop (or macos@laptop). Leave out for a path on the server."},
        "blob": {"type": "string", "description": "Or a blob already stored (sha256:...), with name."},
        "name": {"type": "string", "description": "Its name on Drive (default: the file's own; a folder's is <folder>.zip)."},
        "account": ACCOUNT,
        "folder_name": {"type": "string", "description": "A folder inside Switchboard to put it in, like Clients/Acme (made when missing)."},
        "link": {"type": "boolean", "description": "Share it with anyone who has the link (default true); false keeps it private."},
        "about": {"type": "array", "items": {"type": "string"}, "description": "Entities it's for, like ws:shop, put on its drive-file record."},
        "description": {"type": "string", "description": "A note on the file in Drive."},
    }}, open_world=True)
app.tool(share, name="share", description=(
    "Turn a file's link on (anyone with it can view) or off (link: false: only the user again), checked signed out either "
    "way. Only for files this tool uploaded."), schema={"type": "object", "properties": {
        "file": FILE, "link": {"type": "boolean", "description": "true to share by link (default), false to take the link down."},
        "account": ACCOUNT}, "required": ["file"]}, open_world=True)
app.tool(trash, name="trash", description=(
    "Take a file this tool uploaded off its link and put it in the Drive's trash (which Drive empties after 30 days), "
    "then check signed out that the link no longer opens it."),
    schema={"type": "object", "properties": {"file": FILE, "account": ACCOUNT}, "required": ["file"]}, destructive=True)
app.tool(files, name="files", description="What this tool has put on a Drive, newest first: name, size, link and whether it's shared.",
         schema={"type": "object", "properties": {
             "account": ACCOUNT, "query": {"type": "string", "description": "Words in the file's name."},
             "limit": {"type": "integer", "description": "Default 25, at most 100."}}}, read_only=True)
app.tool(list_accounts, name="accounts", description="The connected Drives: which is the default, whether each still works, and its storage.",
         schema={"type": "object", "properties": {}}, read_only=True)
app.tool(connect, name="connect", description=(
    "Start connecting a Google account's Drive (scope drive.file: it adds files and sees only those): returns the consent "
    "URL; resolve_when on drive-account:<account with non-alphanumerics as hyphens, like me-example-com> having "
    "facts.connected == true. "
    + (CONNECT if SWITCH else "Google sends the browser back to Switchboard's own callback, which finishes it.")),
    schema={"type": "object", "properties": {
        "address": {"type": "string", "description": "The account to suggest on Google's chooser."},
        "default": {"type": "boolean", "description": "Make it the default Drive once connected (the first one is anyway)."}}})
app.tool(finish, name="finish", description="Finish a consent with the code Google sent back. The core's OAuth callback calls this.",
         schema={"type": "object", "properties": {"code": {"type": "string"}, "state": {"type": "string"},
                                                  "redirect_uri": {"type": "string"}}, "required": ["code", "state"]})
app.background(loop)

