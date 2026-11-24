"""google-oauth: sets up Switchboard's Google appendages on the shared OAuth client, and connects their accounts with
one approval of the user's.

Every Google appendage (gmail, google-calendar, google-drive, google-sheets, and whatever comes next) signs in through
the same Web OAuth client of the user's own Google Cloud project, whose consent grants come back
through the core's /oauth/callback to the appendage's own `finish`. Each keeps that client in its SB_HOME's
secrets.json (`oauth-client`) and its accounts' refresh tokens beside it, through the same google_oauth.py. Setting
one up used to be done by hand every time: copy the module and the client's secret over, enable the API in the Cloud
console, call its connect, walk Google's pages in the Mac mini's Chrome, and put the card up. This does it in one step:

- `setup(appendage, apis, address)`: gives an appendage on this server the shared client (written straight into its
  secrets.json, never through a record), enables its APIs in the Cloud project (the console in the Mac mini's Chrome,
  as the user), and with an address, connects it (`connect`).
- `connect(appendage, address)`: calls the appendage's own connect, drives Google's sign-in and consent up to the
  last page (boxes ticked, Continue unpressed), holds that tab and puts one approval in the user's queue whose Approve
  runs `grant` (Continue pressed, the account checked connected). A step only he can take on the way (a passkey, a
  prompt on his phone) goes up as a card with the tab live on it. The card closes itself once the account is in.
- `kit(folder)`: the shared google_oauth.py and how to wire a new Google appendage to it.
- `status`: the client, every Google appendage here (has the client, its google_oauth.py current or not), their
  accounts, and the connects waiting on the user.

Secrets never touch the log: the client lives in this appendage's SB_HOME (client.json) and in each appendage's own
secrets.json; only fingerprints (the first 12 of a SHA-256) are said.

In Switch there are no appendages to set up: Gmail, Drive and Sheets are parts of this extension, and calendar and
contacts are extensions of their own, all on the user's Google connections. A consent is the core's (its Desktop client,
PKCE, Switch's loopback redirect: google_oauth's `relay`), so the Web client in client.json is optional: it names the
Cloud project the console pages open, and status says what it has.
"""

import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse

import consent
import sbmcp
import server
from server import part, home as home_of

NAME = "google"
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = home_of("oauth")
"""Where it keeps what lasts between runs, and its secrets: its keeper's SB_HOME, or .home by hand."""
INSTANCE = os.environ.get("SB_INSTANCE") or f"{NAME}@local"
HOST = INSTANCE.split("@", 1)[1]
"""The machine it runs on, whose Google appendages it sets up: it writes their homes, on this machine's disk."""
SWITCH = bool(os.environ.get("SWITCH_MACHINE"))
"""Run by Switch: its Google parts and extensions are on the user's connections, consents come back through
google_oauth's relay."""
KEEPER = os.environ.get("GOOGLE_OAUTH_KEEPER") or (f"macos@{HOST}" if sys.platform == "darwin" else f"server@{HOST}")
"""In Switchboard, that machine's keeper, which listed them with their homes."""
HEARTBEAT_S = float(os.environ.get("GOOGLE_OAUTH_HEARTBEAT_S") or 600)
"""How often it says how it is, in vitals/google-oauth: what --health-every 1800000 promises (with room)."""
WATCH_S = float(os.environ.get("GOOGLE_OAUTH_WATCH_S") or 60)
"""How often it looks at the connects waiting on the user: connected, declined, or lapsed."""
SEED_FILES = [p for p in (os.environ.get("GOOGLE_OAUTH_CLIENT_FILE"),) if p]
"""Where the shared client may come from the first time, when client.json isn't there yet."""
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
"""The Cloud project, when there's no client.json to name it."""
OWNER = os.environ.get("GOOGLE_CLOUD_OWNER") or "me@example.com"
"""The Google account that owns the Cloud project, which the console is opened as."""
MAC = os.environ.get("GOOGLE_OAUTH_MAC") or "local"
"""The Mac whose Chrome drives Google's pages: always awake, signed in to the user's Google accounts."""
HOLD_HOURS = 72
"""How long a connect waits on the user, its tab held all the while."""
KIT = os.path.join(HERE, "kit", "google_oauth.py")
CLIENT_PATH = os.path.join(HOME, "client.json")
CONNECTS_PATH = os.path.join(HOME, "connects.json")

API_ALIASES = {
    "sheets": "sheets.googleapis.com", "drive": "drive.googleapis.com", "gmail": "gmail.googleapis.com",
    "calendar": "calendar-json.googleapis.com", "docs": "docs.googleapis.com", "slides": "slides.googleapis.com",
    "forms": "forms.googleapis.com", "tasks": "tasks.googleapis.com", "people": "people.googleapis.com",
    "contacts": "people.googleapis.com", "youtube": "youtube.googleapis.com", "photos": "photoslibrary.googleapis.com",
    "keep": "keep.googleapis.com", "meet": "meet.googleapis.com", "chat": "chat.googleapis.com",
    "analytics": "analyticsdata.googleapis.com", "search-console": "searchconsole.googleapis.com",
    "searchconsole": "searchconsole.googleapis.com", "business-profile": "mybusinessbusinessinformation.googleapis.com",
    "ads": "googleads.googleapis.com", "fitness": "fitness.googleapis.com", "drive-activity": "driveactivity.googleapis.com",
}
"""Short names for the APIs a Google appendage usually needs; anything else is given as its service name."""
PRODUCTS = {"gmail": "Gmail", "calendar": "Google Calendar", "drive": "Google Drive", "sheets": "Google Sheets",
            "docs": "Google Docs", "slides": "Google Slides", "forms": "Google Forms", "tasks": "Google Tasks",
            "photos": "Google Photos", "youtube": "YouTube", "contacts": "Google Contacts", "meet": "Google Meet"}

app = part("oauth", {"connect": "oauth_connect", "discard": "oauth_discard"}, shared={"connect", "discard"})
app.event("ask", "A Google account to connect: an approval whose Approve presses Google's Continue, or a step only the user can take", stream="asks", kind="ask")
app.event("ask.resolved", "A connect's card that isn't needed anymore, closed", stream="asks", kind="resolved")
app.event("connect", "A Google account connect: waiting on the user, connected, declined or lapsed", stream="google/oauth", kind="observation")
app.event("setup", "A Google appendage set up: the shared client given, its APIs enabled", stream="google/oauth", kind="observation")
app.event("heartbeat", "How it is itself: the client, the Google appendages, the connects waiting", stream=f"vitals/{NAME}", kind="observation", retention="signal")

state = {"started_at": int(time.time() * 1000), "calls": 0, "failed": 0, "last_error": None, "last_setup": None, "last_connect": None}
lock = threading.RLock()


# The world outside, in one place: its tests put fakes here.

def ask(target, action, args, timeout_s=60):
    """An appendage's action: its output, or consent.Failed."""
    return consent.request(target, action, args, timeout_s)


def query(q):
    """The brain's rows for a query, as this appendage may read them."""
    r = subprocess.run(["sb", "query", q], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"sb query: {(r.stderr or r.stdout).strip()[-300:]}")
    return json.loads(r.stdout).get("rows", [])


def callback():
    """Where every consent comes back to: in Switch, the loopback redirect this process serves (google_oauth's relay);
    in Switchboard, the core's public /oauth/callback."""
    if SWITCH:
        import google_oauth  # noqa: PLC0415
        return google_oauth.relay.url()
    r = subprocess.run(["sb", "whoami"], capture_output=True, text=True, timeout=30)
    url = json.loads(r.stdout).get("oauth_callback") if r.returncode == 0 else None
    if not url:
        raise RuntimeError("this install has no public address for consent grants to come back to (sb whoami has no oauth_callback)")
    return url


def tab_for(mac, session):
    return consent.Tab(mac, session, ask=ask)


def log(*words):
    app.log(*words)


# Small things

def new_id():
    """A record id as the core makes them: the time in ms, then random."""
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(10)}"


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def fingerprint(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def write_private(path, data):
    """Writes a file only its owner can read, all at once."""
    fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)
    os.replace(path + ".new", path)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def name_of(appendage):
    """An appendage's name on this machine: google-sheets, google-sheets@<this machine>, or a tool's name for it."""
    a = (appendage or "").strip()
    a = re.sub(r"^mcp__brain__", "", a).split("__")[0]
    if "@" in a:
        a, where = a.split("@", 1)
        if where != HOST:
            raise ValueError(f"{appendage} runs on {where}, not here: google-oauth sets up the Google appendages on its "
                             f"own machine ({HOST}), whose homes it writes.")
    a = re.sub(r"-" + re.escape(HOST) + "$", "", a)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", a):
        raise ValueError(f"not an appendage's name: {appendage!r}")
    return a


def kind_of(name):
    """What its accounts are called: google-sheets keeps sheets-account:<address> in sheets/accounts."""
    return re.sub(r"^google-", "", name)


def product_of(name):
    k = kind_of(name)
    return PRODUCTS.get(k) or ("Google " + " ".join(w.capitalize() for w in k.split("-")))


def api_of(name):
    n = (name or "").strip().lower()
    n = API_ALIASES.get(n, n)
    if "." not in n:
        n = f"{n}.googleapis.com"
    if not re.fullmatch(r"[a-z0-9.-]+\.googleapis\.com", n):
        raise ValueError(f"not a Google API's service name: {name!r} (like sheets.googleapis.com)")
    return n


# The shared client

def client_text():
    """The shared Web OAuth client as its JSON text: this appendage's own copy, seeded once from the core's."""
    try:
        with open(CLIENT_PATH) as f:
            return f.read()
    except FileNotFoundError:
        pass
    for path in SEED_FILES:
        try:
            with open(path) as f:
                text = f.read()
        except OSError:
            continue
        json.loads(text)
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        write_private(CLIENT_PATH, text)
        log(f"took the shared client from {path} (fingerprint {fingerprint(text)})")
        return text
    raise RuntimeError(f"no shared Google OAuth client: put the Web client's JSON (from Google Cloud) in {CLIENT_PATH}, mode 600")


def client():
    c = json.loads(client_text())
    return c.get("web") or c.get("installed") or c


def project():
    """The Cloud project: the Web client's, or GOOGLE_CLOUD_PROJECT's."""
    try:
        return client().get("project_id") or PROJECT
    except RuntimeError:
        if PROJECT:
            return PROJECT
        raise


def core(app_name, tool, args):
    """One of the core's apps (connections, extensions), as an extension may call it."""
    from authorize import private  # noqa: PLC0415  (authorize imports mail, which imports google_oauth)
    return private(app_name, tool, args)


def client_facts():
    """What can be said of the clients: never a secret. In Switch, the core's (connections/readiness: their kinds and
    redirects) and whether one takes Switch's loopback redirect (a Desktop client); the Web client, when kept."""
    facts = {"owner": OWNER}
    try:
        text, c = client_text(), client()
        facts.update({"project": c.get("project_id"), "client_id": c.get("client_id"), "fingerprint": fingerprint(text),
                      "redirect_uris": c.get("redirect_uris", [])})
    except RuntimeError as e:
        if not SWITCH:
            raise
        facts.update({"project": PROJECT, "client_id": None, "fingerprint": None, "redirect_uris": [], "web_client": str(e)})
    try:
        facts["callback"] = callback()
        if SWITCH:
            clients = core("connections", "readiness", {"provider": "google"}).get("clients", [])
            facts["core_clients"] = clients
            facts["callback_registered"] = any(k.get("kind") == "installed" for k in clients)
        else:
            facts["callback_registered"] = facts["callback"] in facts["redirect_uris"]
    except (RuntimeError, OSError, ValueError) as e:
        facts["callback"], facts["callback_registered"] = None, False
        facts["callback_error"] = str(e)
    return facts


# The Google appendages on this machine

PARTS = {"gmail": ("gmail", "gmail_connect"), "google-calendar": ("calendar", "calendar_connect"),
         "google-drive": ("drive", "drive_connect"), "google-sheets": ("sheets", "sheets_connect")}
"""The Google appendages that are parts of this one now: their old names, their homes under $SB_HOME, their connects."""


def appendages():
    """Every appendage this machine keeps, as its keeper lists them (name, instance, home, folder, code...), with this
    one's parts (google-calendar, google-drive, google-sheets) listed as the appendages they were: each its own home,
    connected through its own connect action here. In Switch, only the parts: the other extensions on Google
    connections are in status' connections."""
    if SWITCH:
        items = []
    else:
        out = ask(KEEPER, "appendages", {}, 30)
        items = out.get("appendages", out) if isinstance(out, dict) else out
    found = [a for a in items if isinstance(a, dict) and a.get("name") and a["name"] not in PARTS]
    mine = next((a for a in found if a["name"] == NAME), None)
    folder = (mine or {}).get("folder") or os.path.dirname(HERE)
    for name, (product, action) in PARTS.items():
        found.append({"name": name, "instance": INSTANCE, "home": os.path.join(server.HOME, product), "folder": folder,
                      "part_of": INSTANCE, "connect_action": action})
    return found


def code_folder(a):
    if a.get("part_of"):
        return HERE
    folder = a.get("folder") or os.path.dirname(a.get("home") or "")
    return os.path.join(folder, "code")


def kit_sha():
    with open(KIT, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def is_google(a):
    """A Google appendage: one whose code has google_oauth.py, or named for Google (gmail, google-*). Only those are
    looked into: another appendage's secrets are none of this one's business."""
    if a["name"] == NAME:
        return False
    return a["name"] == "gmail" or a["name"].startswith("google-") or os.path.exists(os.path.join(code_folder(a), "google_oauth.py"))


def look_at(a):
    """One appendage as a Google appendage: whether it has the shared client, and its google_oauth.py."""
    if not is_google(a):
        return {"name": a["name"], "instance": a.get("instance"), "google": False}
    secrets_path = os.path.join(a["home"], "secrets.json")
    stored = read_json(secrets_path, {}) if os.path.exists(secrets_path) else {}
    had = stored.get("oauth-client")
    mod = os.path.join(code_folder(a), "google_oauth.py")
    module = None
    if os.path.exists(mod):
        with open(mod, "rb") as f:
            module = "current" if hashlib.sha256(f.read()).hexdigest() == kit_sha() else "older"
    return {
        "name": a["name"], "instance": a.get("instance"),
        "google": True,
        "client": "shared" if had and fingerprint(had) == fingerprint(client_text()) else ("other" if had else "none"),
        "google_oauth_py": module or "none",
        "accounts_stored": len([k for k in stored if "@" in k]),
    }


def accounts_of(name):
    """Its accounts as the brain has them (<kind>-account:<address>): address, connected and the rest."""
    try:
        rows = query(f'entities | where id startswith "{kind_of(name)}-account:" | project id, facts')
    except RuntimeError:
        return None
    out = []
    for r in rows:
        f = r.get("facts") or {}
        out.append({"id": r["id"], "address": f.get("address"), "connected": f.get("connected"),
                    **{k: f[k] for k in ("scope", "access", "can_send", "error", "default") if f.get(k) is not None}})
    return out


def find(name):
    if name == NAME:
        raise ValueError(f"{NAME} has four Google parts, each connected on its own: gmail, google-calendar, google-drive "
                         "or google-sheets: say which")
    for a in appendages():
        if a["name"] == name:
            if not is_google(a):
                raise ValueError(f"{name} isn't a Google appendage (its code has no google_oauth.py, and it isn't gmail or "
                                 "google-*): kit gives it the module first")
            return a
    raise ValueError(f"no appendage {name} on this machine ({KEEPER}'s appendages lists them): install it "
                     f"first (kit gives a new one the shared google_oauth.py)")


def provision(a, dry_run=False):
    """Gives the appendage the shared client: `oauth-client` in its SB_HOME's secrets.json, mode 600, written here and
    read back, its accounts' tokens left as they are."""
    path = os.path.join(a["home"], "secrets.json")
    text = client_text()
    with lock:
        stored = read_json(path, {})
        had = stored.get("oauth-client")
        if had == text:
            return {"client": "already", "note": "it had the shared client already"}
        what = "replaced" if had else "written"
        if dry_run:
            return {"client": f"would_be_{what}", "note": f"its secrets.json would get the shared client ({fingerprint(text)})"
                    + (f", in place of the one it has ({fingerprint(had)})" if had else "")}
        os.makedirs(a["home"], mode=0o700, exist_ok=True)
        write_private(path, json.dumps({**stored, "oauth-client": text}))
        if read_json(path, {}).get("oauth-client") != text:
            raise RuntimeError(f"wrote the client into {path} but it didn't read back")
    return {"client": what, "note": f"its secrets.json has the shared client now ({fingerprint(text)})"
            + (f", in place of {fingerprint(had)}" if had else "")}


# Enabling APIs

def enable(apis, dry_run=False, mac=None, progress=lambda m: None):
    """Each API enabled in the Cloud project, through its console page in the Mac's Chrome."""
    cloud = project()
    if not cloud:
        raise RuntimeError("the shared client names no project_id")
    tab = tab_for(mac or MAC, "google-oauth-console")
    out = []
    try:
        for api in apis:
            out.append(consent.console_api(tab, api_of(api), cloud, OWNER, time.time() + 90, dry_run, progress))
    finally:
        tab.release()
    return out


# Connecting an account

def connects():
    return read_json(CONNECTS_PATH, {})


def keep_connect(cid, info):
    with lock:
        stored = connects()
        if info is None:
            stored.pop(cid, None)
        else:
            stored[cid] = info
        os.makedirs(HOME, mode=0o700, exist_ok=True)
        write_private(CONNECTS_PATH, json.dumps(stored))


def done_query(name, address, given=None, require=None, entity=None):
    """The query that finds the account connected (with what's required of it): the card's resolve_when."""
    if entity:
        q = f'entities | where id == "{entity}" and facts.connected == true'
    elif given:
        q = given
    else:
        q = f'entities | where id == "{kind_of(name)}-account:{slug(address)}" and facts.connected == true'
    for k, v in (require or {}).items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            raise ValueError(f"not a fact's name: {k!r}")
        q += f" and facts.{k} == {json.dumps(v)}"
    return q


def found(q):
    """Whether the query finds anything now; None when it can't be read from here."""
    try:
        return bool(query(q))
    except RuntimeError:
        return None


def ask_open(ask_id):
    try:
        return bool(query(f'asks | where id == "{ask_id}" and open | project id'))
    except RuntimeError:
        return True  # Can't tell: better to wait on than to drop it.


def consent_url(c):
    """A fresh consent link from the appendage's own connect, with its resolve_when when it gives one."""
    action = c.get("connect_action") or "connect"
    args = {**(c.get("args") or {}), "address": c["address"]}
    if c["instance"] == INSTANCE and action in server.local:
        out = server.local[action](**args)  # one of this appendage's own parts: called here, not through a request to itself
    else:
        out = ask(c["instance"], action, args, 60)
    if isinstance(out, str):
        m = re.search(r"https://accounts\.google\.com/\S+", out)
        return (m.group(0) if m else out.strip()), None
    url = out.get("url") or out.get("consent_url") or out.get("link")
    if not url:
        raise RuntimeError(f"{c['instance']} connect gave no consent URL: {json.dumps(out)[:300]}")
    return url, out.get("resolve_when")


def card(c, outcome, shot, replaces=None):
    """The card for the user: an approval whose Approve runs grant (the page is ready), or a task with the tab live on it
    (a step only he can take). Its resolve_when closes it once the account is connected."""
    product, address = product_of(c["name"]), c["address"]
    why = (c.get("why") or "").strip()
    why = f" {why.rstrip('.')}." if why else ""
    portal = {"target": f"macos@{c['mac']}", "session": c["session"]}
    show = {"label": "Show the tab", "target": f"macos@{c['mac']}", "action": "browser", "args": {"op": "show", "session": c["session"]}}
    project = c.get("project") or "switchboard-gmail-sense"
    if outcome["state"] == "ready":
        grants = outcome.get("grants") or []
        listed = "\n".join(f"- {g}" for g in grants) if grants else "- what " + c["instance"] + " asks for (Google lists it on the page)"
        body = {
            "type": "approval",
            "title": f"Connect {address} to {product}"[:60],
            "text": (f"**Let Switchboard's {product} use {address}?**{why}\n\n"
                     f"I've gone through Google's consent on the Mac mini (pictured): signed in, past the unverified-app "
                     f"warning (it's your own Switchboard project, {project}) and every box ticked. Approve presses its "
                     f"Continue, which lets {c['instance']} do this as {address}:\n{listed}\n\n"
                     f"Nothing goes anywhere but your own Switchboard, and you can take it back any time at "
                     f"myaccount.google.com/connections."),
            "assists": [{"label": "Press Continue", "target": INSTANCE, "action": "grant", "args": {"connect": c["id"]}}, show],
            "portal": portal,
        }
    else:
        body = {
            "type": "task",
            "title": f"Finish connecting {address}"[:60],
            "text": (f"**Finish connecting {address} to Switchboard's {product}.**{why} I went through Google's pages in "
                     f"the Mac mini's Chrome, but {outcome['why'][0].lower() + outcome['why'][1:]}. Finish that in the "
                     f"tab, then press Continue on Google's last page: the card closes itself once {address} is in."),
            "assists": [show],
            "portal": portal,
        }
    body["resolve_when"] = c["resolve_when"]
    if shot:
        body["attachments"] = [shot]
    if c.get("work"):
        body["work"] = c["work"]
    if replaces:
        body["notify"] = False
    ask_id = new_id()
    app.emit("ask", body, about=c.get("about") or ["ws:switchboard"], id=ask_id,
             refs=[f"supersedes:{replaces}"] if replaces else None)
    if replaces:
        app.emit("ask.resolved", {"note": "Replaced by a new card", "replaced_by": ask_id}, refs=[f"answers:{replaces}"])
    return ask_id, body


def observe(c, status, summary):
    app.emit("connect", {"entity": f"google-connect:{c['id']}", "summary": summary,
                         "facts": {"status": status, "appendage": c["instance"], "address": c["address"], "ask": c.get("ask"),
                                   "page": c.get("page"), "why": c.get("why")}},
             about=["ws:switchboard"])


def connect_account(appendage, address, args=None, require=None, entity=None, why=None, about=None, mac=None,
                    dry_run=False, again=False, work=None, progress=lambda m: None):
    name = name_of(appendage)
    a = find(name)
    address = (address or "").strip().lower()
    if "@" not in address:
        raise ValueError("address: the Google account to connect, like me@example.com")
    instance = a.get("instance") or f"{name}@{HOST}"
    session = f"google-connect-{slug(name)}-{slug(address)}"[:80]
    c = {"id": new_id(), "name": name, "instance": instance, "connect_action": a.get("connect_action"), "address": address, "args": args or {}, "require": require or {},
         "entity": entity, "why": why, "about": about or ["ws:switchboard"], "mac": mac or MAC, "session": session,
         "work": work, "at": int(time.time() * 1000), "project": project()}
    # One card per account and appendage: one already waiting is the answer.
    for cid, other in connects().items():
        if other["instance"] == instance and other.get("connect_action") == c["connect_action"] and other["address"] == address and other.get("args") == c["args"] and not again:
            if other.get("ask") and ask_open(other["ask"]):
                return {"state": "waiting_on_user", "connect": cid, "ask": other["ask"], "resolve_when": other["resolve_when"],
                        "note": f"It's already in the user's queue (ask {other['ask']}): wait on that ask, or follow it."}
    url, given = consent_url(c)
    c["resolve_when"] = done_query(name, address, given, require, entity)
    if found(c["resolve_when"]) and not again:
        return {"state": "connected", "resolve_when": c["resolve_when"],
                "note": f"{address} is connected to {instance} already, with what's required: nothing to ask. "
                        "(again: true asks anyway, for scopes the account's facts don't show.)"}
    tab = tab_for(c["mac"], session)
    host = urllib.parse.urlsplit(callback()).hostname
    outcome = consent.drive(tab, url, address, host, time.time() + 120, approved=False, progress=progress)
    c["page"] = outcome.get("where")
    if outcome["state"] == "granted":
        # Google needed no consent from him (a sign-in that granted nothing new): it's done.
        tab.release()
        ok = wait_connected(c, 45)
        observe(c, "connected" if ok else "unconfirmed", f"{address} went through without a consent page")
        return {"state": "connected" if ok else "unconfirmed", "note": "Google needed no consent page for it: "
                + ("it's connected." if ok else "it came back to Switchboard, but the account doesn't show connected yet.")}
    shot = tab.screenshot()
    if dry_run:
        tab.release()
        preview = {"state": "dry_run", "outcome": outcome, "resolve_when": c["resolve_when"], "screenshot": shot,
                   "note": "Went through Google's pages and stopped there: no card, nothing pressed, tab let go."}
        if outcome["state"] == "ready":
            preview["grants"] = outcome.get("grants")
        return preview
    tab.hold(HOLD_HOURS)
    c["ask"], body = card(c, outcome, shot)
    c["state"] = "ready" if outcome["state"] == "ready" else "person"
    keep_connect(c["id"], c)
    observe(c, "waiting_on_user", f"{address} for {instance}: " + ("approval up" if c["state"] == "ready" else outcome["why"]))
    state["last_connect"] = {"connect": c["id"], "appendage": instance, "address": address, "state": c["state"], "at": c["at"]}
    if c["state"] == "ready":
        note = (f"\"{body['title']}\" is in the user's queue (ask {c['ask']}), Google's last page held in the Mac mini's Chrome: "
                f"his Approve presses its Continue (grant) and checks the account connected; the card closes itself "
                f"once it is. Wait on that ask (the brain's wait op) or follow it.")
    else:
        note = (f"Google stopped on a step only the user can take ({outcome['why']}), so his queue has a card with that tab "
                f"live on it (ask {c['ask']}); it closes itself once the account is connected. Wait on it or follow it.")
    return {"state": "waiting_on_user", "connect": c["id"], "ask": c["ask"], "resolve_when": c["resolve_when"],
            "grants": outcome.get("grants"), "page": outcome.get("where"), "note": note}


def wait_connected(c, seconds):
    until = time.time() + seconds
    while time.time() < until:
        if found(c["resolve_when"]):
            return True
        time.sleep(1.5)
    return bool(found(c["resolve_when"]))


def settle(cid, c, status, summary, note=None):
    """A connect that's over: its tab let go, its card closed when it's still open, and it's forgotten."""
    tab_for(c["mac"], c["session"]).release()
    if note and c.get("ask") and ask_open(c["ask"]):
        app.emit("ask.resolved", {"note": note}, refs=[f"answers:{c['ask']}"])
    observe(c, status, summary)
    keep_connect(cid, None)


def grant_connect(cid, progress=lambda m: None):
    c = connects().get(cid)
    if not c:
        raise ValueError(f"no connect {cid} waiting (status lists them): it finished, lapsed or was discarded")
    if found(c["resolve_when"]):
        settle(cid, c, "connected", f"{c['address']} connected to {c['instance']}")
        return {"connected": True, "account": c["address"], "appendage": c["instance"], "note": f"{c['address']} was connected already."}
    host = urllib.parse.urlsplit(callback()).hostname
    tab = tab_for(c["mac"], c["session"])
    progress("Pressing Google's Continue")
    outcome = consent.drive(tab, None, c["address"], host, time.time() + 60, approved=True, progress=progress)
    if outcome["state"] != "granted":
        # The held page went stale (or he left it elsewhere): a fresh consent, approved this time.
        progress("The held page had gone stale; going through a fresh consent")
        url, _ = consent_url(c)
        outcome = consent.drive(tab, url, c["address"], host, time.time() + 120, approved=True, progress=progress)
    if outcome["state"] == "granted" and wait_connected(c, 45):
        settle(cid, c, "connected", f"{c['address']} connected to {c['instance']}")
        return {"connected": True, "account": c["address"], "appendage": c["instance"],
                "note": f"Pressed Continue: {c['address']} is connected to {c['instance']} now."}
    # Still not in: a card with the tab live on it, in place of the one he approved.
    tab.hold(HOLD_HOURS)
    why = outcome.get("why") or "Google came back to Switchboard, but the account doesn't show connected"
    if outcome["state"] == "granted":
        why = "Google came back to Switchboard, but the account doesn't show connected: " + (outcome.get("says") or "")[:200]
    old = c.get("ask")
    c["ask"], _ = card(c, {"state": "person", "why": why}, tab.screenshot(), replaces=old if old and ask_open(old) else None)
    c["state"] = "person"
    keep_connect(cid, c)
    observe(c, "waiting_on_user", f"{c['address']} for {c['instance']}: {why}")
    return {"connected": False, "account": c["address"], "ask": c["ask"],
            "note": f"Pressed Continue, but it didn't go through ({why}). A card with the tab live on it is up (ask {c['ask']})."}


def watch_connects():
    """The connects waiting on the user: connected (the card closed itself), declined or dismissed, or lapsed."""
    for cid, c in list(connects().items()):
        try:
            if found(c["resolve_when"]):
                settle(cid, c, "connected", f"{c['address']} connected to {c['instance']}")
            elif c.get("ask") and not ask_open(c["ask"]):
                settle(cid, c, "closed", f"{c['address']} for {c['instance']}: its card closed without it")
            elif time.time() - c["at"] / 1000 > HOLD_HOURS * 3600:
                settle(cid, c, "lapsed", f"{c['address']} for {c['instance']}: nobody needed it for three days",
                       note="Lapsed: nobody needed it for three days")
        except Exception as e:  # noqa: BLE001 (one stuck connect mustn't stop the others)
            log(f"watching connect {cid}: {e}")


# Tools

ADDRESS = {"type": "string", "description": "The Google account to connect, like me@example.com."}
APPENDAGE = {"type": "string", "description": "The Google appendage on this server, like google-sheets (or google-sheets@switchboard)."}
REQUIRE = {"type": "object", "description": "Facts its account entity must have once it's done, over connected == true, "
           "like {\"can_send\": true} for gmail's send access: what the card's resolve_when checks."}
ARGS = {"type": "object", "description": "More arguments for the appendage's own connect, like {\"send\": true} for gmail."}
WHY = {"type": "string", "description": "A sentence for the card on why it's needed now, like \"So I can fix the books sheet myself.\""}
MAC_ARG = {"type": "string", "description": "The Mac whose Chrome drives Google's pages (default local)."}
ABOUT = {"type": "array", "items": {"type": "string"}, "description": "Entities the card is about (default ws:switchboard)."}


def tracked(fn):
    def run(*a, **k):
        state["calls"] += 1
        try:
            return fn(*a, **k)
        except Exception as e:
            state["failed"] += 1
            state["last_error"] = f"{type(e).__name__}: {e}"
            raise
    return run


@app.tool(name="setup", schema={"type": "object", "required": ["appendage"], "properties": {
    "appendage": {"type": "string", "description": "The Google appendage on this server, like google-docs; \"all\" gives "
                  "every Google appendage here the shared client (after it was rotated, say)."},
    "apis": {"type": "array", "items": {"type": "string"}, "description": "APIs it calls, enabled in the Cloud project "
             "if they aren't: short names (sheets, drive, docs, calendar, gmail, slides, forms, tasks, people, youtube...) "
             "or service names (docs.googleapis.com)."},
    "address": {"type": "string", "description": "An account to connect once it's set up, like me@example.com (connect's card)."},
    "args": ARGS, "require": REQUIRE, "why": WHY, "about": ABOUT, "mac": MAC_ARG,
    "dry_run": {"type": "boolean", "description": "Say what it would do, changing nothing: no client written, no API "
                "enabled; with address, it walks Google's pages and stops there, with no card."},
}}, description=(
    "Set up a Google appendage on this server in one step: gives it the shared OAuth client (written into its own "
    "secrets.json as `oauth-client`, mode 600, never through a record; its accounts' tokens stay), enables the APIs it "
    "calls in the Cloud project (switchboard-gmail-sense, through the console in the Mac mini's Chrome as "
    "me@example.com), and with address, connects that account as connect does (Google's consent driven up to its "
    "last page and one approval card for the user, whose Approve presses Continue). Each step is skipped when it's done "
    "already. The appendage needs a connect action answering {url} (google_oauth's consent_url; kit has the module) and "
    "the account entity <kind>-account:<address> (its name without google-) with facts.connected."))
def setup(appendage, apis=None, address=None, args=None, require=None, why=None, about=None, mac=None, dry_run=False, ctx=None):
    return tracked(_setup)(appendage, apis, address, args, require, why, about, mac, dry_run, ctx)


def _setup(appendage, apis, address, args, require, why, about, mac, dry_run, ctx):
    progress = ctx.progress if ctx else (lambda m: None)
    facts = client_facts()
    if not facts["callback_registered"]:
        raise RuntimeError(f"the shared client doesn't list the core's callback {facts['callback']} among its redirect URIs: "
                           "add it to the Web client in Google Cloud first")
    if appendage == "all":
        if address or apis:
            raise ValueError("appendage \"all\" only gives each Google appendage the shared client: name one for apis or address")
        done = []
        for a in appendages():
            seen = look_at(a)
            if seen["google"]:
                done.append({"appendage": seen["instance"], **provision(a, dry_run)})
        return {"appendages": done, "shared_client": {k: facts[k] for k in ("project", "fingerprint")}}
    name = name_of(appendage)
    a = find(name)
    seen = look_at(a)
    out = {"appendage": a.get("instance"), "shared_client": {k: facts[k] for k in ("project", "client_id", "fingerprint")}}
    progress(f"Giving {name} the shared client")
    out.update(provision(a, dry_run))
    if seen["google_oauth_py"] != "current":
        out["google_oauth_py"] = seen["google_oauth_py"]
        out["google_oauth_py_note"] = ("its code has no google_oauth.py: kit puts the shared one in its folder" if seen["google_oauth_py"] == "none"
                                       else "its google_oauth.py is older than the kit's (kit with update: true brings it up to date before its next install)")
    if apis:
        progress("Enabling its APIs in the Cloud project")
        out["apis"] = enable(apis, dry_run, mac, progress)
        failed = [x for x in out["apis"] if x["state"] == "failed"]
        if failed:
            out["note"] = "Some APIs didn't enable: " + "; ".join(f"{x['api']}: {x['why']}" for x in failed)
    if not dry_run:
        said = {"already": "had the shared client already", "written": "given the shared client", "replaced": "given the shared client in place of another"}
        app.emit("setup", {"entity": f"google-appendage:{name}", "summary": f"{name}: {said.get(out.get('client'), out.get('client'))}"
                           + ("; APIs " + ", ".join(f"{x['api']} {x['state']}" for x in out.get("apis", [])) if apis else ""),
                           "facts": {"appendage": a.get("instance"), "client": out.get("client"), "fingerprint": facts["fingerprint"],
                                     "apis": {x["api"]: x["state"] for x in out.get("apis", [])}, "google_oauth_py": seen["google_oauth_py"]}},
                 about=["ws:switchboard"])
        state["last_setup"] = {"appendage": a.get("instance"), "at": int(time.time() * 1000)}
    if address:
        out["connect"] = connect_account(name, address, args, require, None, why, about, mac, dry_run,
                                         work=ctx.work if ctx else None, progress=progress)
    return out


@app.tool(name="connect", schema={"type": "object", "required": ["appendage", "address"], "properties": {
    "appendage": APPENDAGE, "address": ADDRESS, "args": ARGS, "require": REQUIRE,
    "entity": {"type": "string", "description": "Its account entity, when it isn't <kind>-account:<address> (like drive-account:me-example-com)."},
    "why": WHY, "about": ABOUT, "mac": MAC_ARG,
    "again": {"type": "boolean", "description": "Ask even though the account shows connected already (for a scope its facts don't show), or a card for it waits."},
    "dry_run": {"type": "boolean", "description": "Walk Google's pages and stop on the last one, then let the tab go: no card, nothing pressed. Answers what the card would grant and a screenshot."},
}}, description=(
    "Connect a Google account to a Google appendage (a new account, or more scopes for one, through the appendage's own "
    "connect and args), with one approval of the user's: gets the consent link from the appendage, drives Google's sign-in "
    "and consent in the Mac mini's Chrome (the account chooser, the password Chrome saved, the unverified-app warning, "
    "every scope's box) up to the last page, holds that tab, and puts one approval in his queue: what it grants in "
    "Google's words, a picture of the page, the tab live on it, Approve pressing Continue (grant) and resolve_when "
    "closing it once the account shows connected. A step only he can take (a passkey, a prompt on his phone, a CAPTCHA) "
    "goes up as a card with the tab live on it instead. Answers the ask to wait on or follow; one already waiting is "
    "answered rather than asked twice, and an account connected already asks nothing."))
def connect(appendage, address, args=None, require=None, entity=None, why=None, about=None, mac=None, again=False, dry_run=False, ctx=None):
    if os.environ.get("SWITCH_MACHINE"):
        from authorize import authorize
        return authorize(address)
    return tracked(connect_account)(appendage, address, args, require, entity, why, about, mac, dry_run, again,
                                    work=ctx.work if ctx else None, progress=ctx.progress if ctx else (lambda m: None))


@app.tool(name="grant", schema={"type": "object", "required": ["connect"], "properties": {
    "connect": {"type": "string", "description": "The connect's id, as connect answered it."}}},
    description=("Press Google's Continue on a connect's held consent page, once the user approved it (his card's Approve "
                 "runs this): from a fresh consent when the held page went stale, then checks the account connected and "
                 "lets the tab go. Only from his approval of that card, or when he asked for exactly that connection."))
def grant(connect, ctx=None):
    return tracked(grant_connect)(connect, progress=ctx.progress if ctx else (lambda m: None))


@app.tool(name="discard", schema={"type": "object", "required": ["connect"], "properties": {
    "connect": {"type": "string", "description": "The connect's id, as connect answered it."},
    "why": {"type": "string", "description": "A few words on why, for the card."}}},
    description="Drop a connect waiting on the user (it's moot, or he declined): closes its card if it's open and lets its tab go. Nothing is granted.")
def discard(connect, why=None):
    c = connects().get(connect)
    if not c:
        raise ValueError(f"no connect {connect} waiting (status lists them)")
    settle(connect, c, "discarded", f"{c['address']} for {c['instance']}: dropped", note=why or "Not needed anymore")
    return {"discarded": connect, "note": "Its card is closed and its tab let go."}


@app.tool(name="enable_apis", schema={"type": "object", "required": ["apis"], "properties": {
    "apis": {"type": "array", "items": {"type": "string"}, "description": "Short names (sheets, docs, drive...) or service names (docs.googleapis.com)."},
    "mac": MAC_ARG,
    "dry_run": {"type": "boolean", "description": "Only say which are enabled and which would be."}}},
    description=("Enable Google APIs in Switchboard's Cloud project, each through its console "
                 "page in the Mac mini's Chrome as me@example.com, skipping those enabled already. setup does this "
                 "for an appendage's apis."))
def enable_apis(apis, mac=None, dry_run=False, ctx=None):
    return {"apis": tracked(enable)(apis, dry_run, mac, ctx.progress if ctx else (lambda m: None)), "project": project()}


GUIDE = """How a Google appendage uses the shared google_oauth.py (gmail, google-calendar, google-drive and google-sheets do):

    from google_oauth import Google, Disconnected
    SCOPES = ["openid", "email", "https://www.googleapis.com/auth/<its scope>"]
    google = Google(os.environ.get("SB_INSTANCE"), HOME, "switchboard-<name>", SCOPES)   # HOME: its SB_HOME

- connect(address) answers {"url": google.consent_url(address)} (with extra scopes: consent_url(address, [scope]),
  and a resolve_when if its account entity isn't the usual one).
- finish(code, state, redirect_uri) (the core's /oauth/callback calls it): t = google.finish({...}, "what to tick");
  the address from t["id_token"]'s email; google.keep(address, t); then record the account as an observation,
  entity <kind>-account:<address with non-alphanumerics as hyphens> in <kind>/accounts (kind: its name without
  google-), facts {address, connected: true, scope}; answer {"address", "note"}.
- token, _ = google.access(address) before each API call; on Disconnected, record connected: false and have
  google-oauth's connect put the card up again.
- Install it on the server, then google-oauth's setup(appendage, apis, address) gives it the shared client, enables
  its APIs and connects the account with one approval of the user's.
"""


@app.tool(name="kit", schema={"type": "object", "required": ["folder"], "properties": {
    "folder": {"type": "string", "description": "The appendage's folder: a path on this server, or <machine>:<path> (local:~/x) for another."},
    "update": {"type": "boolean", "description": "Write over a google_oauth.py that differs from the kit's (an older copy)."}}},
    description=("Put the shared google_oauth.py (the newest, as gmail, google-drive and google-sheets run it) in a new "
                 "Google appendage's folder, and answer how to wire it: connect, finish, the account entity setup and "
                 "connect look for. The client's secret isn't in it: setup gives the installed appendage that."))
def kit(folder, update=False):
    with open(KIT) as f:
        text = f.read()
    sha = hashlib.sha256(text.encode()).hexdigest()
    m = re.match(r"^([a-z0-9@-]+):(.+)$", folder)
    if m and not folder.startswith("/"):
        machine, path = m.group(1), m.group(2)
        target = machine if "@" in machine else f"macos@{machine}"
        r = subprocess.run(["sb", "cp", KIT, f"{target}:{path.rstrip('/')}/google_oauth.py"], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"sb cp to {target}: {(r.stderr or r.stdout).strip()[-300:]}")
        return {"path": f"{target}:{path.rstrip('/')}/google_oauth.py", "sha256": sha[:12], "guide": GUIDE}
    path = os.path.join(os.path.expanduser(folder), "google_oauth.py")
    if os.path.exists(path):
        with open(path) as f:
            had = f.read()
        if had == text:
            return {"path": path, "sha256": sha[:12], "state": "current", "guide": GUIDE}
        if not update:
            raise ValueError(f"{path} differs from the kit's (an older copy, or changed by hand): update: true writes over it")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    return {"path": path, "sha256": sha[:12], "state": "written", "guide": GUIDE}


@app.tool(read_only=True, name="status", schema={"type": "object", "properties": {}}, description=(
    "How Switchboard's Google sign-in stands: the shared OAuth client (project, client id, fingerprint, whether the core's "
    "callback is among its redirect URIs), every Google appendage on this server (whether it has the shared client, "
    "whether its google_oauth.py is the kit's), each one's accounts as the brain has them (connected, scope), the "
    "connects waiting on the user, and how google-oauth itself is (calls, failures, last error)."))
def status():
    facts = client_facts()
    found_ = []
    for a in appendages():
        try:
            seen = look_at(a)
        except OSError:
            continue
        if seen["google"]:
            seen["accounts"] = accounts_of(seen["name"])
            found_.append(seen)
    waiting = [{"connect": cid, "appendage": c["instance"], "address": c["address"], "ask": c.get("ask"),
                "state": c.get("state"), "since": c["at"]} for cid, c in connects().items()]
    scopes = server.local.get("data_access_health")
    out = {"client": facts, "appendages": found_, "waiting": waiting, "kit": {"sha256": kit_sha()[:12]},
           **({"consent_scopes": scopes()} if scopes else {}), **state}
    if SWITCH:
        try:
            listed = core("connections", "list", {})
            out["connections"] = [{"account": c["account"], "scopes": c.get("scopes", []), "missing": c.get("missing", [])}
                                  for c in listed.get("connections", []) if c.get("provider") == "google"]
            out["extensions"] = next((n.get("apps", []) for n in listed.get("needs", []) if n.get("provider") == "google"), [])
        except (OSError, ValueError, KeyError) as e:
            out["connections_error"] = str(e)
    return out


def heartbeat():
    """Says how it is, in vitals/google-oauth: what keeps its --health-every promise. `failing` is what's wrong now
    (the shared client missing or unreadable), cleared once it's back; a call that failed is its caller's to hear,
    kept as last_error."""
    facts, failing = {}, None
    try:
        f = client_facts()
        facts = {"client": f["fingerprint"], "project": f["project"], "callback_registered": f["callback_registered"]}
    except Exception as e:  # noqa: BLE001
        failing = f"client: {e}"
    scopes = server.local.get("data_access_health")
    scopes = scopes() if scopes else {}
    summary = f"Failing: {failing}" if failing else f"Ready: {len(connects())} connect(s) waiting on the user"
    if scopes.get("waiting"):
        summary += f", {len(scopes['waiting'])} Data Access fill(s) waiting on his approval"
    app.emit("heartbeat", {"entity": "sense:google-oauth", "summary": summary,
                           "facts": {**state, **facts, "waiting": len(connects()), "failing": failing,
                                     **({"consent_scopes": {k: scopes[k] for k in ("reads", "fills", "saves", "failed", "last_error", "last_save")},
                                         "consent_scopes_waiting": len(scopes.get("waiting") or {})} if scopes else {})}})


@app.background
def beat():
    while True:
        heartbeat()
        time.sleep(HEARTBEAT_S)


@app.background
def watch():
    while True:
        time.sleep(WATCH_S)
        if connects():
            watch_connects()

