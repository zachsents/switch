"""Google OAuth for the Google senses: one way to connect an account, from any browser.

A consent comes back through the install's own callback (`sb whoami`'s `oauth_callback`: the core's
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

    def stored(self):
        """The addresses with a token here. A Mac's Keychain can't be listed, so there the brain's entities name them."""
        return {k for k in self._file() if "@" in k}

    def account(self, address):
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
        callback. Works from any browser; `address` is suggested on Google's account chooser."""
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
