"""Google OAuth for the Google senses: one way to connect an account.

In Switch, a consent is the core's (connections/connect): its Desktop client and PKCE, coming back to a loopback
redirect (`http://127.0.0.1:<port>/oauth/callback`, any port) that this process serves and relays to
connections/finish (`Relay`), so it's opened in a browser on this machine. A person on another device connects through
Switch's own Connect button instead (connections_request). What follows is how it was in Switchboard.

A consent came back through the install's own callback (`sb whoami`'s `oauth_callback`: the core's
`/oauth/callback` on its public address for pages), which hands the code to this sense's `finish`. So the person can
allow access from whatever browser they're on, their phone's included, signed in to the account or not; no Mac's
browser is in the way. The client is a Web-application client of the person's own Google Cloud project, with that
callback among its redirect URIs (`oauth-client`); tokens a Desktop client issued before (`oauth-client-desktop`)
keep refreshing through it.

Secrets never touch the log: on a Mac they live in the Keychain under the sense's own service, on a server in
`secrets.json` in its own `SB_HOME`, readable only by it. Each account's secret is JSON: its refresh token, which
client issued it, and the scopes it was granted.
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
PENDING_DAYS = 30
"""How long a consent link keeps working: an ask can wait in the person's queue for a while."""


class Disconnected(Exception):
    """The account's refresh token no longer works (or there isn't one): it has to be connected again."""


class TokenError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status, self.body = status, body


def post(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method="POST",
                                 headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise TokenError(e.code, e.read().decode(errors="replace")) from None


SWITCH = bool(os.environ.get("SWITCH_MACHINE"))
"""Run by Switch: accounts are the user's connections, reached through whoever runs this server (sbmcp's
accounts, token and adopt); nothing is kept here."""
PROVIDER = "google"


def _server():
    from server import app  # noqa: PLC0415  (the one server, made after this module loads)
    return app


def _connections(tool, args):
    """The core's connections app for a consent's start: its error's words come back (no credential is in them)."""
    headers = {"content-type": "application/json"}
    if os.environ.get("SWITCH_TOKEN"):
        headers["authorization"] = "Bearer " + os.environ["SWITCH_TOKEN"]
    req = urllib.request.Request((os.environ.get("SWITCH_URL") or "http://127.0.0.1:4871") + f"/widgets/connections/{tool}",
                                 data=json.dumps(args).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=90) as res:
        result = json.load(res)
    if result.get("isError"):
        said = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text").strip()
        raise ValueError(f"Switch wouldn't start the consent: {said[:200] or 'no reason given'}")
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])

class Relay:
    """Switch's redirect for a consent this process starts: a loopback listener on 127.0.0.1 (the core's Desktop client
    takes any port) that hands Google's answer to the core's connections/finish. One for the process, started on first
    use; each consent it started is kept a day."""

    KEEP_S = 86400

    def __init__(self):
        self.lock = threading.Lock()
        self.server = None
        self.pending = {}

    def url(self):
        with self.lock:
            if self.server is None:
                self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
                threading.Thread(target=self.server.serve_forever, daemon=True).start()
            return f"http://127.0.0.1:{self.server.server_port}/oauth/callback"

    def start(self, address=None):
        """Google's consent page through the core, for every scope Switch's extensions declare for Google."""
        redirect = self.url()
        consent = _connections("connect", {"provider": PROVIDER, **({"account": address} if address else {}),
                                           "redirectUri": redirect})
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(consent["url"]).query)["state"][0]
        with self.lock:
            now = time.time()
            self.pending = {s: at for s, at in self.pending.items() if at > now - self.KEEP_S}
            self.pending[state] = now
        return consent["url"]

    def _take(self, state):
        with self.lock:
            return self.pending.pop(state, None) is not None

    def _handler(self):
        relay = self

        class Callback(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _page(self, status, words):
                body = f"<!doctype html><meta charset=utf-8><title>Switch</title><p>{words}</p>".encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                from authorize import private  # noqa: PLC0415
                url = urllib.parse.urlsplit(self.path)
                params = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items() if len(v) == 1}
                if url.path != "/oauth/callback" or not relay._take(params.get("state", "")):
                    self._page(400, "This sign-in link wasn't started here, or it was already used.")
                    return
                declined = "error" in params or "code" not in params
                try:
                    private("connections", "finish", {"state": params["state"],
                                                      **({"error": params.get("error") or "no_code"} if declined else {"code": params["code"]})})
                except (OSError, ValueError, KeyError):
                    # A declined flow: the core drops it and answers with an error, as expected.
                    if not declined:
                        self._page(502, "Google answered, but Switch couldn't finish connecting the account. Start again from Switch.")
                        return
                if declined:
                    self._page(200, "Nothing was connected. You can close this tab.")
                    return
                self._page(200, "Connected to Switch. You can close this tab.")

        return Callback


relay = Relay()

OPENS = ("Opens in a browser on the machine this runs on (its Chrome, through the browser extension): Google comes back to "
         "Switch's loopback redirect here, which finishes it. To connect from the user's own device, use Switch's Connect "
         "button (connections_request) instead.")
"""What a consent link from connect says in Switch."""
CONNECT = ("In Switch it opens in a browser on the machine this runs on (Google comes back to Switch's loopback redirect "
           "here); for the user's own device, Switch's Connect button (connections_request) instead.")
"""What a connect tool's description says in Switch."""


class Google:
    def __init__(self, instance, home, keychain, scopes):
        self.instance, self.home, self.keychain, self.scopes = instance, home, keychain, scopes
        self.path = os.path.join(home, "secrets.json")
        self.lock = threading.RLock()
        self.pending = {}
        try:
            with open(os.path.join(home, "pending.json")) as f:
                self.pending = {s: p for s, p in json.load(f).items() if p["at"] > time.time() - PENDING_DAYS * 86400 and p.get("redirect")}
        except FileNotFoundError:
            pass

    # Secrets

    def _file(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def _keychain(self):
        """Whether its secrets live in this Mac's Keychain: on a Mac, unless its home keeps a secrets.json (as a
        server's appendage does, one moved from a server, or one google-oauth's setup gave the shared client to)."""
        return sys.platform == "darwin" and not os.path.exists(self.path)

    def get(self, name):
        if not self._keychain():
            return self._file().get(name)
        r = subprocess.run(["security", "find-generic-password", "-s", self.keychain, "-a", name, "-w"], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None

    def set(self, name, value):
        if self._keychain():
            subprocess.run(["security", "add-generic-password", "-U", "-s", self.keychain, "-a", name, "-w", value], check=True, capture_output=True)
            return
        with self.lock:
            stored = {**self._file(), name: value}
            fd = os.open(self.path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(stored, f)
            os.replace(self.path + ".new", self.path)

    # In Switch

    _adopted_at = 0

    def _connected(self):
        """{address: scopes} of the user's Google connections, after taking in any grant still kept here. None yet
        while the server's client hasn't finished its handshake: nothing waits on it."""
        if not _server()._ready.is_set():
            return {}
        self._adopt()
        try:
            return {a["account"]: set(a.get("scopes") or []) for a in _server().accounts(PROVIDER)}
        except RuntimeError as e:
            print(f"connections: {e}", file=sys.stderr, flush=True)
            return {}

    def _adopt(self):
        """Hands each grant this part kept before Switch to the user's connections, then forgets it. Retried a minute
        later when the connections aren't reachable yet."""
        if not os.path.exists(self.path) or time.time() - self._adopted_at < 60:
            return
        self._adopted_at = time.time()
        held = self._file()
        for address in [k for k in held if "@" in k]:
            try:
                grant = json.loads(held[address])
                kind = grant.get("client") or "web"
                client = held.get("oauth-client" if kind == "web" else f"oauth-client-{kind}")
                _server().adopt(PROVIDER, address, {"refresh_token": grant.get("refresh_token"), "scope": grant.get("scope", ""),
                                                    "client": client, "client_kind": kind})
            except (RuntimeError, ValueError, KeyError) as e:
                print(f"connections: {address} not taken in: {e}", file=sys.stderr, flush=True)
                continue
            with self.lock:
                left = self._file()
                left.pop(address, None)
                self._write(left)
        with self.lock:
            if not [k for k in self._file() if "@" in k]:
                os.remove(self.path)

    def _write(self, stored):
        fd = os.open(self.path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(stored, f)
        os.replace(self.path + ".new", self.path)

    def stored(self):
        if SWITCH:
            return {a for a, scopes in self._connected().items() if scopes & set(self.scopes)}
        """The addresses with a token here. A Mac's Keychain can't be listed, so there the brain's entities name them."""
        return {k for k in self._file() if "@" in k}

    def account(self, address):
        if SWITCH:
            scopes = self._connected().get(address)
            return None if scopes is None else {"scope": " ".join(sorted(scopes)), "client": PROVIDER}
        raw = self.get(address)
        return json.loads(raw) if raw else None

    def client(self, kind="web"):
        raw = self.get("oauth-client" if kind == "web" else f"oauth-client-{kind}")
        if not raw:
            raise RuntimeError(f"no {kind} OAuth client stored (oauth-client in {self.path} or the Keychain's {self.keychain})")
        c = json.loads(raw)
        return c.get("web") or c.get("installed") or c

    # Tokens

    def access(self, address):
        """A fresh access token for the account, and how long it lasts."""
        if SWITCH:
            try:
                token, expires = _server().token(PROVIDER, address)
            except RuntimeError as e:
                raise Disconnected(str(e)) from None
            return token, max(60, int(((expires or 0) - time.time() * 1000) / 1000) or 3600)
        acct = self.account(address)
        if not acct:
            raise Disconnected("no refresh token stored")
        c = self.client(acct["client"])
        try:
            t = post(TOKEN, {"client_id": c["client_id"], "client_secret": c["client_secret"],
                             "refresh_token": acct["refresh_token"], "grant_type": "refresh_token"})
        except TokenError as e:
            if e.status in (400, 401) and "invalid_grant" in e.body:
                raise Disconnected("Google revoked or expired the refresh token") from None
            raise
        return t["access_token"], t.get("expires_in", 3600)

    def granted(self, address):
        return set((self.account(address) or {}).get("scope", "").split())

    # Connecting

    def callback(self):
        if SWITCH:
            return relay.url()
        r = subprocess.run(["sb", "whoami"], capture_output=True, text=True)
        url = json.loads(r.stdout).get("oauth_callback") if r.returncode == 0 else None
        if not url:
            raise RuntimeError("this install has no public address for consent grants to come back to (sb whoami has no oauth_callback)")
        if url not in self.client().get("redirect_uris", [url]):
            raise RuntimeError(f"the OAuth client doesn't list {url} among its redirect URIs: add it in Google Cloud")
        return url

    def _save_pending(self):
        path = os.path.join(self.home, "pending.json")
        fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self.pending, f)
        os.replace(path + ".new", path)

    def consent_url(self, address=None, extra=()):
        """Google's consent page for this sense's scopes (and any `extra` ones), coming back through the install's
        callback. Works from any browser; `address` is suggested on Google's account chooser. In Switch: the core's
        consent, for every scope Switch's extensions declare for Google (`extra` among them), back through `relay`."""
        if SWITCH:
            return relay.start(address)
        redirect, c, scopes = self.callback(), self.client(), [*self.scopes, *extra]
        verifier = secrets.token_urlsafe(48)
        state = f"{self.instance}~{secrets.token_urlsafe(12)}"
        with self.lock:
            self.pending[state] = {"verifier": verifier, "address": address, "redirect": redirect, "scopes": scopes, "at": time.time()}
            self._save_pending()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        return AUTH + "?" + urllib.parse.urlencode({
            "client_id": c["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": " ".join(scopes),
            "access_type": "offline", "prompt": "consent", "include_granted_scopes": "false", "code_challenge": challenge,
            "code_challenge_method": "S256", "state": state, **({"login_hint": address} if address else {}),
        })

    def finish(self, args, missing):
        """Trades a consent's code for tokens: the token response, once every scope was granted. `missing` says what to
        tick when one wasn't. The caller stores it with `keep`, once it knows whose account it is."""
        with self.lock:
            p = self.pending.get(args.get("state", ""))
        if not p:
            raise ValueError("this sign-in link wasn't started here, or it was already used: start again from Switchboard")
        c = self.client()
        try:
            t = post(TOKEN, {"client_id": c["client_id"], "client_secret": c["client_secret"], "code": args["code"],
                             "code_verifier": p["verifier"], "grant_type": "authorization_code", "redirect_uri": p["redirect"]})
        except TokenError as e:
            raise ValueError(f"Google wouldn't trade the code for access ({e}): start again from Switchboard") from None
        finally:
            with self.lock:
                self.pending.pop(args["state"], None)
                self._save_pending()
        if not set(p.get("scopes", self.scopes)) <= set(t.get("scope", "").split()):
            raise ValueError(missing)
        if "refresh_token" not in t:
            raise ValueError("Google sent no refresh token: start again from Switchboard")
        return t

    def keep(self, address, t):
        self.set(address, json.dumps({"refresh_token": t["refresh_token"], "client": "web", "scope": t.get("scope", "")}))
