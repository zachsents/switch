"""Routine authorization and fresh verification codes, kept between local services."""

import email.utils
import re
import threading
import time

import mail
from server import app

_used = set()
_lock = threading.Lock()


def verification_code(text):
    """One unambiguous code near an authentication label; never a general number search."""
    found = set()
    for pattern in (r"(?:verification|security|sign[ -]?in|login|one[ -]?time|authentication)\s+(?:code|password)(?:\s+is)?[\s:：-]{0,30}(\d{4,8})\b",
                    r"\b(\d{4,8})\b[^\n]{0,40}(?:verification|security|sign[ -]?in|login|one[ -]?time|authentication)\s+code"):
        found.update(re.findall(pattern, text, re.IGNORECASE))
    return next(iter(found)) if len(found) == 1 else None


@app.tool(name="authentication_code", read_only=True,
          description="Private authentication transport: a fresh code for a bound browser challenge. Never call from a model or publish its result.",
          schema={"type": "object", "required": ["account", "sender", "service", "since"], "properties": {
              "account": {"type": "string"}, "sender": {"type": "string"}, "service": {"type": "string"}, "since": {"type": "number"}}})
def authentication_code(account, sender, service, since):
    """Reads only recent mail from the declared sender to this connected account, without observation events."""
    if not isinstance(since, (int, float)) or not time.time() * 1000 - 600000 <= since <= time.time() * 1000:
        raise ValueError("Challenge expired")
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", sender) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 .-]{1,79}", service):
        raise ValueError("A sender and service are required")
    acct = mail.find_account(account)
    query = f"from:{sender} after:{int(since / 1000)}"
    matches = []
    for mid in mail.list_ids(acct, query, 5):
        m = acct.get(f"messages/{mid}", format="full")
        if not since <= int(m.get("internalDate", 0)) <= time.time() * 1000:
            continue
        headers = m.get("payload", {}).get("headers", [])
        header = lambda name, headers=headers: mail.header(headers, name)
        if email.utils.parseaddr(header("From"))[1].lower() != sender.lower():
            continue
        recipients = [address.lower() for _, address in email.utils.getaddresses([header("To"), header("Delivered-To")])]
        if account.lower() not in recipients:
            continue
        if not re.search(r"(?:dkim|dmarc)=pass\b", header("Authentication-Results"), re.IGNORECASE):
            continue
        text = header("Subject") + "\n" + mail.text_of(m.get("payload", {}))
        if service.lower() not in text.lower():
            continue
        code = verification_code(text)
        if code:
            matches.append((mid, code))
    with _lock:
        fresh = [(mid, code) for mid, code in matches if (account, mid) not in _used]
        if len(fresh) != 1:
            return {"found": False}
        mid, code = fresh[0]
        _used.add((account, mid))
    return {"found": True, "code": code}


# Only authenticated app/extension requests can reach code contents; agent tool discovery omits it.
def register():
    """Hide the private transport from model discovery before serving any calls."""
    app._tools["authentication_code"][0]["_meta"] = {"ui": {"visibility": ["app"]}}
