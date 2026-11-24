"""The people-search extension's MCP server, which people.py declares its tools and events on.

Shared here: the server, the user's browser (switch-ext-browser's tools, through browser.py), the extension's home, config,
files it keeps for the user to open, the `need` event (kind ask), its health and the status tool.
"""
import json
import os
import re
import shutil
import threading
import time

import sbmcp
from browser import Browser, BrowserError

NAME = "people-search"

app = sbmcp.Server(NAME, version="1", instructions=(
    "Public-records people-search results for a phone number (phone), a name (name), an address (address), an email (email), or a person page from an earlier result (person). The sites load in the user's browser (switch-ext-browser); human checks are never solved: the tool says so and a `need` asks the user. status: how it is."),
    reaches={"calls": ["browser_act", "browser_run"]})

app.event("need", "Something the user must do: pass a site's human check in the browser tab",
          stream=f"asks/{NAME}", kind="ask")
app.event("heartbeat", "How it is itself", stream=f"vitals/{NAME}", kind="observation", retention="signal")

HEARTBEAT_S = 1800


def browser(session):
    """The user's browser, in a tab of its own named `session`."""
    return Browser(app, session=f"{NAME}-{session}")


def op(session, args, timeout=60):
    """One op as the old macOS browser action took it, in the session's tab: its output."""
    return browser(session).op(args, timeout)


def op_text(session, args, timeout=60):
    """One op's answer as the old browser action gave it: {ok, output (text), error}."""
    try:
        out = op(session, args, timeout)
    except BrowserError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "output": out if isinstance(out, str) else json.dumps(out)}


def as_json(value):
    """A page's answer read as JSON, whether it came back parsed or as JSON text."""
    if isinstance(value, str):
        return json.loads(value)
    return value


def async_expression(code):
    """Code written with a top-level await, as one expression the browser awaits."""
    return "(async () => { return " + code.strip().rstrip(";") + "; })()"


def upload(session, label, paths, timeout=120):
    """Attaches files to the page's file input labelled `label`, found by number in the tab's text outline."""
    b = browser(session)
    look = b.tool("act", wait=timeout, op="look")
    number = None
    for line in look.splitlines():
        for found in re.finditer(r"\[(\d+)\][^\[]*", line):
            if label in found[0]:
                number = int(found[1])
                break
        if number is not None:
            break
    if number is None:
        raise BrowserError(f"upload: no file input labelled {label!r} in the page")
    return b.tool("act", wait=timeout, op="upload", element=number, paths=list(paths))


def home(*parts):
    """A path in the extension's home; its folder made as needed."""
    path = os.path.join(sbmcp.home(), *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def config(part):
    """One part's config: config.json's `part` key in the extension's home ({} when there's none)."""
    try:
        with open(home("config.json")) as f:
            return dict(json.load(f).get(part) or {})
    except (OSError, ValueError):
        return {}


def keep_file(path, mime, part):
    """Keeps a file the answer points at in home/files/<part>/ (the newest 50): its {path, type, name}."""
    folder = os.path.dirname(home("files", part, "x"))
    dest = os.path.join(folder, f"{int(time.time())}-{os.path.basename(path)}")
    shutil.move(path, dest)
    kept = sorted((os.path.join(folder, n) for n in os.listdir(folder)), key=os.path.getmtime)
    for old in kept[:-50]:
        try:
            os.remove(old)
        except OSError:
            pass
    return {"path": dest, "type": mime, "name": os.path.basename(path)}


def need(part, key, summary, **facts):
    """Asks the user for something (kind ask); `key` makes it one ask, not many."""
    app.emit("need", {"entity": f"need:{NAME}-{part}-{key}", "summary": summary, "facts": {"part": part, **facts}},
             id=f"{NAME}-{part}-{key}")


_health = {}
_lock = threading.Lock()


def health(part, fn):
    """Registers how a part is (fn answers a dict, with last_error when it has one)."""
    with _lock:
        _health[part] = fn


def all_health():
    out = {}
    for part, fn in list(_health.items()):
        try:
            out[part] = fn()
        except Exception as e:  # noqa: BLE001 - one part's health failing says so, the rest still answer
            out[part] = {"last_error": f"{type(e).__name__}: {e}"}
    return out


@app.tool(read_only=True)
def status():
    """How it is itself: its calls and failures, last error and last answer, and what it drives."""
    return all_health()


def heartbeat():
    for part, facts in all_health().items():
        error = facts.get("last_error")
        if isinstance(error, dict):
            error = "; ".join(f"{k}: {v}" for k, v in error.items() if v) or None
        app.emit("heartbeat", {"entity": f"sense:{NAME}-{part}", "summary": f"Last failed: {error}" if error else "Ready",
                               "facts": json.loads(json.dumps(facts, default=str))})


@app.background
def beat():
    while True:
        heartbeat()
        time.sleep(HEARTBEAT_S)
