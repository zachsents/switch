"""In Switch: Calendar is its own extension (calendar), so this one is Gmail, Drive, Sheets and the shared sign-in.

google: The user's Google services as one appendage, on the server in server.py: Gmail (mail.py), calendar (gcal.py),
Drive (drive.py), Sheets (sheets.py) and the shared sign-in (oauth.py). It was gmail, google-calendar, google-drive,
google-sheets and google-oauth until Nov 17.

Four names were each a tool of two parts: read (Gmail's message, Sheets' tab), discard (Gmail's draft, a connect waiting
on the user), connect (oauth's one-approval connect, Gmail's consent link) and sync (Gmail's mail, calendar's events). Each
is one tool here that hands the call to the part its arguments are for, so every caller keeps the name it used.

- Its tests: python3 -I run_tests.py (each test file in its own process; together in one they trip over each other)
- Installing it: sb install --dir <checkout> --test 'python3 -I run_tests.py' --try status
"""
import inspect

import authentication
import authorize

import drive
import mail
import gmail_files  # noqa: F401  (Gmail's attachments tool)
import oauth  # noqa: F401  (its tools and loops)
import data_access  # noqa: F401  (an OAuth app's Data Access page: consent_scopes, set_consent_scopes, save_consent_scopes)
import scope_audit  # noqa: F401  (an OAuth app's scopes checked against its code, Console and justifications)
import sheets
from server import app, local, specs

authentication.register()
authorize.register()

PARTS = {"gmail": mail, "drive": drive, "sheets": sheets}


@app.tool(name="finish", description="Finish a consent with the code Google sent back, for whichever part started it (Gmail, Drive or Sheets). The core's OAuth callback calls this.",
          schema={"type": "object", "required": ["code", "state"], "properties": {
              "code": {"type": "string"}, "state": {"type": "string"}, "redirect_uri": {"type": "string"}}})
def finish(code, state, redirect_uri=None):
    args = {"code": code, "state": state, **({"redirect_uri": redirect_uri} if redirect_uri else {})}
    started = [m for m in PARTS.values() if state in (getattr(m.google, "pending", None) or {})]
    if started:
        return started[0].app.finish(**args)
    # None says it started it (a part that keeps its consent grants some other way): each part's own finish knows its own.
    for module in PARTS.values():
        try:
            return module.app.finish(**args)
        except ValueError as e:
            if "wasn't started here" not in str(e):
                raise
    raise ValueError("this sign-in link wasn't started here, or it was already used: start again from Switchboard")


@app.tool(name="accounts", read_only=True, schema={"type": "object", "properties": {}},
          description="Every connected Google account, by part: gmail (each inbox, whether it can send, its unread counts), drive (which is the default, its storage) and sheets (writing), and whether each still works.")
def accounts():
    out = {}
    for product in PARTS:
        try:
            out[product] = local[f"{product}_accounts"]()
        except Exception as e:
            out[product] = {"error": f"{type(e).__name__}: {e}"[:300]}
    return out


def call(name, args, ctx):
    """One part's own tool, called as sbmcp would: only the arguments it takes, and ctx when it wants it."""
    fn = local[name]
    takes = inspect.signature(fn).parameters
    if not any(p.kind == p.VAR_KEYWORD for p in takes.values()):
        args = {k: v for k, v in args.items() if k in takes}
    if "ctx" in takes:
        args["ctx"] = ctx
    return fn(**args)


def shared(name, picks, description, read_only=False, speaks=False):
    """One tool for a name two parts have: picks says, in order, which part's tool takes the call (the first whose
    test the arguments pass; the last is the default). Its schema is both parts' properties, none required."""
    props = {}
    for part_tool, _ in picks:
        for k, v in specs[part_tool].get("schema", {}).get("properties", {}).items():
            props.setdefault(k, v)

    def run(ctx=None, **args):
        for part_tool, test in picks:
            if test(args):
                return call(part_tool, args, ctx)
        raise ValueError(f"{name}: say which: {description}")

    app.tool(run, name=name, description=description, schema={"type": "object", "properties": props},
             read_only=read_only, speaks_for_person=speaks)


def has(*keys):
    return lambda a: any(a.get(k) not in (None, "") for k in keys)


shared("read", [("sheets_read", has("sheet")), ("gmail_read", has("id"))], read_only=True, description=(
    "Gmail: one message in full (account and id, its facts.message_id): headers, attachment names and its text body, "
    "and answer: who a reply and a reply-all would reach, and the approval or send call that answers it in the user's name. "
    "Sheets (sheet, tab...): " + specs["sheets_read"]["description"][0].lower() + specs["sheets_read"]["description"][1:]))

shared("discard", [("oauth_discard", has("connect")), ("gmail_discard", has("account", "draft", "draft_thread"))], description=(
    "Gmail: delete a draft, sending nothing (account, and draft or draft_thread): one I made, or any draft by its id; "
    "for an approval he declined or a reply that's moot. Returns what it was. Or, with connect: drop a connect waiting "
    "on the user (it's moot, or he declined): closes its card if it's open and lets its tab go. Nothing is granted."))

shared("connect", [("oauth_connect", has("appendage")), ("gmail_connect", lambda a: True)], description=(
    "With appendage: " + specs["oauth_connect"]["description"] + " Without it (address, send): Gmail's own consent "
    "link, as gmail_connect gives it."))


def sync(backfill=False):
    """Gmail's mailboxes, looked at now."""
    out = {}
    for product, tool, args in (("gmail", "gmail_sync", {"backfill": backfill}),):
        try:
            out[product] = call(tool, args, None)
        except Exception as e:
            out[product] = {"error": f"{type(e).__name__}: {e}"[:300]}
    return out


app.tool(sync, name="sync", schema={"type": "object", "properties": {"backfill": {
    "type": "boolean", "description": "Gmail: read the last two weeks of inbox and sent mail again."}}},
    description="Look at every Gmail account for changes now; with backfill, read the last two weeks of inbox and sent mail again.")


@app.background
def take_in():
    """In Switch: each part's grants kept from before are handed to the user's connections once its client is up,
    and Sheets learns its accounts from them (again every ten minutes)."""
    import time
    import google_oauth
    if not google_oauth.SWITCH:
        return
    app._ready.wait()
    while True:
        for module in PARTS.values():
            module.google.stored()
        sheets.load_accounts()
        time.sleep(600)


if __name__ == "__main__":
    sheets.load_accounts()  # what google-sheets did as it started: the accounts it writes as, from its secrets
    app.run()
