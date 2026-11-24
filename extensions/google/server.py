"""The google appendage's one MCP server (it was gmail, google-calendar, google-drive, google-sheets and google-oauth until
Nov 17). Each product keeps its own module, its own home under $SB_HOME (gmail/, calendar/, drive/, sheets/, oauth/: its
secrets.json and tokens), its own entities and streams, and the same tool names except where two collided: connect and
accounts take the product's name (calendar_connect, drive_accounts, gmail_connect...), and read, discard, connect and sync
are one tool each in main.py that picks the part by its arguments. One `finish` takes every consent back to the product
that started it, and `accounts` shows them all.
"""
import os

import sbmcp

HOME = os.environ.get("SB_HOME") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".home")
INSTANCE = os.environ.get("SB_INSTANCE") or "google@local"
NAME = "google"

app = sbmcp.Server(NAME, version="2", instructions=(
    "The user's Gmail, Drive and Sheets, and the shared Google sign-in (Calendar is the calendar extension's). "
    "In Switch, authorize refreshes/reuses existing grants and completes routine authorized consent itself; "
    "only an unavailable private credential, passkey or human check needs the user. Never ask for a code in chat. "
    "Gmail: every inbox he connects: inbox and sent mail recorded as gmail-message:<account>-<id> in comms/gmail "
    "(promotions, social and forums left out), each inbox as gmail-account:<account>, followed once a minute; search and "
    "read any mail; for an email in his name, approval writes it into Drafts and answers one approval card's parts "
    "(drafts, Send, resolve_when), draft writes one, send sends what he approved and checks Sent; drafts and discard; "
    "enable_send gives a read-only inbox send access with one tap of his; gmail_connect and gmail_accounts. "
    "Drive: upload puts a file (or a zipped folder) from any Mac or the server on his Drive and returns a link anyone with "
    "it can open, checked signed out; share, trash, files; drive_connect and drive_accounts. "
    "Sheets: read (with sheet) gives a tab's cells as the sheet shows them, tabs lists a spreadsheet's tabs; write and "
    "append change cells as a connected account; sheets_connect, sheets_accounts and sheets_status. "
    "Sign-in: setup gives a Google appendage the shared OAuth client; connect (with appendage) drives Google's consent up "
    "to its last page and puts one approval card up whose Approve runs grant; discard (with connect) drops one; kit, "
    "enable_apis, status. OAuth apps' consent screens: consent_scopes "
    "reads a project's Data Access page (scopes by tier, justifications, uses, video) as google-consent:<project>; "
    "set_consent_scopes makes it list exactly the scopes given, with each justification, uses and video, in one step up "
    "to Save, and answers an approval card's parts whose Approve runs save_consent_scopes (saved, then checked after a "
    "reload); scope_audit checks a project's scopes three ways (the code's allow-list and what its features request, "
    "the Data Access page, and its per-scope justification source), writes the audit and justification beside the "
    "source, and answers set_consent_scopes' arguments. "
    "read, discard, connect and sync are one tool each for every part, picked by their arguments; "
    "accounts lists every part's accounts and finish takes every consent back to the part that started it."),
    requests=["server@*", "macos@*", "gmail@*", "google-*@*"],
    reads=["asks", "*/accounts", "comms/gmail"],
    # legacy: the Keychain service its grants were kept in before Switch's connections (mail.KEYCHAIN), which Switch
    # moves into them.
    connections=[{"provider": "google", "multiple": True, "session": {"signIn": "authorize", "status": "connection_status"}, "legacy": "switchboard-gmail", "scopes": [
        "https://www.googleapis.com/auth/gmail.readonly",
        # Drafts and sending (mail.SEND_SCOPE), asked for in the same consent so nothing waits on a second one.
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/spreadsheets",
    ]}])

local = {}
"""Every tool's function by its name here, so one product can call another's in this process (oauth's connect calls
calendar_connect without a request to itself)."""


specs = {}
"""Every part's tools' declarations by their names here (description, schema...), for main.py's shared tools."""


class Part:
    """One product's view of the server: its events are named <product>.<event> (their streams as before, a
    heartbeat's in vitals/google), its tools keep their names but for those in `renames`, and `finish` is kept for the
    one finish to call rather than offered as a tool."""

    def __init__(self, product, renames=None, shared=()):
        self.product, self.renames, self.finish = product, renames or {}, None
        self.shared = set(shared)
        """Its tools whose names another part has too: kept in `local` under their renamed names, offered as one tool
        (main.py's) that picks the part by its arguments."""

    def event(self, name, description="", stream=None, **k):
        if stream and stream.startswith("vitals/"):
            stream = "vitals/google"
        return app.event(f"{self.product}.{name}", description, stream=stream, **k)

    def emit(self, name, *a, **k):
        return app.emit(f"{self.product}.{name}", *a, **k)

    def tool(self, fn=None, *, name=None, **k):
        def declare(f):
            n = name or f.__name__
            if n == "finish":
                self.finish = f
                return f
            shared = n in self.shared
            n = self.renames.get(n, n)
            local[n] = f
            specs[n] = {"product": self.product, **k}
            if shared:
                return f
            return app.tool(f, name=n, **k)
        return declare(fn) if fn is not None else declare

    def background(self, fn):
        return app.background(fn)

    def __getattr__(self, attr):
        return getattr(app, attr)


def part(product, renames=None, shared=()):
    return Part(product, renames, shared)


def home(product):
    path = os.path.join(HOME, product)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path
