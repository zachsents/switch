"""The uber-courier extension's MCP server: Uber couriers, in the user's own browser (uber.py).

Shared here: the server, the user's browser (switch-ext-browser's tools, through browser.py), config and state in the
extension's home, and a notification for the user (`sb notify`).
"""
import json
import os
import subprocess
import threading
import time

import sbmcp
from browser import Browser, BrowserError  # noqa: F401  (re-exported for the module)

NAME = "uber-courier"


def session(provider, label):
    """A website the extension drives through the user's browser, signed in as the user."""
    return {"provider": provider, "kind": "session", "label": label, "scopes": [], "multiple": False}


CONNECTIONS = [
    session("uber", "Uber"),
]

app = sbmcp.Server(NAME, version="1", instructions=(
    "Uber couriers in the user's own browser, signed in as the user: quote, stage, confirm, track, wait and discard. confirm books and speaks for the user, and runs only with their approval; stage answers the approval to put up. Signing in and human checks are the user's to do in their browser: the tool stops there and answers the ask to put up."),
    notifies=True, connections=CONNECTIONS, reaches={"calls": ["browser_act", "browser_run"]})

app.event("heartbeat", "How it is itself", stream=f"vitals/{NAME}", kind="observation", retention="signal")


def browser(part):
    """The user's browser for one part, in a tab of its own."""
    return Browser(app, session=f"{NAME}-{part}")


def home(*parts):
    """A path in the extension's home; folders made as needed."""
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


_locks = {}


def load(part, name="state.json", default=None):
    """One part's own file in home/<part>/ (JSON)."""
    try:
        with open(home(part, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {} if default is None else default


def save(part, value, name="state.json", secret=False):
    path = home(part, name)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f, indent=2, default=str)
    if secret:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def update(part, fn, name="state.json"):
    """Reads, changes (fn mutates the dict, or returns a new one) and writes one part's file under its lock."""
    lock = _locks.setdefault((part, name), threading.Lock())
    with lock:
        st = load(part, name)
        out = fn(st)
        if isinstance(out, dict):
            st = out
        save(part, st, name)
        return st


def notify(title, text, open_=None):
    """A notification for the user (`sb notify`); answers whether it went."""
    cmd = ["sb", "notify", "--title", title] + (["--open", open_] if open_ else []) + [text]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).returncode == 0
    except Exception:
        return False


def now_ms():
    return int(time.time() * 1000)


_live = set()


def session_live(provider):
    """The browser is signed in for it: the user's connection for it says so, once (a session holds no secret here)."""
    if provider in _live:
        return
    try:
        if not app.accounts(provider):
            app.adopt(provider, "default", {})
            app.log(f"{provider}: the browser's sign-in is the connection")
        _live.add(provider)
    except Exception as e:  # noqa: BLE001  (never stops the work it was seen in)
        app.log(f"{provider}: couldn't record the sign-in: {e}")
