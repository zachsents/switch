#!/usr/bin/env python3
"""Gmail: every inbox the person connects, read-only, live in Switchboard.

Reads each connected Google account through the Gmail API (scope
gmail.readonly, nothing else) and records its mail into `comms/gmail`: one
`gmail-message:<account>-<id>` observation per message in the inbox or sent
(promotions, social and forums tabs left out), recorded again whenever its
labels change (read, archived, starred) and `gone` when it's deleted, plus a
`gmail-account:<account>` observation with each inbox's unread counts. It
follows each mailbox with history.list once a minute, which costs a single
small call when nothing changed.

Secrets never touch the log (google_oauth.py): the OAuth client and each
account's refresh token live in `secrets.json` in its own `SB_HOME` on a
server, or the Keychain (service `switchboard-gmail`) on a Mac. Connecting an
account is `connect`, a consent URL that works in any browser, the person's
phone included; Google sends it back to the core's callback, which calls
`finish`. Its other actions read on demand: `search`, `read`, `sync`,
`accounts`, `drafts`. For an account connected with send access too (`connect` with `send`, scope
gmail.compose), `draft` writes an email into Gmail's Drafts without sending it (a reply in a thread, quoting what
it answers the way Gmail does, or a new email, from any send-as address, attachments included) and hands back the
approval ask that sends it, and `approval` does that for several emails at once (one card, one Approve & send that
sends them all, closing once every one is sent); `send` sends it once the user approves (or composes and sends at once), from the server so
no Mac's browser has to be awake, with the card's words if he edited them there, or the draft's if he edited it in
Gmail instead; `discard` drops a draft. It never sends the same `key` twice, and it only says sent once Gmail
labels the message SENT, and its answer says where it went (to, cc, in its thread or not) in a sentence; a bounce
that comes back into its thread records it again as bounced. A reply-all reaches whom Gmail's own Reply all would
(recipients), and `read` says who a reply and a reply-all would reach, with the call that sends one, so a reply never
needs Gmail's web page. An MCP server (sbmcp): those are its tools, and what it records goes out
as events: `message` and `message.gone` (comms/gmail), `account` (comms/gmail), `ask`
(asks), `heartbeat` (vitals/gmail).
"""

import base64
import email.message
import email.parser
import email.policy
import email.utils
import zoneinfo
import mimetypes
import html
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import grant
import sbmcp
from server import part, home as home_of
from google_oauth import SWITCH, Disconnected, Google, TokenError

for _kind, _ext in (("model/stl", ".stl"), ("model/3mf", ".3mf"), ("model/obj", ".obj"), ("model/step", ".step"),
                    ("model/step", ".stp")):
    # The registered types for the 3D models people send: macOS's own table calls .stl a Windows certificate trust list
    # (application/vnd.ms-pki.stl) and .obj a TGIF drawing, and has no .3mf or .step.
    mimetypes.add_type(_kind, _ext)

INSTANCE = os.environ.get("SB_INSTANCE", "google@dev")
HOME = home_of("gmail")
STREAM = "comms/gmail"
KEYCHAIN = "switchboard-gmail"
SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
SEND_SCOPE = "https://www.googleapis.com/auth/gmail.compose"
"""Asked for only when an account is connected with send: drafts and sending, nothing that deletes."""
API = "https://gmail.googleapis.com/gmail/v1/users/me"
POLL_S = int(os.environ.get("GMAIL_POLL_SECONDS", "60"))
BACKFILL_DAYS = int(os.environ.get("GMAIL_BACKFILL_DAYS", "14"))
HEARTBEAT_S = 15 * 60
SKIPPED_TABS = {"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"}
TABS = {
    "CATEGORY_PERSONAL": "primary",
    "CATEGORY_UPDATES": "updates",
    "CATEGORY_PROMOTIONS": "promotions",
    "CATEGORY_SOCIAL": "social",
    "CATEGORY_FORUMS": "forums",
}

state_lock = threading.RLock()
wake = threading.Event()

app = part("gmail", {"connect": "gmail_connect", "accounts": "gmail_accounts", "read": "gmail_read",
                     "discard": "gmail_discard", "sync": "gmail_sync"}, shared={"read", "discard", "sync"})
"""Gmail, a part of google (it was the gmail appendage until Nov 17): its tools keep their names, but read, discard
and sync, which main.py offers once for every part and hands here by their arguments (connect too, as gmail_connect)."""
app.event("message", "A message in an inbox or sent: seen, or its labels changed (read, archived, starred)", stream=STREAM, kind="observation")
app.event("message.gone", "A message was deleted", stream=STREAM, kind="gone")
app.event("account", "An inbox's state: connected or not, and its unread counts", stream=STREAM, kind="observation")
app.event("ask", "Something the person must do: connect an account again, or let it send from one", stream="asks", kind="ask")
app.event("ask.resolved", "A card of its own that isn't needed anymore, closed", stream="asks", kind="resolved")
app.event("heartbeat", "Which accounts it follows, and what it can't see", stream="vitals/gmail", kind="observation", retention="signal")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def message_parts(body):
    """In Switch, who sent a message and what it is, for the inbox and Contacts."""
    f = body.get("facts") or {}
    if f.get("sent"):
        sender = {"handle": (f.get("account") or "").lower(), "via": "email", "me": True}
    else:
        sender = {"handle": f.get("from_email") or "", "via": "email"}
        if f.get("from") and f.get("from") != f.get("from_email"):
            sender["name"] = f["from"]
    message = {"id": body.get("entity"), "conversation": f"email:{f.get('account')}:{f.get('thread_id')}",
               "text": f.get("snippet") or "", "subject": f.get("subject") or "", "at": f.get("date"),
               "unread": bool(f.get("unread") and f.get("inbox") and not f.get("sent")), "channel": "email"}
    return sender, message


def record(kind, body, about, stream=STREAM, id=None):
    """Sends what it saw as the event it is, for its keeper to record."""
    entity = body.get("entity", "")
    event = ("ask" if stream == "asks" else "heartbeat" if stream.startswith("vitals/") else "message.gone" if kind == "gone"
             else "account" if entity.startswith("gmail-account:") else "message")
    if event == "message":
        sender, message = message_parts(body)
        app.emit(event, body, about=about, id=id, sender=sender, message=message)
        return
    app.emit(event, body, about=about, id=id)


def slug(address):
    """An account's key in entity ids: me@example.com is me-example-com."""
    return re.sub(r"[^a-z0-9]+", "-", address.lower()).strip("-")


google = Google(INSTANCE, HOME, KEYCHAIN, [SCOPE])


# HTTP


class HttpError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status, self.body = status, body


def http(method, url, data=None, token=None, body=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        data = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, e.read().decode(errors="replace")) from None


# Accounts


class Account:
    def __init__(self, address, history_id=None):
        self.address = address
        self.key = slug(address)
        self.entity = f"gmail-account:{self.key}"
        self.history_id = history_id
        self.access_token = None
        self.expires_at = 0
        self.connected = True
        self.error = None
        self.unread = None
        self.reported = None
        self.reported_history_at = 0
        self.asked_reconnect = False

    def token(self):
        if self.access_token and time.time() < self.expires_at - 60:
            return self.access_token
        self.access_token, lasts = google.access(self.address)
        self.expires_at = time.time() + lasts
        return self.access_token

    def get(self, path, **params):
        query = urllib.parse.urlencode([(k, v) for k, vs in params.items() for v in (vs if isinstance(vs, list) else [vs]) if v is not None])
        return http("GET", f"{API}/{path}" + (f"?{query}" if query else ""), token=self.token())

    def post(self, path, body):
        return http("POST", f"{API}/{path}", token=self.token(), body=body)

    def put(self, path, body):
        return http("PUT", f"{API}/{path}", token=self.token(), body=body)

    def delete(self, path):
        return http("DELETE", f"{API}/{path}", token=self.token())

    def can_send(self):
        return SEND_SCOPE in google.granted(self.address)


accounts = {}
"""Connected accounts by address."""
known = {}
"""What's been recorded of each message entity (its facts, as JSON), so nothing repeats."""
def brain(query):
    r = subprocess.run(["sb", "query", query], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"sb query failed: {r.stderr.strip()}")
    return json.loads(r.stdout)["rows"]


blind = None
"""Why this credential can't see comms/gmail, when it can't: the brain would then show no accounts, as if none were connected."""


def check_reads():
    """Whether this credential may read its own stream, which is where it learns which accounts are connected (its manifest
    subscribes to it). Without that, every query comes back empty rather than failing, so it says so instead of following nothing."""
    global blind
    r = subprocess.run(["sb", "whoami"], capture_output=True, text=True)
    if r.returncode != 0:
        return
    reads = json.loads(r.stdout).get("scopes", {}).get("read", [])
    pattern = lambda p: "^" + re.escape(p).replace(r"\*\*", ".*").replace(r"\*", "[^/]*") + "$"
    was, blind = blind, None if any(re.match(pattern(p), STREAM) for p in reads) else f"this credential can't read {STREAM} (it reads {reads or 'nothing'})"
    if blind and blind != was:
        log(f"{blind}, so the brain shows it no accounts: reinstall it with read on {STREAM}")


CURSORS = os.path.join(HOME, "history.json")
"""In Switch, where each account's history was: Switch's brain isn't asked (its extensions have no `sb`)."""


def saved_accounts():
    """The accounts with a token here, as the brain's gmail-account entities would say them, with their saved history."""
    try:
        with open(CURSORS) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        saved = {}
    return [{"id": f"gmail-account:{slug(a)}", "facts": {"address": a, "history_id": saved.get(a)}}
            for a in sorted(google.stored())]


def save_cursors():
    with state_lock:
        cursors = {a.address: a.history_id for a in accounts.values() if a.history_id}
    fd = os.open(CURSORS + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cursors, f)
    os.replace(CURSORS + ".new", CURSORS)


def brain_or_saved(query):
    try:
        return brain(query), True
    except RuntimeError:
        return saved_accounts(), False


def load_brain():
    """Takes up what the brain knows: which accounts are connected, where each one's history was, and what's recorded.
    Run again from the loop, so accounts the brain didn't show at start (the core was still coming up) are picked up.
    In Switch, the accounts with a token here and the history it saved."""
    check_reads()
    found = {}
    rows, asked = brain_or_saved('entities | where id startswith "gmail-account:" | project id, facts')
    if SWITCH and asked:
        # Switch's connections are the accounts: one never followed has no gmail-account entity yet.
        seen = {(r["facts"] or {}).get("address") for r in rows}
        rows = rows + [r for r in saved_accounts() if r["facts"]["address"] not in seen]
    for row in rows:
        f = row["facts"] or {}
        if f.get("address") and f["address"] not in accounts and google.account(f["address"]):
            found[f["address"]] = Account(f["address"], f.get("history_id"))
    if not found:
        return
    for row in (brain('entities | where id startswith "gmail-message:" | project id, facts') if asked else []):
        known.setdefault(row["id"], json.dumps(row["facts"], sort_keys=True))
    accounts.update(found)
    log(f"following {', '.join(sorted(found))}")


# Messages


def header(headers, name):
    return next((h["value"] for h in headers if h["name"].lower() == name.lower()), "")


def authentication_message(text):
    """Authentication message contents belong only in the private challenge transport."""
    return bool(re.search(r"(?:verification|security|sign[ -]?in|login|one[ -]?time|authentication)\s+(?:code|password)|(?:code|password)\s+(?:for|to)\s+(?:sign|log)", text, re.I))


def observation(acct, m):
    labels = m.get("labelIds", [])
    headers = m.get("payload", {}).get("headers", [])
    name, address = email.utils.parseaddr(header(headers, "From"))
    subject = header(headers, "Subject") or "(no subject)"
    snippet = html.unescape(m.get("snippet", ""))
    if authentication_message(subject + "\n" + snippet):
        subject, snippet = "Verification code", "Private authentication message"
    sent = "SENT" in labels
    to = header(headers, "To")
    facts = {
        "account": acct.address,
        "message_id": m["id"],
        "thread_id": m["threadId"],
        "from": name or address,
        "from_email": address.lower(),
        "to": to,
        "subject": subject,
        "snippet": snippet,
        "date": int(m.get("internalDate", 0)),
        "labels": sorted(labels),
        "inbox": "INBOX" in labels,
        "unread": "UNREAD" in labels,
        "starred": "STARRED" in labels,
        "important": "IMPORTANT" in labels,
        "sent": sent,
        "tab": next((TABS[l] for l in labels if l in TABS), "primary" if "INBOX" in labels else None),
        "link": f"https://mail.google.com/mail/?authuser={urllib.parse.quote(acct.address)}#all/{m['threadId']}",
    }
    who = f"to {email.utils.parseaddr(to)[0] or to}" if sent else (name or address)
    return {
        "entity": f"gmail-message:{acct.key}-{m['id']}",
        "summary": f"{'Sent ' if sent else ''}{who}: {subject}"[:200],
        "facts": facts,
    }


def wanted(m):
    labels = set(m.get("labelIds", []))
    return bool(labels & {"INBOX", "SENT"}) and not labels & SKIPPED_TABS and not labels & {"SPAM", "TRASH"}


def metadata(acct, message_id):
    return acct.get(f"messages/{message_id}", format="metadata", metadataHeaders=["From", "To", "Subject", "Date"])


def observe(acct, message_id, hint=None):
    """Records a message if it's one we follow and it changed; `gone` if it was deleted.
    hint is the message as history.list gave it (its labels): one we don't follow and never recorded is skipped
    without fetching it, which spares the quota when a whole mailbox is archived or relabeled at once."""
    entity = f"gmail-message:{acct.key}-{message_id}"
    if hint and "labelIds" in hint and not wanted(hint) and entity not in known:
        return
    try:
        m = metadata(acct, message_id)
    except HttpError as e:
        if e.status == 404:
            if entity in known:
                record("gone", {"entity": entity, "summary": "Deleted"}, [entity, acct.entity])
                known.pop(entity, None)
            return
        raise
    if not wanted(m) and entity not in known:
        return
    obs = observation(acct, m)
    if obs["facts"]["sent"]:
        draft_id = draft_of(acct, m)
        if draft_id:
            obs["facts"]["draft_id"] = draft_id
    facts = json.dumps(obs["facts"], sort_keys=True)
    if known.get(entity) == facts:
        return
    known[entity] = facts
    record("observation", obs, [entity, acct.entity])


def list_ids(acct, q, limit):
    ids, page = [], None
    while len(ids) < limit:
        res = acct.get("messages", q=q, maxResults=min(500, limit - len(ids)), pageToken=page)
        ids += [m["id"] for m in res.get("messages", [])]
        page = res.get("nextPageToken")
        if not page:
            break
    return ids


def backfill(acct):
    """The last couple of weeks of inbox and sent mail, and whatever's still unread in the inbox."""
    profile = acct.get("profile")
    ids = dict.fromkeys(
        list_ids(acct, f"in:inbox newer_than:{BACKFILL_DAYS}d -category:promotions -category:social -category:forums", 300)
        + list_ids(acct, "in:inbox is:unread -category:promotions -category:social -category:forums", 200)
        + list_ids(acct, f"in:sent newer_than:{BACKFILL_DAYS}d", 500)
    )
    log(f"{acct.address}: backfilling {len(ids)} messages")
    for message_id in ids:
        observe(acct, message_id)
    acct.history_id = profile["historyId"]


def follow(acct):
    """Everything that changed since the last history id: new mail, label changes, deletions.
    Takes it a page at a time and keeps its place after each, so a burst too big for a minute's quota
    carries on where it stopped next time instead of starting over."""
    start, page = acct.history_id, None
    while True:
        try:
            res = acct.get("history", startHistoryId=start, pageToken=page,
                           historyTypes=["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"])
        except HttpError as e:
            if e.status == 404:
                log(f"{acct.address}: history {start} is too old, backfilling again")
                return backfill(acct)
            raise
        history = res.get("history", [])
        changed = {}
        for h in history:
            for k in ("messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"):
                for x in h.get(k, []):
                    changed[x["message"]["id"]] = None if k == "messagesDeleted" else x["message"]
        for message_id, hint in changed.items():
            observe(acct, message_id, hint)
        page = res.get("nextPageToken")
        if not page:
            acct.history_id = res.get("historyId", acct.history_id)
            return
        if history:
            acct.history_id = history[-1]["id"]


def report(acct, force=False):
    """The account's own observation: whether it's connected and how much is unread. Recorded when that changes."""
    if acct.connected:
        inbox = acct.get("labels/INBOX")
        acct.unread = {"threads": inbox.get("threadsUnread", 0), "messages": inbox.get("messagesUnread", 0)}
    facts = {"address": acct.address, "connected": acct.connected, "error": acct.error, "can_send": acct.can_send(),
             "unread_threads": (acct.unread or {}).get("threads"), "unread_messages": (acct.unread or {}).get("messages")}
    stale_history = acct.history_id and time.time() - acct.reported_history_at > HEARTBEAT_S
    if facts == acct.reported and not force and not stale_history:
        return
    acct.reported = facts
    acct.reported_history_at = time.time()
    summary = (f"{acct.address}: {facts['unread_threads']} unread in the inbox" if acct.connected
               else f"{acct.address}: disconnected ({acct.error})")
    record("observation", {"entity": acct.entity, "summary": summary,
                           "facts": {**facts, "history_id": acct.history_id, "checked_at": int(time.time() * 1000)}},
           [acct.entity])


def ask_reconnect(acct):
    """Puts reconnecting a dead account in the person's queue, once; it closes itself when the account is back."""
    if acct.asked_reconnect:
        return
    try:
        link = google.consent_url(acct.address)
    except (RuntimeError, OSError) as e:
        log(f"{acct.address}: can't make a link to connect it again ({e}); I'll try next time")
        return
    acct.asked_reconnect = True
    record("ask", {
        "type": "task",
        "text": (f"Gmail stopped letting me read **{acct.address}** ({acct.error}). Connect it again from any browser, your "
                 "phone's too: pick that account, then Continue past Google's \"hasn't verified this app\" page (it's your own "
                 "app) and Allow read access."),
        "assists": [{"label": f"Connect {acct.address}", "url": link}],
        "resolve_when": f'entities | where id == "{acct.entity}" and facts.connected == true',
    }, [acct.entity], stream="asks")


def sync(acct):
    """Whether it read the account's history to its end."""
    read = False
    try:
        if acct.history_id:
            follow(acct)
        else:
            backfill(acct)
        read = True
        acct.connected, acct.error = True, None
        report(acct)
    except Disconnected as e:
        acct.connected, acct.error, acct.access_token = False, str(e), None
        report(acct)
        ask_reconnect(acct)
    except (HttpError, TokenError, RuntimeError, urllib.error.URLError, TimeoutError, OSError) as e:
        log(f"{acct.address}: {e}")
    return read


caught_up = {"now": False, "at": time.time()}
"""Whether the last pass read every account to the end of its history, and when one last did (from the start, till one has)."""


def heartbeat():
    live = [a for a in accounts.values() if a.connected]
    behind_ms = 0 if caught_up["now"] else int((time.time() - caught_up["at"]) * 1000)
    record("observation", {
        "entity": "sense:gmail",
        "summary": f"Can't see its accounts: {blind}" if blind else f"Following {len(live)} of {len(accounts)} Gmail accounts",
        "facts": {"accounts": sorted(accounts), "connected": sorted(a.address for a in live), "blind": blind, "behind_ms": behind_ms, "checked_at": int(time.time() * 1000),
                  **({"attachments": sys.modules["gmail_files"].STATS} if "gmail_files" in sys.modules else {})},
    }, ["sense:gmail"], stream="vitals/gmail")


IDLE = bool(os.environ.get("GMAIL_IDLE"))
"""Answers its actions but doesn't follow the mailboxes (no sync, no heartbeat, no grants waited on): for the overlap
while the gmail appendage it replaces still follows them, so nothing is recorded twice."""


def loop():
    beat = looked = 0
    while IDLE:
        try:
            load_brain()  # the accounts and their tokens, for the actions
        except RuntimeError as e:
            log(str(e))
        time.sleep(HEARTBEAT_S)
    while True:
        if time.time() - looked > (POLL_S if not accounts else HEARTBEAT_S):
            try:
                load_brain()
                looked = time.time()
            except RuntimeError as e:
                log(str(e))
        started = time.time()
        read = [sync(acct) if acct.connected else False for acct in list(accounts.values())]
        save_cursors()
        was, caught_up["now"] = caught_up["now"], all(read)
        if caught_up["now"]:
            caught_up["at"] = started
        if time.time() - beat > HEARTBEAT_S or caught_up["now"] != was:
            heartbeat()
            beat = time.time()
        wake.wait(POLL_S)
        wake.clear()


# Actions


loading = threading.Lock()


def find_account(address):
    if address in accounts:
        return accounts[address]
    match = [a for a in accounts.values() if address and address.lower() in (a.address.lower(), a.key)]
    if not match:
        # Just started, the loop may not have taken up the connections yet (they come once the core's handshake is
        # done, and a call means it is): take them up now rather than refuse an approved send for up to a minute.
        with loading:
            try:
                load_brain()
            except RuntimeError as e:
                log(str(e))
        wake.set()
        match = [a for a in accounts.values() if address and address.lower() in (a.address.lower(), a.key)]
    if not match:
        raise ValueError(f"not a connected account: {address} (connected: {', '.join(sorted(accounts)) or 'none'})")
    return match[0]


def kept_links(rich):
    """HTML whose links stay as words: each link's text, then its address in brackets, as a
    plain-text part gives them ("Track package (https://…)"); a link without words is its address."""
    def one(m):
        url = html.unescape(m.group("quoted") or m.group("bare") or "").strip()
        inside = m.group("inside")
        words = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", inside))).strip()
        if not re.match(r"(?i)(https?|mailto):", url):
            return inside
        return f" {url} " if not words or words == url else f"{inside} ({url})"
    return re.sub(r"""(?is)<a\b[^>]*?\bhref\s*=\s*(?:(["'])(?P<quoted>.*?)\1|(?P<bare>[^\s>]+))[^>]*>(?P<inside>.*?)</a\s*>""", one, rich)


def text_of(part, links=False):
    """A message's readable text: its plain-text part, else its HTML with the tags stripped, and
    with `links`, its links kept as words."""
    def walk(p):
        yield p
        for c in p.get("parts", []):
            yield from walk(c)

    def decode(p):
        data = p.get("body", {}).get("data")
        return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode(errors="replace") if data else ""

    parts = list(walk(part))
    plain = [decode(p).replace("\r\n", "\n") for p in parts if p.get("mimeType") == "text/plain"]
    if any(plain):
        return "\n".join(plain)
    rich = "\n".join(decode(p) for p in parts if p.get("mimeType") == "text/html")
    rich = re.sub(r"(?is)<(script|style).*?</\1>", "", rich)
    if links:
        rich = kept_links(rich)
    rich = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", rich)
    return re.sub(r"\n\s*\n+", "\n\n", html.unescape(re.sub(r"<[^>]+>", "", rich))).strip()


SENT_PATH = os.path.join(HOME, "sent.json")
send_lock = threading.Lock()


def sent_log():
    try:
        with open(SENT_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def log_sent(key, result):
    stored = {**sent_log(), key: result}
    with open(SENT_PATH + ".new", "w") as f:
        json.dump(stored, f)
    os.replace(SENT_PATH + ".new", SENT_PATH)


SIZES = {}
"""Each blob attached to an email lately, by reference: its size, for the card's file chips."""


def attachment(a):
    """An attachment's bytes, name and type, from a path on this server or a blob ({blob, name?, type?})."""
    if isinstance(a, str):
        a = {"path": a}
    if a.get("blob"):
        r = subprocess.run(["sb", "blob", "get", a["blob"]], capture_output=True)
        if r.returncode != 0:
            raise ValueError(f"can't fetch {a['blob']}: {r.stderr.decode(errors='replace').strip()}")
        data, name = r.stdout, a.get("name") or "attachment"
        SIZES[a["blob"]] = len(data)
    else:
        with open(os.path.expanduser(a["path"]), "rb") as f:
            data = f.read()
        name = a.get("name") or os.path.basename(a["path"])
    kind = a.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return data, name, kind


def sendable(address):
    """The account, when it can write drafts and send; else it starts granting it that (enable_send: one approval of
    the user's) and says so, with the ask to wait on, rather than leaving the caller to send some other way."""
    acct = find_account(address)
    if not acct.can_send():
        try:
            g = enable_send({"account": acct.address})
            if g.get("can_send"):
                return acct
            started = g["note"]
        except Exception as e:  # noqa: BLE001 (whatever stopped it, the caller still needs to hear why it can't send)
            started = (f"I couldn't start granting it ({e}): enable_send with account {acct.address} tries again, or "
                       "connect with send: true gives a link for the user")
        raise ValueError(f"{acct.address} can only read so far, so I can't write drafts or send from it yet. {started}")
    return acct


# Granting send access


GRANTS_PATH = os.path.join(HOME, "grants.json")
GRANT_MAC = os.environ.get("GMAIL_GRANT_MAC", "local")
"""The Mac whose Chrome drives Google's consent: the Mac mini, always awake and signed in to the user's Google accounts."""
GRANT_HOURS = 72
"""How long a grant waits on the user, its tab held all the while."""
grant_lock = threading.RLock()
waiting = set()
"""Accounts whose grant has a waiter running now."""


def grants():
    try:
        with open(GRANTS_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def keep_grant(address, info):
    """Remembers a grant under way (its ask, tab and how far it got), or forgets it (info None)."""
    with grant_lock:
        stored = grants()
        if info is None:
            stored.pop(address, None)
        else:
            stored[address] = info
        with open(GRANTS_PATH + ".new", "w") as f:
            json.dump(stored, f)
        os.replace(GRANTS_PATH + ".new", GRANTS_PATH)


def new_id():
    """A record id as the core makes them: the time in ms, then random."""
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(10)}"


def granted_send(address):
    return SEND_SCOPE in google.granted(address)


def ask_open(ask_id):
    try:
        return bool(brain(f'asks | where id == "{ask_id}" and open | project id'))
    except RuntimeError:
        return True  # Can't tell: better a card twice than none.


def wait_granted(address, seconds=45):
    """Waits for Google's code to come back through the core's callback to finish, which stores the new scopes."""
    until = time.time() + seconds
    while time.time() < until:
        if granted_send(address):
            return True
        time.sleep(1)
    return granted_send(address)


def callback_host():
    return urllib.parse.urlsplit(google.callback()).hostname


def grant_ask(address, outcome, tab, why=None, replaces=None):
    """Puts the grant in the user's queue: an approval whose Approve presses Google's Continue (the page is ready), or a card
    with the tab live on it when a step on the way is his alone. Returns its id."""
    ask_id, entity = new_id(), f"gmail-account:{slug(address)}"
    because = f" {why.rstrip('.')}." if why else " Until then an email from it can't go on an Approve & send card, so it has to go out by hand."
    if outcome["state"] == "ready":
        body = {
            "type": "approval",
            "text": (f"**Let me send email from {address}?** Right now I can only read it.{because} With send access, an "
                     "email from it goes on one card: you Approve & send, and I check it's in Sent. I've gone through "
                     "Google's pages up to the last one (\"Manage drafts and send emails\"), and Approve presses its "
                     "Continue. I'll still send only what you approve."),
        }
    else:
        body = {
            "type": "task",
            "text": (f"**Finish letting me send email from {address}.** I went through Google's pages in the Mac mini's "
                     f"Chrome, but {outcome['why'][0].lower() + outcome['why'][1:]}. Finish that in the tab, then Continue "
                     f"on Google's last page (\"Manage drafts and send emails\").{because}"),
            "portal": {"target": f"macos@{tab.mac}", "session": tab.session},
        }
        body["assists"] = [{"label": "Show the tab", "target": f"macos@{tab.mac}", "action": "browser", "args": {"op": "show", "session": tab.session}}]
    body["resolve_when"] = f'entities | where id == "{entity}" and facts.can_send == true'
    if replaces:
        body["notify"] = False
    record("ask", body, [entity], stream="asks", id=ask_id)
    return ask_id


def enable_send(args, progress=lambda m: None):
    """Gives an account send access (gmail.compose) with one approval of the user's: see grant.py."""
    address = (args.get("account") or args.get("address") or "").strip()
    try:
        address = find_account(address).address
    except ValueError:
        if "@" not in address:
            raise
        address = address.lower()  # Not connected yet: the grant connects it, read and send at once.
    if SWITCH:
        from authorize import authorize
        result = authorize(address)
        return {**result, "account": address, "can_send": result.get("connected", False), "state": "granted" if result.get("connected") else "blocked"}
    if granted_send(address):
        return {"account": address, "can_send": True, "note": f"{address} can send already: nothing to grant."}
    with grant_lock:
        g = grants().get(address)
        if g and ask_open(g["ask"]) and not args.get("approved"):
            if address not in waiting:
                start_waiter(address)
            return {"account": address, "can_send": False, "state": "waiting_on_user", "ask": g["ask"],
                    "note": (f"It's already in the user's queue (ask {g['ask']}): once he approves, I press Google's Continue "
                             "and it can send. Wait on that ask (the brain's wait op) or follow it, then call again.")}
    tab = grant.Tab(args.get("mac") or GRANT_MAC, f"gmail-send-{slug(address)}")
    outcome = grant.drive(tab, google.consent_url(address, [SEND_SCOPE]), address, callback_host(), time.time() + 100,
                          approved=bool(args.get("approved")), progress=progress)
    if outcome["state"] == "granted" and wait_granted(address):
        tab.release()
        return finished(address, "The user asked for it")
    tab.hold(GRANT_HOURS)
    if g and ask_open(g["ask"]):
        # Approved in so many words while a card waited: that card is moot now that it's done, or replaced below.
        resolve(g["ask"], "Done another way" if granted_send(address) else "Replaced by a new card")
    ask_id = grant_ask(address, outcome, tab, args.get("why"))
    keep_grant(address, {"ask": ask_id, "mac": tab.mac, "session": tab.session, "state": outcome["state"],
                         "why": args.get("why"), "at": int(time.time() * 1000)})
    start_waiter(address)
    if outcome["state"] == "ready":
        note = (f"I've put \"Let me send email from {address}?\" in the user's queue (ask {ask_id}), with Google's last page "
                "held in the Mac mini's Chrome: his Approve presses its Continue and it can send. Wait on that ask (the "
                "brain's wait op) or follow it, then call again. An email that can't wait for him goes out through Gmail "
                "in the Mac mini's Chrome, as before.")
    else:
        note = (f"Google stopped on a step only the user can take ({outcome['why']}), so his queue has a card with that tab "
                f"live on it (ask {ask_id}); once he finishes, it can send. Wait on that ask or follow it, then call again.")
    return {"account": address, "can_send": False, "state": "waiting_on_user", "ask": ask_id, "page": outcome.get("where"), "note": note}


def resolve(ask_id, note):
    """Closes a grant's card that isn't needed anymore."""
    app.emit("ask.resolved", {"note": note}, refs=[f"answers:{ask_id}"])


def finished(address, how):
    keep_grant(address, None)
    acct = accounts.get(address)
    if acct:
        report(acct, force=True)
    return {"account": address, "can_send": True, "state": "granted",
            "note": f"{address} can send now ({how}): draft, approval and send work from it."}


def start_waiter(address):
    with grant_lock:
        if address in waiting:
            return
        waiting.add(address)
    threading.Thread(target=waiter, args=(address,), name=f"grant-{address}", daemon=True).start()


def waiter(address):
    """Waits on a grant's card, and does what its answer says: Approve (or Done) presses Google's Continue, from a fresh
    consent when the held page went stale; anything else lets the tab go."""
    try:
        while True:
            g = grants().get(address)
            if not g:
                return
            left = g["at"] / 1000 + GRANT_HOURS * 3600 - time.time()
            tab = grant.Tab(g["mac"], g["session"])
            if left <= 0:
                tab.release()
                resolve(g["ask"], "Lapsed: nobody needed it for three days")
                keep_grant(address, None)
                return
            r = subprocess.run(["sb", "wait", g["ask"], "--timeout", f"{int(min(left, 6 * 3600))}s"], capture_output=True, text=True)
            if r.returncode == 2:
                continue  # Still open: wait on.
            if r.returncode != 0:
                log(f"grant for {address}: sb wait failed ({r.stderr.strip()[-300:]}); trying again in a minute")
                time.sleep(60)
                continue
            if grants().get(address, {}).get("ask") != g["ask"]:
                continue  # A newer card took its place.
            closed = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {}
            closing = closed.get("closing") or {}
            choice = ((closing.get("body") or {}).get("choice") or "").lower()
            if granted_send(address):
                tab.release()
                finished(address, "granted from the card's tab" if g["state"] != "ready" else "granted")
                return
            if closing.get("kind") == "answer" and choice in ("approve", "approved", "yes", "done", "allow"):
                log(f"grant for {address}: The user said {choice}; pressing Google's Continue")
                outcome = grant.drive(tab, None, address, callback_host(), time.time() + 60, approved=True)
                if outcome["state"] != "granted":
                    # The held page went stale (or he left it elsewhere): a fresh consent, approved this time.
                    outcome = grant.drive(tab, google.consent_url(address, [SEND_SCOPE]), address, callback_host(),
                                          time.time() + 100, approved=True)
                if outcome["state"] == "granted" and wait_granted(address):
                    tab.release()
                    finished(address, "The user approved")
                    return
                tab.hold(GRANT_HOURS)
                ask_id = grant_ask(address, {**outcome, "state": "person"} if outcome["state"] != "person" else outcome,
                                   tab, g.get("why"), replaces=g["ask"])
                keep_grant(address, {**g, "ask": ask_id, "state": "person", "at": int(time.time() * 1000)})
                continue
            log(f"grant for {address}: its card closed without a yes ({closed.get('closed_as')}); letting the tab go")
            tab.release()
            keep_grant(address, None)
            return
    except Exception as e:  # noqa: BLE001 (a waiter that dies must not take the inbox sense with it)
        log(f"grant for {address} stopped: {e}")
    finally:
        with grant_lock:
            waiting.discard(address)


def resume_grants():
    """Grants still waiting on the user when it restarted: wait on their cards again."""
    if IDLE:
        return
    for address in grants():
        start_waiter(address)


DRAFTS_PATH = os.path.join(HOME, "drafts.json")
ATTRIBUTION = re.compile(r"(?m)^On [^\n]{0,300}?(?:\n[^\n]{0,300}?)?wrote:[ \t]*$")
"""Where Gmail's quote of the message a reply answers starts: its "On <date> <who> wrote:" line, sometimes wrapped."""


def made_drafts():
    """The drafts this made, by id: their account, thread, when, and the words it wrote, so a later edit in Gmail
    shows as one."""
    try:
        with open(DRAFTS_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def keep_draft(draft_id, info):
    """Remembers a draft this made, or forgets it (info None) once it's sent or discarded."""
    stored = made_drafts()
    if info is None:
        stored.pop(draft_id, None)
    else:
        stored[draft_id] = info
    with open(DRAFTS_PATH + ".new", "w") as f:
        json.dump(stored, f)
    os.replace(DRAFTS_PATH + ".new", DRAFTS_PATH)


SENT_DRAFTS_PATH = os.path.join(HOME, "sent_drafts.json")
"""Which draft each sent message went out as (message id -> draft id), so its record says so, however often it's seen."""


def sent_drafts():
    try:
        with open(SENT_DRAFTS_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def keep_sent_draft(message_id, draft_id):
    with state_lock:
        stored = {**sent_drafts(), message_id: draft_id}
        with open(SENT_DRAFTS_PATH + ".new", "w") as f:
            json.dump(stored, f)
        os.replace(SENT_DRAFTS_PATH + ".new", SENT_DRAFTS_PATH)


LINK = re.compile(r"https?://\S+")


def carries(text, words):
    """Whether a sent message's text is the draft's words: the same words (however wrapped), or, when he touched them
    up in Gmail, every link the draft carried (a payment link, a file's link) still in it."""
    own = split_quote(text)[0]
    if same(own, words):
        return True
    links = {l.rstrip(".,;:!?)>\"'") for l in LINK.findall(words or "")}
    return bool(links) and all(l in (text or "") for l in links)


def went_as(acct, draft_id, mine, message_id):
    """Whether this sent message is that draft of mine, sent (from the card or from Gmail), and not some other reply in
    its thread: Gmail's own draft id answering with it as SENT, the draft's own message id, or (the draft gone) its
    words or links in it."""
    try:
        d = acct.get(f"drafts/{draft_id}", format="minimal")
        labels = d["message"].get("labelIds", [])
        if "DRAFT" in labels:
            return False  # Still a draft: this is another message, not it.
        if "SENT" in labels:
            return d["message"]["id"] == message_id
    except HttpError as e:
        if e.status != 404:
            raise
    if mine.get("message_id") == message_id:
        return True
    m = acct.get(f"messages/{message_id}", format="full")
    return carries(text_of(m.get("payload", {})), mine.get("body"))


def draft_of(acct, m):
    """The draft of mine a sent message went out as, if it's one: known from the send, else worked out once and kept."""
    known_as = sent_drafts().get(m["id"])
    if known_as:
        return known_as
    when = int(m.get("internalDate", 0))
    for draft_id, mine in made_drafts().items():
        if mine.get("account") != acct.address or mine.get("thread") != m["threadId"] or when < mine.get("at", 0) - 60_000:
            continue
        try:
            if went_as(acct, draft_id, mine, m["id"]):
                keep_sent_draft(m["id"], draft_id)
                keep_draft(draft_id, None)
                return draft_id
        except (HttpError, OSError, KeyError) as e:
            log(f"{acct.address}: couldn't tell whether {m['id']} is draft {draft_id} sent ({e})")
    return None


def split_quote(text):
    """A message's own words, and the quote of what it answers under them (from Gmail's "On … wrote:" line on)."""
    text = (text or "").replace("\r\n", "\n")
    m = ATTRIBUTION.search(text)
    return (text[:m.start()].rstrip(), text[m.start():].strip() + "\n") if m else ((text or "").rstrip(), "")


def same(a, b):
    """The same words, however they're wrapped or spaced (Gmail rewraps what it saves)."""
    return re.sub(r"\s+", " ", a or "").strip() == re.sub(r"\s+", " ", b or "").strip()


ZONE = os.environ.get("GMAIL_TZ", "America/Los_Angeles")
"""The zone Gmail shows the user's times in (his account's), for the "On <date> … wrote:" line, as Gmail's own reply writes it."""


def attribution(m):
    """When a message was sent and who sent it, as Gmail's "On <date> <who> wrote:" line has them: (when, name, address),
    the time in his zone, as Gmail's own reply says it, whatever zone the sender's Date header was in."""
    h = m.get("payload", {}).get("headers", [])
    try:
        d = email.utils.parsedate_to_datetime(header(h, "Date"))
        if d.tzinfo:
            d = d.astimezone(zoneinfo.ZoneInfo(ZONE))
        when = f"{d:%a}, {d:%b} {d.day}, {d.year} at {d.hour % 12 or 12}:{d:%M} {'AM' if d.hour < 12 else 'PM'}"
    except (TypeError, ValueError):
        when = header(h, "Date") or "an earlier day"
    name, address = email.utils.parseaddr(header(h, "From"))
    return when, name, address


def quoted(m):
    """Gmail's own quote of a message, for a reply to it: "On <date> <who> wrote:", then its text with each line marked."""
    when, name, address = attribution(m)
    lines = "\n".join(">" + line if line.startswith(">") else ("> " + line if line else ">")
                      for line in text_of(m.get("payload", {})).strip().splitlines())
    return f"On {when} {name + ' ' if name else ''}<{address}> wrote:\n{lines}\n"


QUOTE_STYLE = "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"


def html_of(part):
    """A message's own HTML part, decoded (its first text/html), or "" when it has none."""
    def walk(p):
        yield p
        for c in p.get("parts", []):
            yield from walk(c)
    for p in walk(part):
        data = p.get("body", {}).get("data")
        if p.get("mimeType") == "text/html" and data:
            return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode(errors="replace")
    return ""


def embeddable(page):
    """An HTML message's body made fit to sit inside another's: what's inside <body> (or all of it), without the head,
    scripts, styles (which would restyle the reply), forms, or the inline images that live in its own message (cid:),
    which a reply doesn't carry. Gmail sanitizes the rest when it shows it."""
    body = re.search(r"(?is)<body[^>]*>(.*?)(?:</body>|$)", page)
    page = body.group(1) if body else re.sub(r"(?is)<head[^>]*>.*?</head>|</?html[^>]*>|<!doctype[^>]*>", "", page)
    page = re.sub(r"(?is)<(script|style|title|iframe|object|embed|form|textarea|select|button)\b.*?</\1\s*>", "", page)
    page = re.sub(r"(?is)<(meta|link|base|input|script|style)\b[^>]*>", "", page)
    page = re.sub(r"(?is)<img\b[^>]*\bsrc\s*=\s*[\"']?cid:[^>]*>", "", page)
    return page.strip()


def html_words(text):
    """Plain words as Gmail's composer writes them in HTML: escaped, links linked, each line its own, in a ltr div."""
    out = []
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        pos, bits = 0, []
        for l in LINK.finditer(line):
            url = l.group(0).rstrip(".,;:!?)>\"'")
            bits += [html.escape(line[pos:l.start()]), f'<a href="{html.escape(url)}">{html.escape(url)}</a>']
            pos = l.start() + len(url)
        bits.append(html.escape(line[pos:]))
        out.append("".join(bits).replace("  ", " &nbsp;"))
    return '<div dir="ltr">' + "<br>".join(out) + "</div>"


def quoted_html(m):
    """Gmail's own HTML quote of a message (the gmail_quote it hides behind "•••"): its attribution line, then the message
    in a blockquote: its own HTML when it has one, else its text."""
    when, name, address = attribution(m)
    who = (html.escape(name) + " " if name else "") + f'&lt;<a href="mailto:{html.escape(address)}">{html.escape(address)}</a>&gt;'
    page = html_of(m.get("payload", {}))
    inner = embeddable(page) if page.strip() else html_words(text_of(m.get("payload", {})).strip())
    return (f'<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On {html.escape(when)} {who} wrote:<br></div>'
            f'<blockquote class="gmail_quote" style="{QUOTE_STYLE}">{inner}</blockquote></div>')


def quote_from_text(quote):
    """An HTML quote made from a text one ("On … wrote:" then "> " lines), for a draft written before replies had HTML."""
    head, _, rest = (quote or "").strip().partition("\n")
    if not head:
        return ""
    if not head.rstrip().endswith("wrote:"):
        more, _, rest = rest.partition("\n")
        head = f"{head} {more}"
    lines = [re.sub(r"^> ?", "", line) for line in rest.split("\n")]
    return (f'<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">{html.escape(head.strip())}<br></div>'
            f'<blockquote class="gmail_quote" style="{QUOTE_STYLE}">{html_words(chr(10).join(lines).strip())}</blockquote></div>')


QUOTE_START = re.compile(r'(?i)<div[^>]*class="gmail_quote\b')


def quote_of_html(page):
    """The gmail_quote a message's HTML ends with (ours, or Gmail's own in a draft he edited there), or ""."""
    m = QUOTE_START.search(page or "")
    if not m:
        return ""
    rest = page[m.start():]
    return re.sub(r"(?is)\s*</body>\s*</html>\s*$|\s*</body>\s*$", "", rest).strip()


def compose(m, body, quote="", quote_html=""):
    """Gives a message its words: a text part (the words, then the text quote) and beside it, as Gmail's own replies have,
    an HTML part (the words, then the quote as a gmail_quote, which Gmail hides behind "•••")."""
    body = body.rstrip()
    m.set_content(f"{body}\n\n{quote}" if quote else f"{body}\n")
    if quote and not quote_html:
        quote_html = quote_from_text(quote)
    m.add_alternative(f'<html><body>{html_words(body)}{"<br>" + quote_html if quote_html else ""}</body></html>\n', subtype="html")


def latest(acct, thread):
    """The message a reply in this thread answers: its latest that isn't a draft, as Gmail's own Reply does."""
    msgs = [m for m in acct.get(f"threads/{thread}", format="minimal").get("messages", [])
            if "DRAFT" not in m.get("labelIds", [])]
    if not msgs:
        raise ValueError(f"thread {thread} has no message to reply to")
    return max(msgs, key=lambda m: int(m.get("internalDate", 0)))["id"]


def addresses(value):
    return email.utils.getaddresses([", ".join(value) if isinstance(value, list) else value or ""])


SEND_AS_S = 600
"""How long an account's send-as addresses are taken as read: they change only when he adds an alias."""
send_as_seen = {}


def send_as_of(acct):
    """An account's send-as addresses (its own first), read again after SEND_AS_S."""
    at, found = send_as_seen.get(acct.address, (0, None))
    if found is None or time.time() - at > SEND_AS_S:
        found = acct.get("settings/sendAs").get("sendAs", [])
        send_as_seen[acct.address] = (time.time(), found)
    return found


def recipients(acct, orig, send_as, reply_all=False, to=None, cc=None):
    """Who a reply to `orig` goes to, as (to, cc) lists of addresses, the way Gmail's own Reply and Reply all do: to
    whoever wrote it (its Reply-To when it has one, which takes the sender's place), or for a message of his own, to
    whom it went. With reply_all, the others it went to stay in To and those it copied stay in Cc. Never one of his
    own addresses (unless it went to nobody else), never anyone twice. A `to` given is who it's to instead (with
    reply_all, everyone else on it goes in Cc); a `cc` given is added to Cc."""
    h = orig.get("payload", {}).get("headers", [])
    mine = {s["sendAsEmail"].lower() for s in send_as} | {acct.address.lower()}
    ours = "SENT" in orig.get("labelIds", [])
    author = addresses(header(h, "To") if ours else header(h, "Reply-To") or header(h, "From"))
    others_to = [] if ours else addresses(header(h, "To"))
    others_cc = addresses(header(h, "Cc"))
    if to:
        to_list, cc_list = addresses(to), (author + others_to + others_cc if reply_all else [])
    else:
        to_list, cc_list = author + (others_to if reply_all else []), (others_cc if reply_all else [])
    cc_list += addresses(cc)
    seen = set()

    def keep(people, own_ok=False):
        kept = []
        for n, a in people:
            if a and a.lower() not in seen and (own_ok or a.lower() not in mine):
                seen.add(a.lower())
                kept.append(email.utils.formataddr((n, a)))
        return kept

    to_out = keep(to_list) or keep(to_list, own_ok=True)
    return to_out, keep(cc_list)


def own(send_as, value):
    """The first of the addresses in a header value that is one of his send-as addresses, as that alias."""
    by = {x["sendAsEmail"].lower(): x for x in send_as}
    return next((by[a.lower()] for _, a in addresses(value) if a and a.lower() in by), None)


def sender_of(acct, address):
    """A send-as address as a From header, with the name his addresses go out under; refuses one that isn't his."""
    send_as = send_as_of(acct)
    alias = next((s for s in send_as if s["sendAsEmail"].lower() == address.lower()), None)
    if not alias:
        raise ValueError(f"{address} isn't a send-as address of {acct.address} (it has {', '.join(s['sendAsEmail'] for s in send_as)})")
    return email.utils.formataddr((alias.get("displayName") or next((s["displayName"] for s in send_as if s.get("displayName")), ""),
                                   alias["sendAsEmail"]))


def thread_alias(acct, orig, send_as):
    """Which of his send-as addresses a reply to `orig` goes from, and why, the way the thread already speaks: the
    address they wrote to (To, then Cc, then Delivered-To) on their latest message in the thread, `orig` first, else
    the From of his latest message there. What they write to outranks what he last sent from, so one reply that went
    from the wrong address isn't followed. None when nothing in the thread names one of his send-as addresses."""
    msgs = [m for m in acct.get(f"threads/{orig['threadId']}", format="metadata",
                                metadataHeaders=["From", "To", "Cc", "Delivered-To"]).get("messages", [])
            if "DRAFT" not in m.get("labelIds", [])]
    newest = sorted(msgs, key=lambda m: -int(m.get("internalDate", 0)))
    theirs = [orig] * ("SENT" not in orig.get("labelIds", [])) + [m for m in newest if "SENT" not in m.get("labelIds", [])]
    for m in theirs:
        h = m.get("payload", {}).get("headers", [])
        for field in ("To", "Cc", "Delivered-To"):
            alias = own(send_as, header(h, field))
            if alias:
                return alias, "the address they wrote to"
    for m in (m for m in newest if "SENT" in m.get("labelIds", [])):
        alias = own(send_as, header(m.get("payload", {}).get("headers", []), "From"))
        if alias:
            return alias, "the address his earlier messages in this thread came from"
    return None


def build(acct, args):
    """The message as an EmailMessage, the thread it belongs in, and its envelope. A reply (reply_to: a message id, or
    thread: a thread id, answering its latest message) goes in that thread with In-Reply-To and References set, to
    whoever wrote it unless `to` says otherwise (everyone on it with reply_all, as Gmail's Reply all does: see
    recipients), with Gmail's quote of what it answers under the words unless quote is false. It goes from `from`
    when given, else for a reply from the alias the thread uses (see thread_alias), else the account's default."""
    send_as = send_as_of(acct)
    reply_to = args.get("reply_to") or (latest(acct, args["thread"]) if args.get("thread") else None)
    orig = acct.get(f"messages/{reply_to}", format="full") if reply_to else None
    picked = None if args.get("from") or not orig else thread_alias(acct, orig, send_as)
    if args.get("from"):
        alias, why = next((s for s in send_as if s["sendAsEmail"].lower() == args["from"].lower()), None), "the address asked for"
        if not alias:
            raise ValueError(f"{args['from']} isn't a send-as address of {acct.address} (it has {', '.join(s['sendAsEmail'] for s in send_as)})")
    elif picked:
        alias, why = picked
    else:
        alias = next((s for s in send_as if s.get("isDefault")), None) or {"sendAsEmail": acct.address}
        why = "the account's default address"
    # An address with no name of its own goes out under the name his other addresses use, not bare.
    name = alias.get("displayName") or next((s["displayName"] for s in send_as if s.get("displayName")), "")
    m, thread, answered, quote, quote_html = email.message.EmailMessage(), None, None, "", ""
    m["From"] = email.utils.formataddr((name, alias["sendAsEmail"]))
    to, cc, subject = args.get("to"), args.get("cc"), args.get("subject")
    if orig:
        h = orig.get("payload", {}).get("headers", [])
        to, cc = recipients(acct, orig, send_as, args.get("reply_all"), to, cc)
        cc = cc or None
        original = header(h, "Subject")
        subject = subject or (original if original.lower().startswith("re:") else f"Re: {original}")
        if header(h, "Message-ID"):
            m["In-Reply-To"] = header(h, "Message-ID")
            m["References"] = " ".join(x for x in (header(h, "References"), header(h, "Message-ID")) if x)
        thread, answered = orig["threadId"], reply_to
        if args.get("quote", True):
            quote, quote_html = quoted(orig), quoted_html(orig)
    if not to or not subject:
        raise ValueError("say who it's to and its subject, or give reply_to (a message id) or thread (a thread id) to "
                         "answer in a thread")
    m["To"] = ", ".join(to) if isinstance(to, list) else to
    for field, value in (("cc", cc), ("bcc", args.get("bcc"))):
        if value:
            m[field.title()] = ", ".join(value) if isinstance(value, list) else value
    m["Subject"] = subject
    compose(m, args["body"], quote, quote_html)
    names = []
    for a in args.get("attachments") or []:
        data, filename, kind = attachment(a)
        main, _, sub = kind.partition("/")
        m.add_attachment(data, maintype=main, subtype=sub or "octet-stream", filename=filename)
        names.append(filename)
    envelope = {"from": str(m["From"]), "from_address": alias["sendAsEmail"], "from_why": why, "to": str(m["To"]), "cc": str(m["Cc"] or ""), "subject": subject,
                "reply_to": answered, "quoted": bool(quote), "attachments": names}
    return m, thread, envelope


def raw(m, thread=None):
    return {"raw": base64.urlsafe_b64encode(m.as_bytes()).decode(), **({"threadId": thread} if thread else {})}


def files(part, parent=None):
    """The files attached to a message (an email.message or the API's payload): not its text, and not the images its
    HTML shows inline, which sit in a multipart/related beside it."""
    if isinstance(part, dict):
        kids, kind, name = part.get("parts", []), part.get("mimeType", ""), part.get("filename")
    else:
        kids, kind, name = list(part.iter_parts()) if part.is_multipart() else [], part.get_content_type(), part.get_filename()
    if kind.startswith("multipart/"):
        return [f for k in kids for f in files(k, kind)]
    return [part] if name and parent != "multipart/related" else []


def rewrite(acct, draft, text, body, sender=None):
    """Puts approved words in a draft: its headers, attachments and quote of what it answers stay, its words become
    `body`, so what goes out is exactly what was approved, edits included. A sender given (a formatted From) replaces
    its From."""
    old = email.parser.BytesParser(policy=email.policy.default).parsebytes(
        base64.urlsafe_b64decode(acct.get(f"drafts/{draft['id']}", format="raw")["message"]["raw"]))
    m = email.message.EmailMessage()
    for field in ("From", "To", "Cc", "Bcc", "Subject", "In-Reply-To", "References"):
        if field == "From" and sender:
            m[field] = sender
        elif old[field]:
            m[field] = old[field]
    quote = split_quote(text)[1]
    # The quote stays as it was: the draft's own gmail_quote (Gmail's, if he edited it there), else made from its text.
    page = next((p.get_content() for p in old.walk() if p.get_content_type() == "text/html" and not p.get_filename()), "")
    compose(m, body, quote, quote_of_html(page))
    kept = files(old)
    if kept:
        # Each file goes on exactly as it was, its headers and bytes untouched, whatever its type: decoding it with
        # get_content() goes through email's content manager, which knows no model/* (STL, 3MF), font/* or the like
        # (a KeyError), and gives text/* back as str, which add_attachment can't take with a maintype.
        m.make_mixed()
        for part in kept:
            m.attach(part)
    acct.put(f"drafts/{draft['id']}", {"id": draft["id"], "message": raw(m, draft["message"]["threadId"])})


def find_draft(acct, args):
    """The draft meant, in full: by its id (None once it's sent or gone), or the one in a thread (the one this made, when the
    thread has several)."""
    if args.get("draft"):
        try:
            d = acct.get(f"drafts/{args['draft']}", format="full")
        except HttpError as e:
            if e.status == 404:
                return None
            raise
        # Gmail still answers a sent draft's id, with the sent message (labelled SENT, not DRAFT).
        return d if "DRAFT" in d["message"].get("labelIds", []) else None
    found, page = [], None
    while True:
        res = acct.get("drafts", maxResults=500, pageToken=page)
        found += [d for d in res.get("drafts", []) if d["message"]["threadId"] == args["draft_thread"]]
        page = res.get("nextPageToken")
        if not page:
            break
    mine = [d for d in found if d["id"] in made_drafts()]
    if len(found) > 1 and len(mine) == 1:
        found = mine
    if not found:
        return None
    if len(found) > 1:
        raise ValueError(f"{len(found)} drafts in thread {args['draft_thread']} ({', '.join(d['id'] for d in found)}); "
                         "give the draft's id")
    return acct.get(f"drafts/{found[0]['id']}", format="full")


def described(acct, d):
    """A draft as the tools show it: who it's to, its words and whether it quotes what it answers."""
    msg = d["message"]
    h = msg.get("payload", {}).get("headers", [])
    words, quote = split_quote(text_of(msg.get("payload", {})))
    mine = made_drafts().get(d["id"])
    return {
        "draft_id": d["id"], "message_id": msg["id"], "thread_id": msg["threadId"], "account": acct.address,
        **{k.lower(): header(h, k) for k in ("From", "To", "Cc", "Subject")},
        "words": words, "quoted": bool(quote),
        "attachments": [p["filename"] for p in files(msg.get("payload", {}))],
        "updated": int(msg.get("internalDate", 0)),
        "made_by_me": bool(mine), "edited_in_gmail": bool(mine) and not same(words, mine["body"]),
        "link": draft_link(acct, msg),
    }


def draft_link(acct, msg):
    """Opens the draft in Gmail: a reply inside its thread, a new email in the compose window."""
    base = f"https://mail.google.com/mail/?authuser={urllib.parse.quote(acct.address)}"
    return f"{base}#all/{msg['threadId']}" if msg["threadId"] != msg["id"] else f"{base}#drafts?compose={msg['id']}"


def sent_since(acct, draft_id, mine):
    """The message a draft of mine went out as from Gmail itself, if it did: never just any later reply in its thread."""
    for message_id, did in sent_drafts().items():
        if did == draft_id:
            return message_id
    sent = sorted((m for m in acct.get(f"threads/{mine['thread']}", format="minimal").get("messages", [])
                   if "SENT" in m.get("labelIds", []) and int(m.get("internalDate", 0)) >= mine["at"] - 60_000),
                  key=lambda m: -int(m.get("internalDate", 0)))
    for m in sent:
        if went_as(acct, draft_id, mine, m["id"]):
            keep_sent_draft(m["id"], draft_id)
            return m["id"]
    return None


def words_of(d):
    """A draft's own words as he'd see them in Gmail's composer, above the quote of what it answers: read from its HTML
    (each div or break a line; Gmail rewraps the text part it saves), else its text."""
    page = html_of(d["message"].get("payload", {}))
    if not page.strip():
        return split_quote(text_of(d["message"].get("payload", {})))[0]
    m = QUOTE_START.search(page)
    page = page[:m.start()] if m else page
    page = re.sub(r"(?is)<(script|style|head).*?</\1>", "", page)
    page = re.sub(r"(?i)<br\s*/?>\s*(</div>)", r"\1", page)  # Gmail's empty line: <div><br></div>
    page = re.sub(r"(?i)<(div|p)\b[^>]*>|<br\s*/?>", "\n", page)
    words = html.unescape(re.sub(r"<[^>]+>", "", page)).replace("\xa0", " ")
    return "\n".join(line.rstrip() for line in words.split("\n")).strip()


def draft_words(args):
    """A draft's words, kept as one version with the card that shows them: read, or with text, written in place of its
    words (its recipients, subject, quote and attachments stay)."""
    acct = sendable(args["account"])
    d = find_draft(acct, {"draft": args["draft"]})
    if d is None:
        return {"gone": True}
    if args.get("text") is not None:
        if not args["text"].strip():
            raise ValueError("text is empty: a draft's words can't be cleared from the card")
        if not same(args["text"], words_of(d)):
            rewrite(acct, d, text_of(d["message"].get("payload", {})), args["text"])
            d = find_draft(acct, {"draft": args["draft"]})
            if d is None:
                return {"gone": True}
    return {"text": words_of(d)}


def make_draft(args):
    """Writes an email (a reply in a thread, or a new one) into Gmail's Drafts, sending nothing. Writing again in the
    same thread updates the draft this made there (for a new email, the one it made to the same people with the same
    subject), unless the user has edited it in Gmail since."""
    acct = sendable(args["account"])
    if not (args.get("body") or "").strip():
        raise ValueError("body is required: the words, exactly as he'll approve them")
    m, thread, envelope = build(acct, args)
    made = made_drafts()
    replace = args.get("replace") or next((i for i, v in made.items() if v["account"] == acct.address and (
        v["thread"] == thread if thread else
        v.get("new") and v.get("to") == envelope["to"] and v.get("subject") == envelope["subject"])), None)
    d = None
    if replace:
        old = find_draft(acct, {"draft": replace})
        if old is None:
            keep_draft(replace, None)
        else:
            words = split_quote(text_of(old["message"].get("payload", {})))[0]
            if not args.get("replace") and replace in made and not same(words, made[replace]["body"]):
                raise ValueError(f"The user edited my draft {replace} in Gmail since I wrote it, so I left it alone. His "
                                 f"words now: {words!r}. Give replace: \"{replace}\" to write over it anyway.")
            d = acct.put(f"drafts/{replace}", {"id": replace, "message": raw(m, thread)})
    if d is None:
        d = acct.post("drafts", {"message": raw(m, thread)})
    new = not thread
    thread, at = d["message"]["threadId"], int(time.time() * 1000)
    keep_draft(d["id"], {"account": acct.address, "thread": thread, "body": args["body"], "at": at, "message_id": d["message"]["id"],
                         "to": envelope["to"], "subject": envelope["subject"], **({"new": True} if new else {})})
    link = draft_link(acct, d["message"])
    people = addresses(envelope["to"])
    label = (f"Email to {people[0][0]} ({people[0][1]})" if len(people) == 1 and people[0][0] else
             "Email to " + ", ".join(n or a for n, a in people)) + f" · from {envelope['from_address']}"
    return {
        "draft_id": d["id"], "message_id": d["message"]["id"], "thread_id": thread, "account": acct.address,
        **envelope, "body": args["body"], "updated": bool(replace and d["id"] == replace), "link": link,
        "approval": {
            "drafts": [{"name": "reply", "label": label, "text": args["body"], "copy": copy_of(acct.address, d["id"])}],
            "from_line": from_line(envelope["from_address"], envelope["from_why"]),
            "assists": [
                {"label": "Send", "target": INSTANCE, "action": "send",
                 "args": {"account": acct.address, "draft": d["id"], "body": "{{draft:reply}}", "key": f"draft:{d['id']}"}},
                {"label": "Open in Gmail", "url": link},
            ],
            # This draft going out closes it, not any other reply in its thread (his own, say).
            "resolve_when": f'stream("comms/gmail") | where at > {at} and body.facts.sent == true and body.facts.draft_id == "{d["id"]}"',
        },
    }


def copy_of(account, draft_id):
    """Where a card's draft also lives, so the card and the Gmail draft stay one version: draft_words reads and writes it."""
    return {"target": INSTANCE, "action": "draft_words", "args": {"account": account, "draft": draft_id}}


def from_line(address, why=None):
    """The sentence an approval card says which address an email goes from in."""
    return f"It goes from {address}" + (f", {why}." if why else ".")


FIELD_NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
"""A draft's name on the card, which its Send button names as {{draft:<name>}}."""


def who(people, full=False):
    """Who an email is to, as a person would say it: the first one's first name (full: their name and address), and
    how many others."""
    if not people:
        return "nobody"
    name, address = people[0]
    first = (f"{name} ({address})" if name else address) if full else (name.split()[0] if name.strip() else address.split("@")[0])
    return first + (f" +{len(people) - 1}" if len(people) > 1 else "")


SHAPE = ("thread", "reply_to", "reply_all", "quote", "to", "cc", "bcc", "subject", "from", "attachments")
"""What says how an email is made up. A draft named with none of it is taken as it is (its words changed at most);
with any, it's written over afresh, as draft's replace does."""


def existing(e):
    return bool(e.get("draft")) and not any(k in e for k in SHAPE)


def card_blob(a):
    """An email's attachment as the card shows it ({blob, type, name}): a blob as it is, a path on this server stored
    as one first."""
    if isinstance(a, str):
        a = {"path": a}
    if a.get("blob"):
        name = a.get("name") or "attachment"
        blob, size = a["blob"], a.get("bytes") or SIZES.get(a["blob"])
    else:
        path = os.path.expanduser(a["path"])
        name = a.get("name") or os.path.basename(path)
        r = subprocess.run(["sb", "blob", "put", path], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip() or f"sb blob put {path} failed")
        stored = json.loads(r.stdout)
        blob, size = stored["blob"], stored.get("bytes")
    return {"blob": blob, "type": a.get("type") or mimetypes.guess_type(name)[0] or "application/octet-stream", "name": name,
            **({"bytes": size} if size else {})}


def make_approval(args):
    """Several emails at once, for one approval: writes each into Gmail's Drafts (or takes a draft as it stands),
    sending nothing, and hands back one approval whose Approve & send sends them all, each with his words from the
    card, and whose resolve_when holds once every one of them is sent. All or nothing: if one can't be written, the
    drafts this call made are taken back."""
    emails, default = args.get("emails"), args.get("account")
    if not isinstance(emails, list) or not emails or not all(isinstance(e, dict) for e in emails):
        raise ValueError("emails is a list of the emails to send: each like draft's arguments (thread or reply_to for a "
                         "reply, to and subject for a new email, body, attachments...), or {draft: <id>} for one already "
                         "written, with name and label for its field on the card if you like")
    # Each checked before any is written, so a slip in the fifth leaves nothing behind.
    for i, e in enumerate(emails, 1):
        if not (e.get("account") or default):
            raise ValueError(f"email {i}: say which account it goes out through (account, here or on the email)")
        if e.get("name") and not FIELD_NAME.match(str(e["name"])):
            raise ValueError(f"email {i}: its name {e['name']!r} is for {{{{draft:<name>}}}}: letters, digits, - and _ only")
        if existing(e):
            continue
        if not (e.get("body") or "").strip():
            raise ValueError(f"email {i}: body is required (or give draft: the id of one already written, to send as it stands)")
        if not (e.get("thread") or e.get("reply_to") or (e.get("to") and e.get("subject"))):
            raise ValueError(f"email {i}: give thread or reply_to for a reply, or to and subject for a new email")
    names = [e["name"] for e in emails if e.get("name")]
    if len(names) != len(set(names)):
        raise ValueError(f"two emails share a name: {', '.join(sorted({n for n in names if names.count(n) > 1}))}")

    discarded = []
    for x in args.get("discard") or []:
        x = x if isinstance(x, dict) else {"draft": x}
        discarded.append({"draft_id": x["draft"], **discard({"account": x.get("account") or default, "draft": x["draft"]})})

    at = int(time.time() * 1000)
    written, made, taken = [], [], set(names)
    for i, e in enumerate(emails, 1):
        acct = None
        try:
            acct = sendable(e.get("account") or default)
            if existing(e):
                d = find_draft(acct, {"draft": e["draft"]})
                if d is None:
                    raise ValueError(f"draft {e['draft']} is gone: sent or deleted in Gmail already")
                shown, body = described(acct, d), e.get("body")
                rewritten = bool((body or "").strip()) and not same(body, shown["words"])
                if rewritten:
                    # New words in the draft as it is: its recipients, subject, quote and attachments stay.
                    rewrite(acct, d, text_of(d["message"].get("payload", {})), body)
                words = body if rewritten else shown["words"]
                if not words.strip():
                    raise ValueError(f"draft {e['draft']} has no words yet: give body")
                mine = made_drafts().get(d["id"])
                if rewritten or not mine:
                    # Kept as one I wrote, so his later edits in Gmail, or a send from there, are seen as his.
                    keep_draft(d["id"], {**(mine or {}), "account": acct.address, "thread": shown["thread_id"], "body": words,
                                         "at": (mine or {}).get("at", at), "to": shown["to"], "subject": shown["subject"]})
                info = {"draft_id": d["id"], "thread_id": shown["thread_id"], "account": acct.address, "to": shown["to"],
                        "from_address": (addresses(shown["from"]) or [("", acct.address)])[0][1], "from_why": "as the draft has it",
                        "cc": shown["cc"], "subject": shown["subject"], "body": words,
                        "attachments": shown["attachments"], "link": shown["link"], "updated": rewritten,
                        "as_it_stands": not rewritten}
            else:
                spec = {k: v for k, v in e.items() if k not in ("name", "label", "draft", "account")}
                if e.get("draft"):
                    spec["replace"] = e["draft"]
                info = make_draft({**spec, "account": acct.address})
                info.pop("approval", None)
                if not info["updated"]:
                    made.append((acct, info["draft_id"]))
            twin = next((w for w in written if w["info"]["draft_id"] == info["draft_id"]), None)
            if twin:
                raise ValueError(f"it lands in the same draft as email {twin['i']} (thread {info['thread_id']}): one "
                                 "reply per thread, so put both in one")
        except Exception as ex:
            undone = 0
            for a, did in made:
                try:
                    a.delete(f"drafts/{did}")
                    keep_draft(did, None)
                    undone += 1
                except Exception as gone:  # noqa: BLE001: tell, and carry on taking back the rest
                    log(f"couldn't take back draft {did}: {gone}")
            target = e.get("to") or e.get("thread") or e.get("reply_to") or e.get("draft") or "?"
            raise ValueError(f"email {i} ({target}): {ex}" + (f". I took back the {undone} new draft{'s' if undone != 1 else ''} "
                             "this had written, so nothing's half done." if undone else "")) from None
        people = addresses(info["to"])
        name = e.get("name")
        if not name:
            base = re.sub(r"[^a-z0-9]+", "-", who(people).split(" +")[0].lower()).strip("-")[:30] or "email"
            name, n = base, 2
            while name in taken:
                name, n = f"{base}-{n}", n + 1
        taken.add(name)
        written.append({"i": i, "name": name, "e": e, "info": info, "people": people})

    drafts, sends, blobs, notes = [], [], [], []
    for w in written:
        info, e, name = w["info"], w["e"], w["name"]
        subject = info["subject"] if len(info["subject"]) <= 70 else info["subject"][:69] + "…"
        label = f"To {who(w['people'], full=True)}" + (f" · {subject}" if subject else "") + f" · from {info['from_address']}"
        drafts.append({"name": name, "label": e.get("label") or label, "text": info["body"],
                       "copy": copy_of(info["account"], info["draft_id"])})
        people = w["people"]
        to = (people[0][0] or people[0][1]) + (f" +{len(people) - 1}" if len(people) > 1 else "") if people else "nobody"
        sends.append({"label": f"Send to {to}", "target": INSTANCE, "action": "send",
                      "args": {"account": info["account"], "draft": info["draft_id"], "body": f"{{{{draft:{name}}}}}",
                               "key": f"draft:{info['draft_id']}"}})
        for a in e.get("attachments") or []:
            try:
                b = card_blob(a)
            except (OSError, RuntimeError, ValueError, KeyError) as ex:
                notes.append(f"{a if isinstance(a, str) else a.get('name') or a.get('path')}: goes with the email, but I couldn't put it on the card ({ex})")
                continue
            if all(x["blob"] != b["blob"] for x in blobs):
                blobs.append(b)
    accounts_used = list(dict.fromkeys(w["info"]["account"] for w in written))
    links = [{"label": "Open drafts in Gmail" if len(accounts_used) == 1 else f"Drafts in {a}",
              "url": f"https://mail.google.com/mail/?authuser={urllib.parse.quote(a)}#drafts"} for a in accounts_used]
    ids = [w["info"]["draft_id"] for w in written]
    listed = lambda xs: ", ".join(json.dumps(x) for x in xs)
    # Each of these drafts going out, not just any sent message in their threads.
    resolve_when = (f'stream("comms/gmail") | where at > {at} and body.facts.sent == true and body.facts.account in '
                    f'({listed(accounts_used)}) and body.facts.draft_id in ({listed(ids)}) '
                    f'| summarize n = dcount(body.facts.draft_id) | where n >= {len(ids)}')
    return {
        "emails": [{"name": w["name"], **{k: w["info"].get(k) for k in ("draft_id", "thread_id", "account", "to", "cc", "subject",
                                                                        "attachments", "link", "updated")},
                    "from": w["info"]["from_address"], "from_line": from_line(w["info"]["from_address"], w["info"]["from_why"]),
                    **({"as_it_stands": True} if w["info"].get("as_it_stands") else {})} for w in written],
        **({"discarded": discarded} if discarded else {}),
        "approval": {"drafts": drafts, "assists": sends + links, "resolve_when": resolve_when, "blobs": blobs,
                     "from_line": (from_line(written[0]["info"]["from_address"], written[0]["info"]["from_why"]) if len(written) == 1 else
                                   " ".join(f"To {who(w['people'])}: from {w['info']['from_address']}." for w in written))},
        **({"notes": notes} if notes else {}),
        "how": ("Put approval on one ask as it is: the brain's ask {type: approval, text: what they're for and why now, "
                "with approval.from_line in it so he sees which address it goes from, "
                "drafts, assists, resolve_when, blobs (add your own, like photos), about}. Approve & send runs every Send, "
                "in order, with his words from the card, and answers with sent (the Sends that ran) once all have gone; "
                "one that fails leaves the ask open, and pressing again sends only what hasn't gone (each Send's key). "
                "A draft whose words he clears on the card is left out, not sent empty (its Send answers skipped). An "
                "answer without sent (approved from a notification) means you send each: send {account, draft, body: his "
                "words for it, key: draft:<id>}. If he declines, discard them (discard {account, draft})."),
    }


def discard(args):
    """Deletes a draft: one this made (by its id or its thread), or any by its id."""
    acct = sendable(args["account"])
    d = find_draft(acct, args)
    if d is None:
        if args.get("draft"):
            keep_draft(args["draft"], None)
        return {"discarded": False, "gone": True, "note": "No such draft: it was sent or deleted already."}
    if d["id"] not in made_drafts() and not args.get("draft"):
        raise ValueError(f"the draft in that thread ({d['id']}) isn't one I made; give draft: its id to discard it anyway")
    shown = described(acct, d)
    acct.delete(f"drafts/{d['id']}")
    keep_draft(d["id"], None)
    return {"discarded": True, **{k: shown[k] for k in ("draft_id", "thread_id", "to", "subject", "words", "made_by_me")}}


def list_drafts(args):
    acct = find_account(args["account"])
    limit = int(args.get("limit", 20))
    found, page = [], None
    while len(found) < (limit if not args.get("thread") else 10_000):
        res = acct.get("drafts", maxResults=100, pageToken=page)
        found += [d for d in res.get("drafts", []) if not args.get("thread") or d["message"]["threadId"] == args["thread"]]
        page = res.get("nextPageToken")
        if not page:
            break
    shown = [described(acct, acct.get(f"drafts/{d['id']}", format="full")) for d in found[:limit]]
    for s in shown:
        s["words"] = s["words"][:2000]
    return sorted(shown, key=lambda s: -s["updated"])


def send(args):
    """Sends an email (or a Gmail draft, by its id or its thread) and returns it once Gmail has it as SENT."""
    acct = sendable(args["account"])
    key = args.get("key")
    with send_lock:
        if key and key in sent_log():
            before = sent_log()[key]
            return {**before, "already_sent": True,
                    **({"summary": "Nothing sent now: that key went before. " + before["summary"]} if before.get("summary") else {})}
        words, already, thread, expected = None, False, None, None
        if (args.get("draft") or args.get("draft_thread")) and args.get("body") is not None and not args["body"].strip():
            # He cleared its words on the card: that's leaving this one out, never an empty email.
            return {"sent": False, "skipped": True, "draft": args.get("draft"), "thread_id": args.get("draft_thread"),
                    "why": "Its words were cleared on the card, so I sent nothing; the draft stays in Gmail."}
        if args.get("draft") or args.get("draft_thread"):
            d = find_draft(acct, args)
            mine = made_drafts().get(d["id"] if d else args.get("draft"))
            if d is None:
                # Gone: sent from Gmail itself (it closes the ask the same), or deleted.
                done = mine and sent_since(acct, args.get("draft") or "", mine)
                if not done:
                    raise ValueError("that draft is gone: deleted in Gmail, or sent from there before I made it. Nothing was sent.")
                m, words, already = {"id": done}, "sent from Gmail", True
                keep_sent_draft(done, d["id"] if d else args["draft"])
            else:
                text = text_of(d["message"].get("payload", {}))
                current, body = split_quote(text)[0], args.get("body")
                dh = d["message"].get("payload", {}).get("headers", [])
                sender = None
                if args.get("from") and (addresses(header(dh, "From")) or [("", "")])[0][1].lower() != args["from"].lower():
                    sender = sender_of(acct, args["from"])
                if body is None or same(body, current):
                    words = "as drafted"  # Nothing to change: it goes as it stands, its formatting too.
                    if sender:
                        rewrite(acct, d, text, current, sender)
                elif mine and same(body, mine["body"]):
                    words = "as edited in Gmail"  # The card's words untouched, the draft edited in Gmail: his words there go.
                    if sender:
                        rewrite(acct, d, text, current, sender)
                else:
                    rewrite(acct, d, text, body, sender)
                    words = "as approved"
                expected = args["from"] if sender else (addresses(header(dh, "From")) or [("", None)])[0][1]
                if header(dh, "In-Reply-To"):
                    thread = d["message"]["threadId"]
                m = acct.post("drafts/send", {"id": d["id"]})
                keep_sent_draft(m["id"], d["id"])
            if d or args.get("draft"):
                keep_draft(d["id"] if d else args["draft"], None)
        else:
            if not args.get("body"):
                raise ValueError("body is required")
            built, thread, envelope = build(acct, args)
            message, expected = raw(built, thread), envelope["from_address"]
            m = acct.post("messages/send", message)
        # Gmail may take a moment to label it: it only counts as sent once it says SENT.
        for _ in range(10):
            got = landed(acct, m["id"])
            if "SENT" in got.get("labelIds", []):
                break
            time.sleep(1)
        else:
            raise RuntimeError(f"Gmail took message {m['id']} but hasn't marked it sent; check before sending again")
        obs = observation(acct, got)
        gh = got.get("payload", {}).get("headers", [])
        in_thread = None if not thread or already else got["threadId"] == thread
        result = {"sent": True, **{k: obs["facts"][k] for k in ("account", "message_id", "thread_id", "to", "subject", "date", "link")},
                  "cc": header(gh, "Cc"), "bcc": header(gh, "Bcc"), "from": header(gh, "From"), "entity": obs["entity"],
                  "reply": bool(thread), **({"in_thread": in_thread} if in_thread is not None else {}),
                  **({"words": words} if words else {}), **({"already_sent": True} if already else {})}
        went_from = (addresses(result["from"]) or [("", "")])[0][1]
        if expected and went_from.lower() != expected.lower():
            # Gmail can put the account's own address in place of an alias it won't send as: never let that pass unsaid.
            result["from_mismatch"] = {"expected": expected, "sent_from": went_from}
        result["summary"] = said(result, thread)
        if key:
            log_sent(key, result)
    try:
        observe(acct, m["id"])
    except (HttpError, OSError) as e:
        log(f"{acct.address}: sent {m['id']}, but couldn't record it yet ({e}); the next sync will")
    if not already:
        threading.Thread(target=watch_bounce, args=(acct, got), daemon=True).start()
    return result


def landed(acct, message_id):
    """A message as Gmail keeps it once sent: its labels and the headers that say where it went."""
    return acct.get(f"messages/{message_id}", format="metadata",
                    metadataHeaders=["From", "To", "Cc", "Bcc", "Subject", "Date", "In-Reply-To"])


def said(result, thread):
    """Where a sent email went, in a sentence to say as it is."""
    def names(value):
        people = [n or a for n, a in addresses(value) if a]
        return people[0] if len(people) == 1 else ", ".join(people[:-1]) + f" and {people[-1]}" if people else ""
    to, cc, bcc = names(result["to"]), names(result["cc"]), names(result["bcc"])
    how = "Already sent with that key" if result.get("already_sent") else "Sent"
    went_from = (addresses(result.get("from")) or [("", result["account"])])[0][1] or result["account"]
    sender = went_from if went_from.lower() == result["account"].lower() else f"{went_from} (through {result['account']})"
    where = (f"as a reply in “{result['subject']}”" if result.get("in_thread") is not False else
             f"as “{result['subject']}”, but Gmail filed it in a thread of its own ({result['thread_id']}), not the one it "
             f"answers ({thread})") if thread else f"as a new email, “{result['subject']}”"
    wrong = result.get("from_mismatch")
    return (f"{how} from {sender} to {to}" + (f", cc {cc}" if cc else "") + (f", bcc {bcc}" if bcc else "")
            + f", {where}. Gmail has it in Sent."
            + (f" But it went from {wrong['sent_from']}, not {wrong['expected']} as meant." if wrong else ""))


BOUNCE_AFTER_S = int(os.environ.get("GMAIL_BOUNCE_AFTER_SECONDS", "90"))
BOUNCER = re.compile(r"mailer-daemon|postmaster|mail delivery", re.I)


def watch_bounce(acct, got):
    """A while after a send, looks for a bounce in its thread (Gmail files one there): if one came, the sent message is
    recorded again as bounced, with what the bounce says, so it isn't taken for delivered."""
    time.sleep(BOUNCE_AFTER_S)
    try:
        sent_at = int(got.get("internalDate", 0))
        for m in acct.get(f"threads/{got['threadId']}", format="metadata", metadataHeaders=["From", "Subject"]).get("messages", []):
            frm = header(m.get("payload", {}).get("headers", []), "From")
            if int(m.get("internalDate", 0)) >= sent_at and m["id"] != got["id"] and BOUNCER.search(frm):
                obs = observation(acct, got)
                obs["facts"].update(bounced=True, bounce_message_id=m["id"], bounce=html.unescape(m.get("snippet", ""))[:300])
                obs["summary"] = f"Bounced: {obs['summary']}"[:200]
                record("observation", obs, [obs["entity"], acct.entity])
                log(f"{acct.address}: {got['id']} bounced ({m['id']})")
                return
    except (HttpError, OSError, KeyError, ValueError) as e:
        log(f"{acct.address}: couldn't look for a bounce of {got.get('id')} ({e})")


def answer(acct, m):
    """How to answer a message read: who Reply and Reply all would reach, and the call that sends one, so a reply
    goes out through here (written in Drafts, sent on Approve, checked in Sent) and never by hand in a browser."""
    try:
        send_as = send_as_of(acct)
    except (HttpError, OSError) as e:
        return {"note": f"I couldn't read its send-as addresses ({e}) to say who a reply would reach."}
    to, _ = recipients(acct, m, send_as)
    all_to, all_cc = recipients(acct, m, send_as, reply_all=True)
    latest_id = latest(acct, m["threadId"])
    others = len(all_to) + len(all_cc) > len(to)
    call = {"account": acct.address, "emails": [{"thread": m["threadId"], **({"reply_all": True} if others else {}),
                                                 "body": "<his words>"}]}
    how = (f"To answer it in the user's name: approval {json.dumps(call)} writes the reply into Drafts and gives the card's "
           "drafts, Send and resolve_when (put them on one approval ask as they are); Approve & send sends it and checks "
           "it's in Sent. Words he already approved go out with send {account, thread, reply_all, body, key}.")
    if not acct.can_send():
        how += " This account can only read so far: approval and send start enable_send themselves (one tap of his) and say which ask to wait on."
    if latest_id != m["id"]:
        how += f" A reply in the thread answers its latest message ({latest_id}), not this one; reply_to: \"{m['id']}\" answers this one."
    return {"thread": m["threadId"], "reply": {"to": to}, **({"reply_all": {"to": all_to, "cc": all_cc}} if others else {}),
            "can_send": acct.can_send(), "how": how}


def act(action, args):
    if action == "connect" and SWITCH:
        from authorize import authorize
        address = args.get("address") or args.get("account")
        if not address:
            raise ValueError("Name the existing account to authorize")
        return authorize(address)
    if action == "connect":
        return {"url": google.consent_url(args.get("address"), [SEND_SCOPE] if args.get("send") else ()),
                "note": "Opens in any browser, a phone's included: Google comes back to Switchboard's own callback, which finishes it."}
    if action == "finish":
        t = google.finish(args, "Gmail read access wasn't granted: start again from Switchboard and leave the box that lets "
                                "Switchboard read your email ticked.")
        address = http("GET", f"{API}/profile", token=t["access_token"])["emailAddress"]
        google.keep(address, t)
        with state_lock:
            old = accounts.get(address)
            acct = Account(address, old.history_id if old else None)
            acct.access_token, acct.expires_at = t["access_token"], time.time() + t.get("expires_in", 3600)
            accounts[address] = acct
        report(acct, force=True)
        wake.set()
        return {"address": address, "connected": True, "can_send": acct.can_send(),
                "note": ("I can read this inbox and send from it now. " if acct.can_send() else
                         "I can read this inbox now (read-only): I'll see new mail as it comes. ") + "You can close this tab."}
    if action == "accounts":
        return [{"address": a.address, "connected": a.connected, "can_send": a.can_send(), "error": a.error, "unread": a.unread}
                for a in accounts.values()]
    if action == "sync":
        if args.get("backfill"):
            # Reads the last couple of weeks again, for mail the first backfill's limits left out.
            for a in accounts.values():
                a.history_id = None
        wake.set()
        return {"syncing": sorted(accounts)}
    if action == "search":
        targets = [find_account(args["account"])] if args.get("account") else [a for a in accounts.values() if a.connected]
        limit = int(args.get("limit", 10))
        found, failed = [], []
        for acct in targets:
            # One account over its quota shouldn't sink the others' results: it's named at the end instead.
            try:
                for message_id in list_ids(acct, args["query"], limit):
                    obs = observation(acct, metadata(acct, message_id))
                    found.append({"entity": obs["entity"], **{k: obs["facts"][k] for k in
                                  ("account", "message_id", "thread_id", "from", "from_email", "subject", "snippet", "date", "unread", "inbox", "link")}})
            except HttpError as e:
                if len(targets) == 1:
                    raise
                failed.append({"account": acct.address, "error": str(e)[:200]})
        return sorted(found, key=lambda m: -m["date"]) + failed
    if action == "read":
        acct = find_account(args["account"])
        m = acct.get(f"messages/{args['id']}", format="full")
        headers = m.get("payload", {}).get("headers", [])
        body = text_of(m.get("payload", {}), links=True)
        if authentication_message(header(headers, "Subject") + "\n" + body):
            body = "Private authentication message. Use authentication_code through the browser challenge."
            headers = [{**h, "value": "Verification code"} if h["name"].lower() == "subject" else h for h in headers]
        limit = int(args.get("max_chars", 20000))
        import gmail_files  # its attachments tool (it imports this module)
        carried = gmail_files.pieces(m.get("payload", {}))
        inline = [p["name"] for p in carried if p["inline"]]
        return {
            **{h: header(headers, h) for h in ("From", "To", "Cc", "Date", "Subject")},
            "labels": m.get("labelIds", []), "thread_id": m["threadId"],
            "attachments": [p["filename"] for p in files(m.get("payload", {}))],
            **({"images_in_body": inline} if inline else {}),
            **({"download": f"attachments {json.dumps({'account': acct.address, 'id': m['id']})} saves "
                            f"{'them' if len(carried) != 1 else 'it'} ({len(carried)} file{'s' if len(carried) != 1 else ''}"
                            f"{', the images in the body included' if inline else ''}) to a folder and as blobs, "
                            "showing you the images"} if carried else {}),
            "body": body[:limit], "truncated": len(body) > limit,
            **({"answer": answer(acct, m)} if "DRAFT" not in m.get("labelIds", []) else {}),
        }
    if action == "send":
        return send(args)
    if action == "draft":
        return make_draft(args)
    if action == "approval":
        return make_approval(args)
    if action == "drafts":
        return list_drafts(args)
    if action == "discard":
        return discard(args)
    if action == "draft_words":
        return draft_words(args)
    if action == "enable_send":
        return enable_send(args)
    raise ValueError(f"unknown action {action}")


TOOLS = [
    {
        "name": "connect",
        "description": ("Authorize an existing Google account (address) for every scope Switch's extensions declare, through the core's consent in this machine's browser: connected, or the step only the user can take. For a new account, Switch's Connect button (connections_request)." if SWITCH else "Start connecting a Google account's inbox (read-only, or with send to send from it too): returns the consent URL. It works in any browser, the person's phone included: put it in an ask as a {label, url} button with resolve_when on gmail-account:<account> having facts.connected == true (and facts.can_send == true for send). Google sends the browser back to Switchboard's own callback, which finishes it."),
        "input_schema": {
            "type": "object",
            "properties": {
                "address": {
                    "type": "string",
                    "description": "The account to suggest on Google's chooser."
                },
                "send": {
                    "type": "boolean",
                    "description": "Also ask to send mail from it (drafts and sending)."
                }
            }
        }
    },
    {
        "name": "draft",
        "description": "Write an email in the user's name into Gmail's Drafts, sending nothing: a reply or reply-all in a thread (thread or reply_to; to its sender, or with reply_all everyone on it as Gmail's Reply all does; Re: its subject, Gmail's quote under the words) or a new email (to, subject), from any send-as address, attachments included, on an account with send access. It shows in the thread in Gmail on any device, for him to read or edit there. Writing again in the same thread updates the draft I made there (unless he has edited it in Gmail since; replace: its id writes over it anyway). On an account that can only read, it starts enable_send instead and says which ask to wait on. A reply goes from the alias the thread uses (the one of his send-as addresses their message was sent to, else the From of his earlier messages there) unless from says otherwise. Returns the draft (draft_id, thread_id, envelope with from_address and from_why, link) and approval: the drafts (each label saying the address it goes from), from_line (a sentence for the card's text saying which address it goes from), assists (Send, Open in Gmail) and resolve_when to put on the approval ask as they are, so Approve & send or Send sends exactly his version and the ask closes itself once it's sent, from the card or from Gmail.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string",
                    "description": "The connected account it goes out through, like me@example.com."
                },
                "from": {
                    "type": "string",
                    "description": "One of that account's send-as addresses, like alias@example.com. Default for a reply: the alias the thread uses (the one of his addresses their message was sent to, else the From of his earlier messages there); else the account's default."
                },
                "thread": {
                    "type": "string",
                    "description": "A reply in this thread (its thread id, gmail-message facts.thread_id), answering its latest message."
                },
                "reply_to": {
                    "type": "string",
                    "description": "Or the message id it answers: it goes in that message's thread."
                },
                "reply_all": {
                    "type": "boolean",
                    "description": "For a reply: everyone on the message it answers, as Gmail's Reply all does: the others it went to stay in To and those it copied in Cc, never one of his own addresses (a cc given is added to them)."
                },
                "quote": {
                    "type": "boolean",
                    "description": "For a reply: quote what it answers under the words, as Gmail does (default true)."
                },
                "to": {
                    "description": "Address or list of addresses (default for a reply: the sender of what it answers)."
                },
                "cc": {
                    "description": "Address or list of addresses."
                },
                "bcc": {
                    "description": "Address or list of addresses."
                },
                "subject": {
                    "type": "string",
                    "description": "Default for a reply: Re: the original's."
                },
                "body": {
                    "type": "string",
                    "description": "Plain text, his words alone (the quote goes under them on its own)."
                },
                "attachments": {
                    "type": "array",
                    "description": "Paths on the server, or blobs as {blob, name, type?}.",
                    "items": {}
                },
                "replace": {
                    "type": "string",
                    "description": "A draft's id to write over, instead of making a new one."
                }
            },
            "required": [
                "account",
                "body"
            ]
        }
    },
    {
        "name": "approval",
        "description": "Several emails in the user's name for one approval, in one step: writes each into Gmail's Drafts (a reply in a thread or a new email, each with draft's arguments; {draft: <id>} takes one already written, with new words if you give body), sending nothing, and hands back approval to put on one brain ask (type approval) as it is: drafts (a field each on the card, named after who it's to, its label saying the address it goes from: a reply from the alias the thread uses unless its from says otherwise), from_line (a sentence for the card's text saying which address each goes from), a Send for each (they fold into the card's one Approve & send, which sends them all with his edits, never twice), Open drafts in Gmail, the attachments as blobs for the card, and resolve_when, which holds once every one is sent, from the card or from Gmail. A draft he empties on the card is left out, not sent. On an account that can only read, it starts enable_send instead and says which ask to wait on. All or nothing: if one can't be written, the drafts this made are taken back. discard drops stale drafts (an earlier round's) first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string",
                    "description": "The connected account they go out through, like me@example.com (an email can give its own)."
                },
                "emails": {
                    "type": "array",
                    "description": "The emails, in the order they show on the card and send.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Its field's name on the card (letters, digits, - and _; default: who it's to, like mary)."},
                            "label": {"type": "string", "description": "The line over its field (default: To <name> (<address>) · <subject>)."},
                            "draft": {"type": "string", "description": "A draft already written, by id: taken as it stands, or with new words when body is given (its recipients, subject, quote and attachments stay). With to, subject or the like too, it's written over afresh."},
                            "account": {"type": "string"},
                            "thread": {"type": "string", "description": "A reply in this thread, answering its latest message."},
                            "reply_to": {"type": "string", "description": "Or the message id it answers."},
                            "reply_all": {"type": "boolean", "description": "Everyone on what it answers, as Gmail's Reply all does."},
                            "quote": {"type": "boolean"},
                            "to": {"description": "Address or list of addresses."},
                            "cc": {"description": "Address or list of addresses."},
                            "bcc": {"description": "Address or list of addresses."},
                            "subject": {"type": "string"},
                            "from": {"type": "string", "description": "A send-as address of its account (default for a reply: the alias the thread uses)."},
                            "body": {"type": "string", "description": "Plain text, his words alone."},
                            "attachments": {"type": "array", "description": "Paths on the server, or blobs as {blob, name, type?}; they go on the card too.", "items": {}}
                        }
                    }
                },
                "discard": {
                    "type": "array",
                    "description": "Stale drafts to delete first, like an earlier round's: their ids, or {account, draft}.",
                    "items": {}
                }
            },
            "required": [
                "emails"
            ]
        }
    },
    {
        "name": "send",
        "description": "Send an email in the user's name from a connected account with send access (gmail-account facts.can_send), from the server, so no Mac needs to be awake and no browser is driven: a Gmail draft (draft: its id, as draft returned it, or draft_thread: its thread's id), a reply or reply-all in a thread (thread or reply_to, with reply_all), or a new email (to, subject). With a draft and body, body is what he approved: when it differs from the draft, the draft's words become body (its quote and attachments stay); when only the draft was edited, in Gmail, his Gmail words go. It speaks for him: only for words he asked for or approved, from an approval ask's button with the text as {{draft:<name>}}. Give key so a second press never sends twice. A reply goes from the alias the thread uses (the one of his send-as addresses their message was sent to, else the From of his earlier messages there) unless from says otherwise; with a draft, from rewrites its From. Returns the sent message once Gmail marks it SENT: the From and who it went to (to, cc, bcc) as Gmail has them in Sent (from_mismatch when the From isn't the address meant), in_thread (whether a reply landed in the thread it answers), which words went, and summary, where it went in a sentence to say as it is; if a bounce comes back into its thread, the message is recorded again with facts.bounced. On an account that can only read, it starts enable_send and says which ask to wait on.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string",
                    "description": "The connected account it goes out through, like me@example.com."
                },
                "from": {
                    "type": "string",
                    "description": "One of that account's send-as addresses, like alias@example.com. Default for a reply: the alias the thread uses (the one of his addresses their message was sent to, else the From of his earlier messages there); else the account's default."
                },
                "thread": {
                    "type": "string",
                    "description": "A reply in this thread (its thread id, gmail-message facts.thread_id), answering its latest message."
                },
                "reply_to": {
                    "type": "string",
                    "description": "Or the message id it answers: it goes in that message's thread."
                },
                "reply_all": {
                    "type": "boolean",
                    "description": "For a reply: everyone on the message it answers, as Gmail's Reply all does: the others it went to stay in To and those it copied in Cc, never one of his own addresses (a cc given is added to them)."
                },
                "quote": {
                    "type": "boolean",
                    "description": "For a reply: quote what it answers under the words, as Gmail does (default true)."
                },
                "to": {
                    "description": "Address or list of addresses (default for a reply: the sender of what it answers)."
                },
                "cc": {
                    "description": "Address or list of addresses."
                },
                "bcc": {
                    "description": "Address or list of addresses."
                },
                "subject": {
                    "type": "string",
                    "description": "Default for a reply: Re: the original's."
                },
                "body": {
                    "type": "string",
                    "description": "Plain text, exactly as approved; with a draft, the approved words that replace its own."
                },
                "attachments": {
                    "type": "array",
                    "description": "Paths on the server, or blobs as {blob, name, type?}.",
                    "items": {}
                },
                "draft": {
                    "type": "string",
                    "description": "Send this Gmail draft (its id) instead of composing."
                },
                "draft_thread": {
                    "type": "string",
                    "description": "Send the draft in this thread (the one I made, if it has several)."
                },
                "key": {
                    "type": "string",
                    "description": "Never sends twice with the same key: draft:<draft id>, or the approval ask's id."
                }
            },
            "required": [
                "account"
            ]
        }
    },
    {
        "name": "enable_send",
        "description": "Give a Gmail account send access (drafts and sending) when it can only read, with one tap of the user's: it starts Google's consent and drives it in a background tab of the Mac mini's Chrome (signed in to his Google accounts) up to the last page (\"Manage drafts and send emails\"), holds that tab, and puts one approval in his queue whose Approve presses its Continue; once Google comes back, the account's facts.can_send turns true and the card closes itself. A step only he can take on the way (a passkey, a phone prompt, a CAPTCHA) goes up as a card with the tab live on it instead. draft, approval and send start this themselves when they meet an account that can only read, and say which ask to wait on. Answers can_send, and while it waits on him the ask's id: wait on it (the brain's wait op) or follow it, then do what needed sending.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string",
                    "description": "The account, like me@example.com (one not connected yet is connected, read and send at once)."
                },
                "why": {
                    "type": "string",
                    "description": "A sentence for the card on why it matters now, like \"Today's notice had to go out by hand.\""
                },
                "approved": {
                    "type": "boolean",
                    "description": "The user asked for exactly this in so many words: press Google's Continue without a card."
                },
                "mac": {
                    "type": "string",
                    "description": "The Mac whose Chrome drives Google's pages (default local)."
                }
            },
            "required": [
                "account"
            ]
        }
    },
    {
        "name": "drafts",
        "description": "The Gmail drafts in an account (or one thread), newest first: who each is to, its words, whether I made it and whether he has edited it in Gmail since, and its link.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string"
                },
                "thread": {
                    "type": "string",
                    "description": "Only this thread's drafts."
                },
                "limit": {
                    "type": "integer",
                    "description": "Default 20."
                }
            },
            "required": [
                "account"
            ]
        }
    },
    {
        "name": "draft_words",
        "description": "A Gmail draft's own words, as he'd see them in Gmail (above the quote of what it answers): read them, or with text, write them in place of its words (its recipients, subject, quote and attachments stay), sending nothing. Switch's core calls it to keep an approval card's draft and the Gmail draft one version: his edits in either reach the other. Returns text, or gone once it's sent or deleted.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {"type": "string"},
                "draft": {"type": "string", "description": "The draft's id."},
                "text": {"type": "string", "description": "Its new words."}
            },
            "required": ["account", "draft"]
        }
    },
    {
        "name": "discard",
        "description": "Delete a Gmail draft, sending nothing: one I made (by its id, or draft_thread: its thread), or any draft by its id. For an approval he declined or a reply that's moot. Returns what it was.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string"
                },
                "draft": {
                    "type": "string",
                    "description": "The draft's id."
                },
                "draft_thread": {
                    "type": "string",
                    "description": "Or its thread: the draft I made there."
                }
            },
            "required": [
                "account"
            ]
        }
    },
    {
        "name": "finish",
        "description": "Finish a consent with the code Google sent back. The core's OAuth callback calls this.",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string"
                },
                "state": {
                    "type": "string"
                },
                "redirect_uri": {
                    "type": "string"
                }
            },
            "required": [
                "code",
                "state"
            ]
        }
    },
    {
        "name": "search",
        "description": "Gmail search (Gmail's own query syntax, like 'from:stripe newer_than:7d') across every connected account, or one. Returns message metadata and snippets, newest first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string"
                },
                "account": {
                    "type": "string"
                },
                "limit": {
                    "type": "integer",
                    "description": "Per account, default 10."
                }
            },
            "required": [
                "query"
            ]
        }
    },
    {
        "name": "read",
        "description": "One message in full: headers, attachment names and its text body, and answer: who a reply and a reply-all would reach, and the approval or send call that answers it in the user's name.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string"
                },
                "id": {
                    "type": "string",
                    "description": "facts.message_id"
                },
                "max_chars": {
                    "type": "integer"
                }
            },
            "required": [
                "account",
                "id"
            ]
        }
    },
    {
        "name": "sync",
        "description": "Check every account for changes now; with backfill, read the last two weeks of inbox and sent mail again.",
        "input_schema": {
            "type": "object",
            "properties": {
                "backfill": {
                    "type": "boolean"
                }
            }
        }
    },
    {
        "name": "accounts",
        "description": "The connected accounts, whether each can send (can_send), and their unread counts.",
        "input_schema": {
            "type": "object",
            "properties": {}
        }
    }
]
READ_ONLY = ["accounts", "read", "search", "drafts"]
SPEAKS = ["send"]
"""Sends something out in the user's name, which the outbound gates read before it runs."""


def tool(name):
    if name == "enable_send":
        def run(ctx, **args):
            return enable_send(args, progress=ctx.progress)
        return run
    return lambda **args: act(name, args)


for spec in TOOLS:
    app.tool(tool(spec["name"]), name=spec["name"], description=spec["description"], schema=spec["input_schema"],
             read_only=spec["name"] in READ_ONLY, speaks_for_person=spec["name"] in SPEAKS)

app.background(loop)
app.background(resume_grants)


if __name__ == "__main__":
    app.run()
