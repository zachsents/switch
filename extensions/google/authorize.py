"""Use the existing browser account for the core's declared OAuth permissions."""

import http.server
import json
import os
import threading
import time
import urllib.parse
import urllib.request

import authentication
import grant
from server import app

_lock = threading.Lock()


def private(app_name, tool, args):
    """Credentialed local service transport; response bodies never become error messages."""
    headers = {"content-type": "application/json"}
    if os.environ.get("SWITCH_TOKEN"):
        headers["authorization"] = "Bearer " + os.environ["SWITCH_TOKEN"]
    request = urllib.request.Request((os.environ.get("SWITCH_URL") or "http://127.0.0.1:4871") + f"/widgets/{app_name}/{tool}",
                                     data=json.dumps(args).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.load(response)
    if result.get("isError"):
        raise ValueError("Authentication operation failed")
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


class Tab:
    """One private background browser session; no snapshots or URLs escape this process."""
    def __init__(self, session):
        self.session = session

    def op(self, args):
        return private("browser", "act", {**args, "session": self.session})["text"]

    def snap(self):
        return json.loads(self.op({"op": "js", "code": grant.SNAP_JS}))

    def click(self, match):
        self.op({"op": "click", "match": match})


def authorize(account):
    with _lock:
        connections = private("connections", "list", {})["connections"]
        found = next((c for c in connections if c["provider"] == "google" and c["account"] == account), None)
        if not found:
            raise ValueError("No existing Google account")
        if not found["missing"]:
            return {"connected": True, "id": found["id"]}
        result, expected = {}, {"state": ""}
        callback_lock = threading.Lock()

        class Callback(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                url = urllib.parse.urlsplit(self.path)
                params = urllib.parse.parse_qs(url.query)
                if url.path != "/oauth/callback" or params.get("state") != [expected["state"]]:
                    self.send_error(400)
                    return
                with callback_lock:
                    if result:
                        self.send_error(410)
                        return
                    try:
                        result.update(private("connections", "finish", {
                            "state": expected["state"], **{k: v[0] for k, v in params.items() if k in ("code", "error") and len(v) == 1}}))
                    except (OSError, ValueError, KeyError):
                        result["blocked"] = "authorization_failed"
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"Authorization received. You can close this tab.")

        listener = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Callback)
        threading.Thread(target=listener.serve_forever, daemon=True).start()
        session = "connection-google-" + __import__("hashlib").sha256(account.encode()).hexdigest()[:12]
        tab, counts, blocked = Tab(session), {}, "timed_out"
        try:
            consent = private("connections", "connect", {"provider": "google", "account": account,
                               "redirectUri": f"http://127.0.0.1:{listener.server_port}/oauth/callback"})
            expected["state"] = urllib.parse.parse_qs(urllib.parse.urlsplit(consent["url"]).query)["state"][0]
            tab.op({"op": "navigate", "url": consent["url"]})
            started = time.time() * 1000
            deadline = time.time() + 100
            while time.time() < deadline:
                if result:
                    return result
                try:
                    snapshot = tab.snap()
                except (ValueError, OSError):
                    time.sleep(0.8)
                    continue
                move = grant.classify(snapshot, account, "127.0.0.1")
                kind = move["kind"]
                counts[kind] = counts.get(kind, 0) + 1
                if kind == "done":
                    time.sleep(0.5)
                    continue
                if kind == "person":
                    if move["step"] == "code":
                        code = authentication.authentication_code(account, "no-reply@accounts.google.com", "Google", started)
                        if code.get("found"):
                            tab.op({"op": "sign_in", "otp": code["code"], "backgroundOnly": True})
                            continue
                    blocked = move["step"]
                    break
                if counts[kind] > (12 if kind == "wait" else 3):
                    blocked = "saved_sign_in_unavailable" if kind == "password" else "page_did_not_advance"
                    break
                if kind in ("pick", "continue", "try_another", "choose_password"):
                    tab.click(move["match"])
                elif kind == "password":
                    tab.op({"op": "sign_in", "account": account, "backgroundOnly": True})
                elif kind == "identifier":
                    tab.op({"op": "type", "match": "Email or phone", "text": account})
                    tab.click('button "Next"')
                elif kind == "another":
                    tab.click("/Use another account/")
                elif kind == "consent":
                    tab.op({"op": "js", "code": grant.TICK_JS})
                    tab.click(move["match"])
                elif kind == "unverified":
                    if not any("unsafe" in control.lower() for control in snapshot.get("controls", [])):
                        tab.click("Advanced")
                    tab.click("/Go to .*unsafe/")
                time.sleep(0.8)
        except (OSError, ValueError, KeyError):
            blocked = "saved_sign_in_unavailable"
        finally:
            if not result and expected["state"]:
                try:
                    private("connections", "finish", {"state": expected["state"], "error": "cancelled"})
                except (OSError, ValueError, KeyError):
                    # The core consumes a declined flow before returning its expected error.
                    expected["state"] = ""
            listener.shutdown()
            listener.server_close()
        return {"connected": False, "blocked": blocked, "view": {"app": "browser", "name": "tab", "input": {"session": session}}}


def connection_status(account=None):
    return {"accounts": [{"account": c["account"]} for c in private("connections", "list", {})["connections"] if c["provider"] == "google" and not c["missing"] and (account is None or c["account"] == account)]}


def register():
    """Offer recovery and status on the existing Google extension."""
    app.tool(authorize, name="authorize", description="Complete routine authorized Google sign-in and the core's declared required scopes using existing browser accounts. Returns verified connected or the precise remaining challenge; credentials never leave this service.", schema={"type":"object","required":["account"],"properties":{"account":{"type":"string"}}})
    app.tool(connection_status, name="connection_status", read_only=True, description="Google accounts with the declared permissions.", schema={"type":"object","properties":{"account":{"type":"string"}}})
