"""The marketplace extension's chats: the user's Facebook Marketplace chats, buying and selling.

Replies from Marketplace sellers (and buyers of what the user sells) land in their personal
Messenger, which has no API. This sense reads them from the Marketplace inbox
(facebook.com/marketplace/inbox) in the user's own Chrome, signed in to Facebook, through the
browser extension: one background tab (session `marketplace-chats`) that loads the inbox, reads the
Buying and Selling tabs, and goes back to about:blank, every few minutes (2.5 while a negotiation
is live, 6 by day, 20 at night).

It emits each conversation as `fb-marketplace-chat:<person>-<listing>-<hash>` (a chat event),
again whenever its latest message or read state changes: who and which listing, the latest
message and who sent it, whether it's unread, and the recent messages when the page has them. An
event whose `new_from_them` is true is the first sight of a new message from the other person.

It never opens an unread chat, since that would mark it read on the user's phone and show the
seller "Seen": an unread row's latest message is theirs by definition. When a read row changes
while the user was waiting on the other side, it opens that chat (read already, so nothing shows)
to learn who wrote it, then closes it. Facebook restores a chat popup on every load, so it
minimizes popups first and leaves the page for about:blank when done, keeping the window in which
a popup could mark a reply read to a few seconds.

It sends in the user's name only through `send` (speaks for the person, so Switch's Outbound gate
sees it first): it opens the listing (or the chat, from the inbox), fills the first-message box or
the chat's composer, reads the words back, sends them, and confirms "Message sent ... by You:
<words>" in the chat before it says sent. It then closes the chat's popup (so a reply never lands
in an open chat and shows Seen), emits a send event, and reads the inbox so the chat is recorded
as waiting on them and the loop polls every 2.5 minutes. `draft` reads what a send would go into,
sending nothing. The loop itself only reads.
"""

import datetime
import hashlib
import json
import os
import random
import re
import sys
import threading
import time

import sbmcp
from browser import Browser, BrowserError
from server import app, session_live


TAB = Browser(app, session="marketplace-chats")
HOME = sbmcp.home()
STATE = os.path.join(HOME, "sends.json")
CHATS = os.path.join(HOME, "chats.json")
"""Each conversation's latest facts, kept between runs."""
FB = "https://www.facebook.com"
SENSE = "sense:marketplace-chats"
INBOX = "https://www.facebook.com/marketplace/inbox?targetTab={}"
SIDES = {"BUYER": "buying", "SELLER": "selling"}
ROWS = 15
OPEN_PER_POLL = 2
LIVE_S, DAY_S, NIGHT_S = 150, 360, 1200
NIGHT_HOURS = range(0, 7)
PAGE_JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "page_chats.js")).read()

poll_lock = threading.RLock()  # one conversation with Facebook's chats at a time: polls and sends
wake = threading.Event()
chats = {}  # entity -> its latest facts
just_sent = []  # (listing title, words, epoch ms) this sent lately: the inbox shows them without "You: "
status = {"state": "starting", "polls": 0, "errors": 0, "since": None, "asked_signin": False,
          "sends": 0, "send_failures": 0, "last_send": None, "last_send_error": None,
          "caught_up_at": int(time.time() * 1000), "due_at": int(time.time() * 1000)}
"""caught_up_at: when the loop's last look that read the whole inbox began (its start, before any).
due_at: when the look after that one was due; behind is only past it, so a slow schedule (20
minutes at night) is never lag by itself."""
CHECKPOINT = "Facebook is holding the account at a checkpoint in Chrome"
SIGNED_OUT_S = 900
"""How often a signed-out (or checkpointed) Facebook is looked at again."""
FAILS_REPORTED = 3
"""Failed looks in a row before the sense says it's failing: one failed look is retried a minute
later, and only a stall is trouble."""


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def now_ms():
    return int(time.time() * 1000)


# The page, through the browser extension.


def js(op):
    return {"op": "js", "code": PAGE_JS.replace("__MPW_ARGS__", json.dumps(op))}


def steps(ops, timeout=120):
    """Runs browser ops in order; returns every @@MPW@@ answer of page_chats.js in order."""
    answers = []
    for op in ops:
        try:
            out = TAB.op(op, timeout=timeout)
        except BrowserError as e:
            if any(a.get("signed_in") is False for a in answers):
                return answers
            raise RuntimeError(str(e)[:400]) from None
        if isinstance(out, str):
            answers += [json.loads(m) for m in re.findall(r"@@MPW@@(\{.*\})", out)]
    return answers


def read_inbox(full):
    """Both tabs' rows and docked chats, or {'signed_in': False}."""
    for settle in (2.5, 5):
        answers = steps([
            {"op": "navigate", "url": INBOX.format("BUYER")},
            {"op": "wait", "seconds": settle},
            js({"op": "minimize"}),
            js({"op": "read", "limit": ROWS, "full": full}),
            js({"op": "tab", "side": "SELLER"}),
            {"op": "wait", "seconds": settle},
            js({"op": "read", "limit": ROWS, "full": full, "after_switch": True}),
            js({"op": "minimize"}),
            {"op": "navigate", "url": "about:blank"},
        ])
        out = [a for a in answers if a.get("signed_in") is False]
        if out:
            held = next((a["checkpoint"] for a in out if a.get("checkpoint")), None)
            return {"signed_in": False, "why": f"{CHECKPOINT}: {held}" if held else signed_out_why()}
        reads = [a for a in answers if "tab" in a]
        tabs = {}
        for a, side in zip(reads, ("BUYER", "SELLER")):
            if a.get("tab") == {"BUYER": "Buying", "SELLER": "Selling"}[side] and not a.get("stale") and (a.get("same") or a.get("rows")):
                tabs[side] = a
        if len(tabs) == 2:
            session_live("facebook")
            return {"signed_in": True, "tabs": tabs}
        # Slow to load: once more, with longer waits, and then it's a failed poll.
        full = True
    raise RuntimeError(f"the inbox didn't load both tabs ({[(a.get('tab'), len(a.get('rows') or []), a.get('stale')) for a in reads]})")


def signed_out_why():
    """Why the inbox read signed out, from Facebook's home page: a checkpoint holding the account
    (its first line), else signed out. It only looks: a checkpoint's button is the user's to press."""
    try:
        at = TAB.op({"op": "navigate", "url": FB + "/"}) or {}
        if "/checkpoint/" in str(at.get("url", "")):
            said = TAB.js("((document.querySelector('[role=\"main\"]') || document.body).innerText"
                          ".split('\\n').map((l) => l.trim()).find(Boolean) || '').slice(0, 160)")
            return f"{CHECKPOINT}: {said or 'it asks for something'}"
    except BrowserError as e:  # REVIEW: it's signed out either way; only the why is lost
        log(f"looking for a checkpoint failed: {e}")
    finally:
        try:
            TAB.op({"op": "navigate", "url": "about:blank"})
        except BrowserError:
            pass
    return "Facebook is signed out in Chrome"


def open_read_chats(side, rows):
    """Opens read chats to see who wrote their latest message; returns their logs."""
    ops = [{"op": "navigate", "url": INBOX.format(side)}, {"op": "wait", "seconds": 2.5}, js({"op": "minimize"})]
    for r in rows:
        ops += [js({"op": "open", "name": r["name"], "listing": r["listing"]}), {"op": "wait", "seconds": 2},
                js({"op": "read", "limit": ROWS, "full": True}), js({"op": "close", "name": r["name"], "listing": r["listing"]})]
    ops += [js({"op": "minimize"}), {"op": "navigate", "url": "about:blank"}]
    logs = []
    for a in steps(ops):
        logs += a.get("logs") or []
    return logs


# Conversations.


def slug(s, n):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n].strip("-")


def entity_of(side, row):
    h = hashlib.sha1(f"{side}|{row['name']}|{row['listing']}".encode()).hexdigest()[:6]
    return f"fb-marketplace-chat:{slug(row['name'], 24)}-{slug(row['listing'], 40)}-{h}"


def log_of(row, logs):
    name, listing = row["name"], row["listing"]
    ls = [l for l in logs if l["title"] == listing or l["title"].endswith(" · " + listing)]
    for l in ls:
        if l.get("person") and l["person"].startswith(name):
            return l
    for l in ls:
        if any(m["by"] == name for m in l["msgs"]):
            return l
    return ls[0] if len(ls) == 1 and not ls[0].get("person") else None


def event_of(row):
    s, name = row["snippet"], re.escape(row["name"])
    if re.match(rf"^{name} sold ", s):
        return "sold"
    if re.search(r"marked the listing as pending", s, re.I):
        return "pending"
    if re.search(r"marked the listing as (available|in stock)", s, re.I):
        return "available"
    if re.search(r"reacted .* to your message", s):
        return "reaction"
    if re.search(r"is waiting for your response|You can quickly let the seller know|Have you sold this item", s):
        return "nudge"
    if re.match(rf"^({name}|You) sent (a|an|\d+) ", s):
        return "attachment"
    return "message"


def when_of(label, now=None):
    """Epoch ms for an inbox time label: 9:48 AM, Mon, Oct 14, 09/16/24."""
    now = now or datetime.datetime.now()
    label = label.replace(" ", " ").strip()
    try:
        if re.match(r"^\d{1,2}:\d{2} ?[AP]M$", label, re.I):
            t = datetime.datetime.strptime(label.replace(" ", "").upper(), "%I:%M%p").time()
            d = datetime.datetime.combine(now.date(), t)
            return int((d if d <= now + datetime.timedelta(minutes=5) else d - datetime.timedelta(days=1)).timestamp() * 1000)
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        if label[:3] in days and len(label) <= 9:
            back = (now.weekday() - days.index(label[:3])) % 7 or 7
            return int(datetime.datetime.combine(now.date() - datetime.timedelta(days=back), datetime.time(12)).timestamp() * 1000)
        if re.match(r"^\d{2}/\d{2}/\d{2}$", label):
            return int(datetime.datetime.strptime(label, "%m/%d/%y").replace(hour=12).timestamp() * 1000)
        if re.match(r"^[A-Z][a-z]{2} \d{1,2}$", label):
            d = datetime.datetime.strptime(f"{label} {now.year}", "%b %d %Y").replace(hour=12)
            if d > now + datetime.timedelta(days=1):
                d = d.replace(year=now.year - 1)
            return int(d.timestamp() * 1000)
    except ValueError:
        pass
    return None


def observe(side, row, logs, backfill):
    """The conversation's new facts, or None when nothing changed."""
    key = entity_of(side, row)
    prev = chats.get(key)
    log_ = log_of(row, logs)
    msgs = [{"by": "me" if m["by"] == "You" else "them", "text": m["text"], "at": m["at"]} for m in log_["msgs"]][-8:] if log_ else None
    changed_text = not prev or prev.get("last_message") != row["snippet"]
    same_msgs = not log_ or [(m["by"], m["text"]) for m in msgs] == [(m["by"], m["text"]) for m in (prev or {}).get("messages") or []]
    if prev and not changed_text and prev.get("unread") == row["unread"] and same_msgs:
        return key, None

    event = event_of(row)
    last_from = None
    if event == "nudge":
        last_from = "facebook"
    elif row["unread"]:
        last_from = "them"
    elif log_ and log_["msgs"] and log_["msgs"][-1]["text"] == row["snippet"]:
        last_from = "me" if log_["msgs"][-1]["by"] == "You" else "them"
    elif any(t == row["listing"] and same_words(w, row["snippet"]) and now_ms() - at < 3600_000 for t, w, at in just_sent):
        last_from = "me"
    elif log_ and any(m["text"] == row["snippet"] for m in log_["msgs"]):
        # A docked chat that has moved on since the row: who wrote the row's line.
        last_from = "me" if [m for m in log_["msgs"] if m["text"] == row["snippet"]][-1]["by"] == "You" else "them"
    elif event in ("sold", "pending", "available", "reaction") or re.match(rf"^{re.escape(row['name'])} sent ", row["snippet"]):
        last_from = "them"
    elif row["snippet"].startswith("You sent ") or row["snippet"].startswith("You: "):
        last_from = "me"
    elif row["snippet"].startswith(row["name"] + ": "):
        last_from = "them"
    elif log_ and log_["msgs"]:
        last_from = "me" if log_["msgs"][-1]["by"] == "You" else "them"
    elif prev and not changed_text:
        last_from = prev.get("last_from")
    elif not prev and not backfill and side == "BUYER":
        last_from = "me"  # a new chat about something the user is buying, already read: they started it

    new_from_them = bool(not backfill and changed_text and last_from == "them" and event != "reaction")
    if msgs is None and prev and prev.get("messages"):
        msgs = prev["messages"]
        if changed_text and last_from in ("them", "me") and event in ("message", "attachment"):
            msgs = (msgs + [{"by": last_from, "text": row["snippet"], "at": row["time"]}])[-8:]
    if log_ is not None:
        unanswered = []
        for m in log_["msgs"]:
            unanswered = [] if m["by"] == "You" else unanswered + [m["text"]]
    elif last_from == "them":
        before = prev.get("unanswered", []) if prev and prev.get("last_from") == "them" else []
        if changed_text and (not before or before[-1] != row["snippet"]):
            before = before + [row["snippet"]]
        unanswered = (before or [row["snippet"]])[-8:]
    else:
        unanswered = []

    t = now_ms()
    label_at = when_of(row["time"])
    if prev and changed_text and not backfill:
        last_at = label_at if label_at and re.match(r"^\d", row["time"]) and abs(label_at - t) < 6 * 3600_000 else t
    else:
        last_at = label_at or (prev or {}).get("last_at") or t
    waiting_on = None
    if event in ("message", "attachment"):
        waiting_on = {"them": "you", "me": "them"}.get(last_from)
    facts = {
        "side": SIDES[side],
        "person": row["name"],
        "person_full": (log_ or {}).get("person") or (prev or {}).get("person_full"),
        "listing": row["listing"],
        "last_message": row["snippet"],
        "last_from": last_from,
        "event": event,
        "unread": row["unread"],
        "waiting_on": waiting_on,
        "closed": event == "sold",
        "new_from_them": new_from_them,
        "unanswered": unanswered,
        "messages": (msgs or [])[-8:] or None,
        "time_label": row["time"],
        "last_at": last_at,
        "seen_at": t if changed_text else (prev or {}).get("seen_at", t),
        "photo": row["photo"],
        "inbox": INBOX.format(side),
        "backfill": backfill or None,
    }
    return key, facts


def summary_of(f):
    said = f["last_message"]
    who = {"them": f"{f['person']}: ", "me": "You: "}.get(f["last_from"], "")
    if said.startswith(who) or said.startswith(f["person"] + " "):
        who = ""
    unread = " (unread)" if f["unread"] and f["last_from"] == "them" else ""
    return f"{who}{said[:160]}{unread}"


def poll(full=False):
    with poll_lock:
        backfill = not chats
        inbox = read_inbox(full or backfill)
        if not inbox["signed_in"]:
            status["why"] = inbox["why"]
            return "signed_out"
        updates, need_open = [], {}
        for side, a in inbox["tabs"].items():
            if a.get("same"):
                continue
            for row in a["rows"]:
                key, facts = observe(side, row, a["logs"], backfill)
                if facts is None:
                    continue
                # Read, changed, and no docked chat says who wrote it: worth opening only when
                # the other side owed a reply (an offer out), to tell their answer from the user's follow-up.
                if facts["last_from"] is None and not row["unread"] and not backfill and (chats.get(key) or {}).get("waiting_on") == "them":
                    need_open.setdefault(side, []).append(row)
                updates.append((key, facts))
        # Read rows whose latest message changed and no docked chat says who wrote it: open them.
        opened = {}
        for side, rows in need_open.items():
            try:
                logs = open_read_chats(side, rows[:OPEN_PER_POLL])
            except Exception as e:  # REVIEW: the row is still recorded, its sender unknown
                log(f"opening {len(rows)} read chats failed: {e}")
                continue
            for row in rows[:OPEN_PER_POLL]:
                key, facts = observe(side, row, logs, backfill)
                if facts:
                    opened[key] = facts
        for key, facts in updates:
            facts = opened.get(key, facts)
            chats[key] = facts
            emit_chat(key, facts, importance=0.7 if facts["new_from_them"] else 0.3)
        if updates:
            save_chats()
            log(f"{len(updates)} chats changed" + (" (backfill)" if backfill else ""))
        return "ok"


def emit_chat(key, facts, importance=0.3):
    app.emit("chat", {"entity": key, "kind": "fb-marketplace-chat", "name": f"{facts['person']} · {facts['listing']}",
                      "summary": summary_of(facts), "facts": facts}, about=[key], importance=importance)


# State, from its home: the latest facts of each conversation.


def load_state():
    try:
        with open(CHATS, encoding="utf-8") as f:
            chats.update(json.load(f))
    except (OSError, ValueError):
        pass
    log(f"{len(chats)} chats known")


def save_chats():
    tmp = CHATS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(chats, f, separators=(",", ":"))
    os.replace(tmp, CHATS)


def interval():
    t = now_ms()
    live = any(
        (f.get("waiting_on") == "them" and t - (f.get("last_at") or 0) < 3 * 3600_000)
        or t - (f.get("seen_at") or 0) < 30 * 60_000
        for f in chats.values()
    )
    base = LIVE_S if live else NIGHT_S if datetime.datetime.now().hour in NIGHT_HOURS else DAY_S
    return base * random.uniform(0.85, 1.15), live


def vitals(state, detail=None, live=False):
    """The sense's heartbeat. failing is what's wrong now: signed out or held at a checkpoint, at once;
    reads failing FAILS_REPORTED times in a row; never one odd load, which the next look retries."""
    t = now_ms()
    recent = [f for f in chats.values() if t - (f.get("last_at") or 0) < 14 * 86400_000]
    waiting = [f for f in recent if f.get("waiting_on") == "you" and f.get("unread")]
    facts = {
        "state": state,
        "checked_at": t,
        "chats": len(chats),
        "recent": len(recent),
        "unread_from_them": len(waiting),
        "live": live,
        "behind_ms": 0 if state == "ok" else max(0, t - status["due_at"]),
        "polls": status["polls"],
        "sends": status["sends"],
        "send_failures": status["send_failures"],
        "last_send": status["last_send"],
        "last_send_error": status["last_send_error"],
        "detail": detail,
    }
    summary = {
        "ok": f"Watching {len(recent)} recent Marketplace chats; {len(waiting)} unread from the other side",
        "signed_out": status.get("why") or "Facebook is signed out in Chrome",
        "error": f"Can't read the Marketplace inbox: {detail}",
    }.get(state, state)
    facts["failing"] = None if state == "ok" else summary
    facts["last_error"] = status.get("last_error")
    app.emit("heartbeat", {"entity": SENSE, "summary": summary, "facts": facts}, about=[SENSE])


def ask_signin():
    """Asks the user, once a time it's signed out, to sign in to Facebook again."""
    if status["asked_signin"]:
        return
    why = status.get("why") or "Facebook is signed out in Chrome"
    held = why.startswith(CHECKPOINT)
    app.emit("ask", {"type": "task", "summary": "Clear Facebook's checkpoint in Chrome" if held else "Sign in to Facebook in Chrome",
                     "text": f"{why}, so Marketplace chats can't be read.",
                     "url": "https://www.facebook.com/", "entity": SENSE}, about=[SENSE])
    status["asked_signin"] = True


def loop():
    load_state()
    full = True
    while True:
        wait_s, live = interval()
        t = now_ms()
        try:
            state = poll(full=full)
            if state == "ok":
                status["caught_up_at"] = t
                status["due_at"] = now_ms() + int(wait_s * 1000)
                status["last_error"] = None
            elif state == "signed_out":
                # Signed out or at a checkpoint: look again now and then, not at a live chat's pace.
                wait_s = max(wait_s, SIGNED_OUT_S)
            full = False
            status["polls"] += 1
            if state == "signed_out":
                ask_signin()
            else:
                status["asked_signin"] = False
            # A failing sense goes quiet (no heartbeat) so its health shows; known causes keep reporting.
            # Its state changing is it falling behind the inbox or catching up, so that beats at once.
            if status["state"] != state or state in ("ok", "signed_out"):
                vitals(state, live=live)
            status["state"], status["errors"] = state, 0
        except Exception as e:  # REVIEW: one failed poll is retried with backoff; it never kills the sense
            status["errors"] += 1
            log(f"poll failed ({status['errors']}): {e}")
            status["last_error"] = str(e)[:300]
            if status["errors"] == FAILS_REPORTED:
                vitals("error", str(e)[:200])
            status["state"] = "error"
            wait_s = min(60 * 2 ** (status["errors"] - 1), 900)
        wake.wait(wait_s)
        wake.clear()


# Sending, in the user's name: only through send, which the Outbound gate sees first.


DUP_S = 15 * 60
"""The same words to the same chat within this long are taken as already sent, unless again."""
CONFIRM_TRIES = 5


class Refused(Exception):
    """Nothing went out, on purpose: what the asker should hear, and the facts for its record."""

    def __init__(self, status, summary, **facts):
        super().__init__(summary)
        self.status, self.summary, self.facts = status, summary, facts


def load_sends():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_send(key, result):
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    sends = load_sends()
    sends[key] = result
    # The last 200 are plenty to keep a second press from sending twice.
    keep = dict(sorted(sends.items(), key=lambda kv: kv[1].get("at") or 0)[-200:])
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(keep, f)
    os.replace(tmp, STATE)


def listing_id(listing):
    """A listing's id from its id or any link to it."""
    m = re.search(r"(?:/item/|^)(\d{6,})", str(listing).strip())
    if not m:
        raise ValueError(f"not a Marketplace listing: {listing!r} (give its id or its facebook.com/marketplace/item/ link)")
    return m.group(1)


def norm(s):
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ").replace(" ", " ")).strip()


def same_words(a, b):
    a, b = norm(a), norm(b)
    return a == b or (len(a) >= 60 and b.startswith(a)) or (len(b) >= 60 and a.startswith(b))


def first(answers, *what):
    """The answer of the page op that says what (the last answer carrying one of these keys, or an error)."""
    got = [a for a in answers if any(w in a for w in what) or a.get("error")]
    if not got:
        raise RuntimeError(f"the page didn't answer {what}")
    a = got[-1]
    if a.get("signed_in") is False:
        raise Refused("signed_out", "Facebook is signed out in Chrome, so nothing was sent")
    return a


def find_chat(chat):
    """A known chat's facts, from its entity, "Person · Listing", or words of its listing or person."""
    c = str(chat).strip()
    if c in chats:
        return c, chats[c]
    if not c.startswith("fb-marketplace-chat:"):
        if " · " in c:
            person, listing = c.split(" · ", 1)
            hits = [(k, f) for k, f in chats.items() if f.get("person") == person.strip() and f.get("listing") == listing.strip()]
        else:
            w = c.lower()
            hits = [(k, f) for k, f in chats.items() if w in (f.get("listing") or "").lower() or w in (f.get("person_full") or f.get("person") or "").lower()]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise ValueError(f"{chat!r} fits {len(hits)} chats: " + "; ".join(f"{f.get('person')} · {f.get('listing')}" for _, f in hits[:6]))
    raise ValueError(f"no Marketplace chat known as {chat!r} (check lists them)")


def chat_of_listing(title, seller=None):
    """The chat recorded for a listing's title, if there is one (the seller's first name breaking a tie)."""
    hits = [(k, f) for k, f in chats.items() if title and f.get("listing") == title]
    if len(hits) > 1 and seller:
        hits = [(k, f) for k, f in hits if seller.startswith(f.get("person") or "\0") or (f.get("person_full") or "") == seller] or hits
    return hits[0] if hits else (None, None)


def read_listing(lid):
    """A listing's page as the send box sees it, opening nothing: title, price, seller, mode, photo."""
    answers = steps([
        {"op": "navigate", "url": f"{FB}/marketplace/item/{lid}/"},
        {"op": "wait", "seconds": 2.5},
        js({"op": "minimize"}),
        js({"op": "listing"}),
    ])
    info = first(answers, "mode")
    if not info.get("title"):
        raise RuntimeError(f"listing {lid}'s page didn't load (it may be gone)")
    return info


def page_after(when_ms):
    """Whether a message's time label (5:41 PM) is at or after a moment, to the minute."""
    return lambda at: (when_of(at) or 0) >= (when_ms // 60000) * 60000


def guard(msgs, text, since, again):
    """Before anything is typed: nothing new from them since the draft, and not a repeat."""
    if since:
        new = [m for m in msgs if m["by"] != "You" and page_after(int(since))(m["at"])]
        if new:
            raise Refused("held", "Not sent: they wrote since the draft: " + " / ".join(f"“{m['text'][:120]}”" for m in new[-3:]),
                          new_from_them=[{"at": m["at"], "text": m["text"]} for m in new[-5:]])
    if not again:
        recent = page_after(now_ms() - DUP_S * 1000)
        dup = [m for m in msgs if m["by"] == "You" and same_words(m["text"], text) and recent(m["at"])]
        if dup:
            raise Refused("already", f"Already in the chat: you sent these words at {dup[-1]['at']}, so nothing was sent again",
                          sent_at_label=dup[-1]["at"])


def fill_and_send_chat(text, listing, ctx, dry_run):
    """With the chat open and its composer marked: paste the words, check them, send them."""
    a = first(steps([js({"op": "fill_chat", "text": text})]), "pasted", "draft")
    if a.get("error"):
        raise RuntimeError(f"the chat's composer: {a['error']}")
    if a.get("draft"):
        # Something was left in the composer: clear it, then paste.
        a = first(steps([js({"op": "clear_chat"}), js({"op": "fill_chat", "text": text})]), "pasted", "draft")
        if a.get("draft"):
            raise RuntimeError("the chat's composer had words in it that wouldn't clear")
    c = first(steps([{"op": "wait", "seconds": 0.4}, js({"op": "composer", "text": text})]), "matches")
    if not c.get("matches") or not c.get("focused"):
        steps([js({"op": "clear_chat"})])
        raise RuntimeError(f"the composer didn't hold the words exactly ({c.get('length')} characters, focused {c.get('focused')}), so nothing was sent")
    if dry_run:
        steps([js({"op": "clear_chat"})])
        e = first(steps([js({"op": "composer", "text": ""})]), "matches")
        return {"cleared": bool(e.get("empty"))}
    ctx and ctx.progress("Sending")
    # The composer holds exactly the words: its own send (Messenger's Enter) sends them.
    a = first(steps([js({"op": "send_chat", "text": text})]), "pressed")
    if a.get("error"):
        raise RuntimeError(f"the chat's send: {a['error']}, so nothing was sent")
    return None


def confirm(text, listing):
    """Waits for the chat to show the words sent by You; the chat's messages then, or raises."""
    last = None
    for i in range(CONFIRM_TRIES):
        a = first(steps([{"op": "wait", "seconds": 1.5 if i else 2.0}, js({"op": "sent", "text": text, "listing": listing})]), "chats")
        last = a
        if a.get("found"):
            return a["found"]
        if a.get("failed"):
            raise RuntimeError(f"Messenger says {a['failed']!r}")
    raise RuntimeError(f"the chat didn't show the message as sent after {CONFIRM_TRIES} looks (chats open: {(last or {}).get('chats')})")


def tidy(listing):
    """Closes the chat's popup and leaves Facebook, so no popup can show a reply as Seen."""
    try:
        steps([js({"op": "close_chat", "listing": listing}), js({"op": "minimize"}), {"op": "navigate", "url": "about:blank"}])
    except Exception as e:  # REVIEW: the send stands; a popup left open is minimized by the next poll
        log(f"tidying after a send: {e}")


def open_listing_chat(lid, info, ctx):
    """On a listing the user has messaged: open its chat from Message again; the chat's messages."""
    a = first(steps([js({"op": "message_again"})]), "pressed")
    if a.get("error"):
        raise RuntimeError(f"Message again: {a['error']}")
    a = first(steps([{"op": "wait", "seconds": 2.5}, js({"op": "chat", "listing": info["title"]})]), "chat")
    if a.get("error"):
        raise RuntimeError(f"Message again didn't open the chat: {a['error']}")
    return a["chat"]


def open_inbox_chat(facts):
    """Opens a chat from the Marketplace inbox (to reply in it, so unread is fine); its messages."""
    side = {"buying": "BUYER", "selling": "SELLER"}[facts["side"]]
    answers = steps([
        {"op": "navigate", "url": INBOX.format(side)},
        {"op": "wait", "seconds": 2.5},
        js({"op": "minimize"}),
        js({"op": "open_any", "name": facts["person"], "listing": facts["listing"]}),
        {"op": "wait", "seconds": 2.5},
        js({"op": "chat", "listing": facts["listing"], "name": facts["person"]}),
    ])
    o = first(answers, "opened")
    if o.get("error"):
        raise RuntimeError(f"the inbox: {o['error']}")
    a = first(answers, "chat")
    if a.get("error"):
        raise RuntimeError(f"opening {facts['person']}'s chat: {a['error']}")
    return a["chat"]


def chat_after_send(title, text):
    """Reads the inbox so the chat is recorded with the words sent; its entity, if found."""
    just_sent[:] = [x for x in just_sent if now_ms() - x[2] < 3600_000] + [(title, text, now_ms())]
    try:
        poll(full=True)
    except Exception as e:  # REVIEW: the send stands; the next poll records the chat
        log(f"reading the inbox after a send: {e}")
    hits = [(k, f) for k, f in chats.items() if f.get("listing") == title]
    hits.sort(key=lambda kf: (not same_words(kf[1].get("last_message", "").removeprefix("You: "), text), -(kf[1].get("seen_at") or 0)))
    if not hits:
        return None
    key, facts = hits[0]
    if facts.get("last_from") != "me" and same_words(facts.get("last_message", "").removeprefix("You: "), text):
        facts = {**facts, "last_from": "me", "waiting_on": "them", "unanswered": [], "seen_at": now_ms()}
        chats[key] = facts
        emit_chat(key, facts)
        save_chats()
    return key


def send_record(key, result):
    ents = [f"marketplace-send:{key}"] + [e for e in (result.get("chat"), result.get("listing_entity")) if e]
    who = result.get("person") or "the seller"
    said = f"“{(result.get('text') or '')[:140]}”"
    summary = {
        "sent": f"Sent {who} on Marketplace ({result.get('title')}): {said}",
        "already": f"Already in {who}'s chat ({result.get('title')}): {said}",
    }.get(result["status"], f"Not sent to {who} ({result.get('title')}): {result.get('summary')}")
    app.emit("send", {"entity": f"marketplace-send:{key}", "kind": "marketplace-send", "name": f"Message to {who}",
                      "summary": summary, "facts": {k: v for k, v in result.items() if k != "messages"}},
             about=ents, importance=0.6 if result["status"] == "sent" else 0.4)


def send(text, listing=None, chat=None, key=None, since=None, again=False, dry_run=False, ctx=None):
    """Message a Marketplace seller (or buyer) in the user's name and confirm it's in the chat."""
    text = (text or "").strip()
    if not text:
        raise ValueError("there are no words to send")
    if len(text) > 2000:
        raise ValueError(f"{len(text)} characters is more than Messenger takes in one message (2000)")
    if bool(listing) == bool(chat):
        raise ValueError("give listing (its id or link) or chat (one check lists), one of them")
    if not key and not dry_run:
        key = "mp-" + hashlib.sha1(f"{listing or chat}|{text}".encode()).hexdigest()[:12]
    if key and not dry_run:
        before = load_sends().get(key)
        if before and before.get("status") in ("sent", "already"):
            return {**before, "sent": True, "already": True, "summary": f"Already sent with this key, at {before.get('at_label')}: nothing sent again"}
    with poll_lock:
        result = {"key": key, "text": text, "mode": None, "listing_id": None, "title": None, "person": None, "chat": None}
        title = None
        try:
            if listing:
                lid = listing_id(listing)
                result.update(listing_id=lid, listing_url=f"{FB}/marketplace/item/{lid}/", listing_entity=f"marketplace-listing:{lid}")
                ctx and ctx.progress("Opening the listing")
                info = read_listing(lid)
                title = info["title"]
                result.update(title=title, person=info.get("seller"), price=info.get("price"), mode=info["mode"])
                if any(re.search(r"no longer available|^sold$", f, re.I) for f in info.get("flags") or []):
                    raise Refused("held", f"Not sent: the listing says {', '.join(info['flags'])}", flags=info["flags"])
                if info["mode"] == "first":
                    ctx and ctx.progress("Writing the first message")
                    f = first(steps([js({"op": "fill_box", "text": text}), {"op": "wait", "seconds": 0.4}, js({"op": "box", "text": text})]), "matches")
                    if f.get("error") or not f.get("matches"):
                        raise RuntimeError(f"the message box didn't hold the words exactly ({f.get('error') or f.get('length')}), so nothing was sent")
                    if dry_run:
                        tidy(title)
                        return {"dry_run": True, "sent": False, "mode": "first", "title": title, "person": info.get("seller"),
                                "summary": f"Ready: the first message to {info.get('seller')} is in the box on {title}; nothing was sent"}
                    ctx and ctx.progress("Sending")
                    a = first(steps([js({"op": "send_box", "text": text})]), "pressed")
                    if a.get("error"):
                        raise RuntimeError(f"the listing's Send: {a['error']}, so nothing was sent")
                elif info["mode"] == "again" or (info["mode"] == "none" and chat_of_listing(title, info.get("seller"))[0]):
                    known = chat_of_listing(title, info.get("seller"))[1] or {}
                    if dry_run and known.get("unread"):
                        raise Refused("held", "Dry run stopped: the chat is unread, and opening it would show them Seen")
                    ctx and ctx.progress("Opening the chat")
                    if info["mode"] == "again":
                        c = open_listing_chat(lid, info, ctx)
                    else:
                        k, facts = chat_of_listing(title, info.get("seller"))
                        result["chat"] = k
                        c = open_inbox_chat(facts)
                    result["mode"] = "chat"
                    guard(c["msgs"], text, since, again)
                    d = fill_and_send_chat(text, title, ctx, dry_run)
                    if dry_run:
                        tidy(title)
                        return {"dry_run": True, "sent": False, "mode": "chat", "title": title, "person": info.get("seller"), **d,
                                "messages": c["msgs"][-6:],
                                "summary": f"Ready: the words fit {info.get('seller')}'s chat composer on {title} and were cleared again; nothing was sent"}
                else:
                    raise Refused("held", "Not sent: the listing has no message box (it's the user's own, or sold, or gone); give chat instead if they've talked",
                                  own=info.get("own"))
            else:
                k, facts = find_chat(chat)
                title = facts["listing"]
                result.update(chat=k, title=title, person=facts.get("person_full") or facts.get("person"), mode="chat", side=facts.get("side"))
                if dry_run and facts.get("unread"):
                    raise Refused("held", "Dry run stopped: the chat is unread, and opening it would show them Seen")
                ctx and ctx.progress("Opening the chat from the inbox")
                c = open_inbox_chat(facts)
                guard(c["msgs"], text, since, again)
                d = fill_and_send_chat(text, title, ctx, dry_run)
                if dry_run:
                    tidy(title)
                    return {"dry_run": True, "sent": False, "mode": "chat", "title": title, "person": result["person"], **d,
                            "messages": c["msgs"][-6:],
                            "summary": f"Ready: the words fit the chat's composer ({result['person']} · {title}) and were cleared again; nothing was sent"}
            ctx and ctx.progress("Checking it's in the chat")
            found = confirm(text, title)
            tidy(title)
        except Refused as r:
            tidy(title) if title else None
            result.update(status=r.status, sent=r.status == "already", summary=r.summary, at=now_ms(), **r.facts)
            if r.status == "already":
                result["at_label"] = r.facts.get("sent_at_label")
            if not dry_run and key:
                if r.status == "already":
                    save_send(key, result)
                send_record(key, result)
            return result
        except Exception as e:
            status["send_failures"] += 1
            status["last_send_error"] = f"{str(e)[:200]}"
            if title:
                tidy(title)
            if not dry_run and key and result.get("title"):
                send_record(key, {**result, "status": "failed", "sent": False, "summary": str(e)[:300], "at": now_ms()})
            raise
        t = now_ms()
        result.update(status="sent", sent=True, at=t, at_label=found["at"], messages=found.get("msgs"))
        result["chat"] = chat_after_send(title, text) or result.get("chat")
        result["summary"] = f"Sent to {result.get('person') or 'them'} on Marketplace at {found['at']} ({title}), and it's in the chat"
        status["sends"] += 1
        status["last_send"] = t
        save_send(key, result)
        send_record(key, result)
        return result


def draft(text, listing=None, chat=None):
    """What sending these words would go into, sending nothing: the listing, the person, the mode, warnings,
    and the key and since to give send."""
    text = (text or "").strip()
    if not text:
        raise ValueError("give the words")
    if bool(listing) == bool(chat):
        raise ValueError("give listing (its id or link) or chat (one check lists), one of them")
    key = "mp-" + os.urandom(6).hex()
    since = now_ms()
    warnings, facts, info, lid, k = [], None, {}, None, None
    with poll_lock:
        if listing:
            lid = listing_id(listing)
            try:
                info = read_listing(lid)
            finally:
                try:
                    steps([{"op": "navigate", "url": "about:blank"}])
                except Exception:
                    pass
            k, facts = chat_of_listing(info["title"], info.get("seller"))
        else:
            k, facts = find_chat(chat)
    if listing:
        title, person = info["title"], info.get("seller")
        if info["mode"] == "none" and not facts:
            warnings.append("The listing has no message box (it's the user's own, sold or gone), so send would refuse.")
        if info.get("flags"):
            warnings.append(f"The listing says: {', '.join(info['flags'])}.")
    else:
        title, person = facts["listing"], facts.get("person_full") or facts.get("person")
    mode = "chat" if facts or info.get("mode") == "again" else "first"
    if facts and facts.get("unread") and facts.get("last_from") == "them":
        warnings.append(f"{facts.get('person')} wrote something unread: “{facts.get('last_message', '')[:160]}”.")
    elif facts and facts.get("unanswered"):
        warnings.append("Unanswered from them: " + " / ".join(f"“{u[:120]}”" for u in facts["unanswered"][-3:]))
    if facts and (facts.get("closed") or facts.get("event") == "sold"):
        warnings.append(f"{facts.get('person')} marked it sold.")
    url = f"{FB}/marketplace/item/{lid}/" if lid else INBOX.format({"buying": "BUYER", "selling": "SELLER"}.get((facts or {}).get("side"), "BUYER"))
    send_args = {"text": text, "key": key, "since": since}
    send_args.update({"listing": lid} if listing else {"chat": k})
    return {
        "key": key, "since": since, "text": text, "title": title, "person": person, "mode": mode,
        "price": info.get("price"), "place": info.get("place"), "photo": info.get("photo"), "url": url,
        "chat": k if facts else None, "latest": (facts or {}).get("last_message"), "warnings": warnings,
        "send": send_args,
    }


def chats_view():
    "The chats widget's data: the week's open chats, newest first, each marked when the user owes a reply."
    t = now_ms()
    recent = sorted((f for f in chats.values() if t - (f.get("last_at") or 0) < 7 * 86400_000
                     and not f.get("closed") and f.get("event") != "sold"), key=lambda f: -(f.get("last_at") or 0))[:10]
    rows = [{"label": f.get("person_full") or f.get("person") or "", "detail": f.get("listing") or "",
             "mark": "needsYou" if f.get("waiting_on") == "you" else ""} for f in recent]
    return {"rows": rows, "empty": "" if rows else "Nothing new"}


# Actions.


def act(action, args):
    if action == "check":
        state = poll(full=True)
        t = now_ms()
        days = float(args.get("days", 7))
        recent = sorted((f for f in chats.values() if t - (f.get("last_at") or 0) < days * 86400_000), key=lambda f: -(f.get("last_at") or 0))
        return {"state": state, "chats": [
            {k: f.get(k) for k in ("side", "person", "person_full", "listing", "last_from", "last_message", "unread", "waiting_on", "event", "time_label", "unanswered", "messages")}
            for f in recent]}
    raise ValueError(f"unknown action {action}")



TOOLS = [
    {
        "name": "check",
        "description": "Read the Marketplace inbox now (both Buying and Selling) and return the chats active in the last few days, newest first: person, listing, latest message and who sent it, unread, what's unanswered and recent messages.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "number",
                    "description": "How far back to list chats (default 7)."
                }
            }
        }
    }
]
READ_ONLY = ['check']
SPEAKS_FOR_PERSON = []


def tool(name):
    return lambda **args: act(name, args)


for spec in TOOLS:
    app.tool(tool(spec["name"]), name=spec["name"], description=spec["description"], schema=spec["input_schema"],
             read_only=spec["name"] in READ_ONLY, speaks_for_person=spec["name"] in SPEAKS_FOR_PERSON)



TEXT = {"type": "string", "description": "The words, exactly as the user asked for or approved them. Line breaks are kept."}
LISTING = {"type": "string", "description": "The listing: its id or its facebook.com/marketplace/item/ link."}
CHAT = {"type": "string", "description": "Or a chat the user already has (to reply, or about their own listing): its fb-marketplace-chat:... entity, \"Person · Listing\" as check names it, or words of its listing or person."}

app.tool(draft, name="draft",
         description=("What sending these words would go into, sending nothing: reads the listing (title, price, place, "
                      "seller, its photo's link) and the chat with them if there is one, without opening anything, and "
                      "answers the mode (first message or chat), the latest message, warnings (they wrote something "
                      "unread or unanswered, it's sold, there's no message box), and send's arguments with a key, so it "
                      "never goes twice, and since, so it holds back if they write first."),
         schema={"type": "object", "properties": {"text": TEXT, "listing": LISTING, "chat": CHAT}, "required": ["text"]},
         read_only=True)

app.tool(chats_view, name="chats_view", read_only=True)

BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"

app.widget("chats", "Marketplace chats", lambda: sbmcp.surface("chats", [
    {"id": "root", "component": "Column", "catalogId": BASIC_CATALOG, "children": ["list", "empty"]},
    {"id": "list", "component": "List", "catalogId": BASIC_CATALOG, "children": {"componentId": "chat", "path": "/rows"}},
    {"id": "chat", "component": "Row", "label": {"@path": "label"}, "mark": {"@path": "mark"}, "detail": {"@path": "detail"}},
    {"id": "empty", "component": "Text", "catalogId": BASIC_CATALOG, "text": {"@path": "/empty"}, "variant": "caption"},
]), tool="chats_view", refresh=["marketplace.chat"])

app.tool(lambda text, listing=None, chat=None, key=None, since=None, again=False, dry_run=False, ctx=None:
         send(text, listing, chat, key, since, again, dry_run, ctx), name="send",
         description=("Message a Marketplace seller (or buyer) in the user's name and confirm it's in the chat: opens the listing "
                      "in the user's Chrome (or the chat from the inbox), puts the words in the first-message box or the chat's "
                      "composer, reads them back, sends, and waits for the chat to show them sent by You; then closes the chat's "
                      "popup, emits a send event, and reads the inbox so the chat shows waiting on them. It holds back (sends "
                      "nothing) when they wrote after since, or the same words went to that chat in the last 15 minutes (unless "
                      "again); the same key never sends twice. Speaks for the user: only words they asked for or approved."),
         schema={"type": "object", "properties": {
             "text": TEXT, "listing": LISTING, "chat": CHAT,
             "key": {"type": "string", "description": "Never sends twice with the same key: draft's key."},
             "since": {"type": "integer", "description": "Epoch ms the words were drafted: hold back if they wrote after it (draft sets it)."},
             "again": {"type": "boolean", "description": "Send even though the same words went to this chat in the last 15 minutes."},
             "dry_run": {"type": "boolean", "description": "Open it and put the words in the box, check them, then take them out and stop: nothing is sent or recorded. Opening an existing chat marks it read, so a dry run refuses an unread one."}},
             "required": ["text"]},
         speaks_for_person=True)


app.background(loop)

