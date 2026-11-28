"""Google's sign-in and consent, driven in a background tab of a Mac's Chrome (the Mac mini's, signed in to the user's
Google accounts) through the macOS appendage's browser action, for any Switchboard Google appendage's scopes.

The driving stops on Google's last page, the one whose Continue grants the scopes: that click is the user's, so the tab is
held there and an approval goes in his queue, whose Approve presses it. A step only a person can do on the way (a
passkey, a prompt on his phone, a CAPTCHA) goes up instead as a card with that tab live on it.

Grown from gmail's grant.py (its send-access grant), made general: the last page is the one that lists the scopes
(Google's granular consent, with a box each), or a sign-in confirmation that leads nowhere else. `classify` reads a
page and says the next move; it's pure, so it's tested without a browser. `Tab` is one session in the Mac's Chrome,
spoken to with `sb request`; `drive` walks Google's pages with them.
"""

import json
import re
import subprocess
import time
import urllib.parse

SNAP_JS = r"""(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" };
  const words = (e) => (e.innerText || e.getAttribute("aria-label") || e.value || e.getAttribute("data-identifier") || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const controls = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=checkbox], input[type=submit], li[data-identifier], div[data-identifier]")]
    .filter(seen).map(words).filter(Boolean);
  const boxes = [...document.querySelectorAll("input[type=checkbox]")].filter((c) => !c.disabled);
  return { href: location.href, title: document.title, text: document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 2500) : "", controls: [...new Set(controls)].slice(0, 80), boxes: boxes.length, unchecked: boxes.filter((c) => !c.checked).length };
})()"""
"""Runs in the tab: where it is, what it says and what can be pressed there."""

TICK_JS = r"""(() => {
  let ticked = 0;
  for (const c of document.querySelectorAll("input[type=checkbox]")) { if (!c.checked && !c.disabled) { c.click(); ticked++ } }
  return { ticked, left: [...document.querySelectorAll("input[type=checkbox]")].filter((c) => !c.checked && !c.disabled).length };
})()"""
"""Ticks every scope's box on a consent page (Google's granular consent): ticking grants nothing until Continue."""

SCOPES_JS = r"""(() => {
  const clean = (t) => (t || "").replace(/\s+/g, " ").replace(/\s*See access details\s*$/i, "").replace(/\s*Learn more\s*$/i, "").trim();
  const named = (c) => {
    const ids = (c.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const byId = ids.map((i) => (document.getElementById(i) || {}).innerText || "").join(" ");
    if (clean(byId)) return clean(byId);
    if (c.getAttribute("aria-label")) return clean(c.getAttribute("aria-label"));
    const holder = c.closest("label, li, [role=listitem]") || (c.parentElement && c.parentElement.parentElement);
    return clean(holder ? holder.innerText : "");
  };
  return [...document.querySelectorAll("input[type=checkbox]")].map(named).filter(Boolean);
})()"""
"""Runs on the last page: what each scope's box grants, in Google's words."""

def grants_in(text):
    """What the last page grants, from its words, when it lists the scopes without a box each (a consent for one
    scope): the lines under "will be able to", up to the next part of the page."""
    m = re.search(r"will be able to:?\s*\n(.*?)(?=\n[^\n]*(?:Make sure you trust|already has some access|Review [^\n]*Privacy)|\nCancel\b|\nContinue\b|\Z)", text or "", re.S)
    if not m:
        return []
    lines = [re.sub(r"\s*(See access details|Learn more)\s*$", "", line.strip(), flags=re.I) for line in m.group(1).split("\n")]
    return [line for line in lines if line and not re.fullmatch(r"(See access details|Learn more|Loading)", line, re.I)][:12]


PERSON_STEPS = {"passkey", "phone_prompt", "captcha", "code", "security_key", "rejected", "error", "unknown"}


def classify(snap, account, callback_host):
    """The next move on the page, for a consent as `account` that comes back to `callback_host` (the core's public
    address). A dict: kind, why, and for some a match (what to click) or step (what only a person can do)."""
    href, text, controls = snap.get("href", ""), snap.get("text") or "", snap.get("controls") or []
    try:
        u = urllib.parse.urlsplit(href)
    except ValueError:
        return {"kind": "wait", "why": "the page is loading"}
    p, host = u.path, u.hostname or ""
    query = urllib.parse.parse_qs(u.query)

    def has(pattern):
        return next((c for c in controls if re.search(pattern, c, re.I)), None)

    first = next((line.strip() for line in text.split("\n") if line.strip() and line.strip() != "Loading"), snap.get("title", ""))[:200]

    if host == callback_host:
        if re.search(r"error|wasn.t granted|refused|didn.t|couldn.t|failed|start again", text, re.I):
            return {"kind": "person", "step": "error", "why": f"Switchboard answered: {first}"}
        return {"kind": "done", "why": "Google sent it back to Switchboard"}
    if u.scheme in ("about", "chrome", "") or not host:
        return {"kind": "wait", "why": "the page is loading"}
    if host != "accounts.google.com":
        return {"kind": "person", "step": "unknown", "why": f"it went to {host}, not Google's sign-in"}

    # What only a person can do.
    if "/challenge/recaptcha" in p or (re.search(r"/identifier", p) and re.search(r"captcha|I'm not a robot|type the text you hear or see", text, re.I)):
        return {"kind": "person", "step": "captcha", "why": "Google wants a human check (CAPTCHA) on the sign-in"}
    if "/rejected" in p:
        return {"kind": "person", "step": "rejected", "why": "Google turned the sign-in away on the Mac (\"Something went wrong\")"}
    if "/challenge/pk/presend" in p:
        return {"kind": "person", "step": "passkey", "why": f"Google wants {account}'s passkey and offers nothing else"}
    if "/challenge/pk" in p:
        other = has(r"^Try another way$")
        return ({"kind": "try_another", "match": f'button "{other}"', "why": "Google asks for a passkey; trying another way"}
                if other else {"kind": "wait", "why": "the passkey page is loading"})
    if "/challenge/selection" in p:
        if has(r"Enter your password"):
            return {"kind": "choose_password", "match": "Enter your password", "why": "Google offers a password instead of the passkey"}
        return {"kind": "person", "step": "passkey", "why": f"Google offers no password for {account} here, only: {'; '.join(controls[:6])}"}
    if "/challenge/pwd" in p:
        return {"kind": "password", "why": "Google wants the password"}
    if re.search(r"/challenge/(dp|az|ootp|ipe|ap)\b", p) or re.search(r"Check your (phone|Pixel|iPhone)|Tap \*?Yes\*? on|open the Gmail app", text, re.I):
        return {"kind": "person", "step": "phone_prompt", "why": "Google sent a sign-in prompt to the user's phone"}
    if re.search(r"/challenge/(ipp|totp|sms|iap|bc)", p):
        return {"kind": "person", "step": "code", "why": "Google wants a verification code"}
    if re.search(r"/challenge/(sk|skotp)", p):
        return {"kind": "person", "step": "security_key", "why": "Google wants a security key"}
    if "/challenge/" in p:
        return {"kind": "person", "step": "unknown", "why": f"Google asks for something else: {first}"}

    # Sign-in.
    if re.search(r"/signin/(v\d/)?identifier|/v3/signin/identifier", p):
        if re.search(r"Couldn.t find your Google Account|Enter a valid email|This account doesn.t exist", text, re.I):
            return {"kind": "person", "step": "error", "why": f"Google has no account {account}"}
        return {"kind": "identifier", "why": f"signing in as {account}"}
    if re.search(r"accountchooser|oauthchooseaccount|selectaccount", p, re.I):
        if account and has(re.escape(account)):
            return {"kind": "pick", "match": account, "why": f"picking {account} on Google's account chooser"}
        return {"kind": "another", "why": f"{account} isn't on the chooser; using another account"}

    # Consent. Google's paths carry a version now (/signin/oauth/v3/consent), and didn't before.
    if re.search(r"/signin/oauth/(v\d/)?warning", p):
        return {"kind": "unverified", "why": "Google's \"hasn't verified this app\" page (it's the user's own app): going on to it"}
    if re.search(r"/signin/oauth/error|/o/oauth2/.*error|deniedsigninrejected|/info/unknownerror", p) or re.search(r"Error 400|invalid_request|Access blocked|access_denied|redirect_uri_mismatch", text):
        return {"kind": "person", "step": "error", "why": f"Google refused: {first}"}
    if re.search(r"/signin/oauth", p) and has(r"^(Continue|Allow)$"):
        go = has(r"^(Continue|Allow)$")
        # A sign-in confirmation ("Sign in to <app>": it shares only who the account is) grants nothing yet when a
        # consent page follows it, which its requestPath names.
        leads_on = re.search(r"consent", (query.get("requestPath") or [""])[0])
        if re.search(r"/signin/oauth/(v\d/)?(id|delegation|firstparty)\b", p) and not snap.get("boxes") and leads_on:
            return {"kind": "continue", "match": f'button "{go}"', "why": f"pressing {go} on the sign-in page to reach the scopes"}
        return {"kind": "consent", "match": f'button "{go}"', "unchecked": snap.get("unchecked", 0),
                "why": "Google's last page: its Continue grants the access"}
    if re.search(r"/signin/oauth", p):
        return {"kind": "wait", "why": "the consent page is loading"}
    return {"kind": "wait", "why": f"on {p}"}


class Failed(Exception):
    pass


def request(target, action, args, timeout_s=60):
    """An appendage's action through `sb request`: its output (parsed when it's JSON), or Failed with its error."""
    r = subprocess.run(["sb", "request", target, action, "--args", json.dumps(args), "--timeout", str(timeout_s)],
                       capture_output=True, text=True, timeout=timeout_s + 30)
    out = r.stdout
    at = out.find("{")
    try:
        answer = json.loads(out[at:] if at >= 0 else out)
    except ValueError:
        raise Failed(f"{target} {action}: {(r.stderr or r.stdout).strip()[-400:] or 'no answer'}") from None
    if not answer.get("ok"):
        raise Failed(f"{target} {action}: {answer.get('error') or 'failed'}")
    return answer.get("output")


def parsed(out):
    """The first JSON value in what an action printed (Switch's browser extension answers it as {"text": ...})."""
    if isinstance(out, dict) and isinstance(out.get("text"), str):
        out = out["text"]
    if not isinstance(out, str):
        return out
    at = re.search(r"[\[{]", out)
    return json.loads(out[at.start():] if at else out)


class Tab:
    """One background tab (a session) in a Mac's Chrome."""

    def __init__(self, mac, session, ask=None):
        self.mac, self.session = mac, session
        self.ask = ask or request

    @property
    def target(self):
        return f"macos@{self.mac}"

    def op(self, args, timeout_s=60):
        return self.ask(self.target, "browser", {**args, "session": self.session}, timeout_s)

    def js(self, code):
        return parsed(self.op({"op": "js", "code": code}))

    def snap(self):
        last = None
        for _ in range(4):
            try:
                return self.js(SNAP_JS)
            except (Failed, ValueError) as e:
                last = e  # Mid-navigation: the page is going.
                time.sleep(1.2)
        raise Failed(f"can't read the tab: {last}")

    def click(self, match, timeout=6):
        self.op({"op": "click", "match": match, "timeout": timeout})

    def leave(self, href, seconds=12):
        """Waits for the tab to leave a URL (a click's navigation)."""
        until = time.time() + seconds
        while time.time() < until:
            time.sleep(0.9)
            try:
                if self.js("({ href: location.href })")["href"] != href:
                    return
            except (Failed, ValueError, KeyError, TypeError):
                pass

    def screenshot(self):
        """The tab as it looks, as a blob for a card: {blob, type, bytes, name}, or None."""
        try:
            out = self.op({"op": "screenshot"})
            image = (out.get("images") or [None])[0] if isinstance(out, dict) else None
        except Failed:
            return None
        if not image:
            return None
        return {"blob": image["blob"], "type": image.get("type", "image/jpeg"), "bytes": image.get("bytes"), "name": "google-consent.jpg"}

    def hold(self, hours):
        try:
            self.op({"op": "hold", "hours": hours})
        except Failed:
            pass

    def release(self):
        try:
            self.op({"op": "release"})
        except Failed:
            pass


def drive(tab, url, account, callback_host, deadline, approved=False, progress=lambda m: None):
    """Walks Google's sign-in and consent in the tab: from url, or (without one) wherever the tab is. Without approved it
    stops on the last page, boxes ticked and Continue unpressed: {"state": "ready", grants}. With it, it presses Continue
    and follows Google back to Switchboard: {"state": "granted"}. A step only a person can do: {"state": "person", step,
    why}."""
    if url:
        tab.op({"op": "navigate", "url": url}, 45)
    tries = {}
    while time.time() < deadline:
        s = tab.snap()
        move = classify(s, account, callback_host)
        where = s.get("href", "").split("?")[0]
        key = f"{move['kind']}|{where}"
        tries[key] = n = tries.get(key, 0) + 1
        kind = move["kind"]
        if kind == "done":
            return {"state": "granted", "where": where, "says": s.get("text", "")[:400]}
        if kind == "person":
            return {"state": "person", "step": move["step"], "why": move["why"], "where": where}
        if kind == "wait":
            if n > 12:
                return {"state": "person", "step": "unknown", "why": f"the page stayed on {where} ({s.get('title')})", "where": where}
            time.sleep(1.5)
            continue
        if kind == "consent" and not approved:
            if move.get("unchecked"):
                ticked = tab.js(TICK_JS)
                if ticked.get("left"):
                    outline = tab.op({"op": "look"})
                    for m in re.finditer(r'\[(\d+)\] checkbox "[^"]*\| unchecked', outline if isinstance(outline, str) else ""):
                        tab.op({"op": "click", "element": int(m.group(1))})
                    if tab.js(TICK_JS).get("left"):
                        return {"state": "person", "step": "unknown", "why": "a scope's box on Google's page won't tick", "where": where}
            try:
                grants = [g for g in tab.js(SCOPES_JS) or [] if isinstance(g, str)]
            except (Failed, ValueError):
                grants = []
            grants = grants or grants_in(s.get("text", ""))
            return {"state": "ready", "where": where, "grants": grants, "says": s.get("text", "")[:600]}
        if n > (2 if kind == "try_another" else 3):
            if kind == "try_another":
                return {"state": "person", "step": "passkey", "why": "Google wants the passkey, and the Mac can't give it", "where": where}
            return {"state": "person", "step": "unknown", "why": f"{move['why']}, but the page stayed on {where}", "where": where}
        progress(move["why"][0].upper() + move["why"][1:])
        try:
            if kind == "pick":
                tab.click(move["match"])
            elif kind == "another":
                tab.click("/Use another account/")
            elif kind == "identifier":
                found = tab.op({"op": "find", "text": "Email or phone"})
                m = re.search(r"\[(\d+)\]\s+textbox", found if isinstance(found, str) else "")
                if not m:
                    raise Failed("no email field")
                tab.op({"op": "type", "element": int(m.group(1)), "text": account})
                tab.click('button "Next"')
            elif kind == "password":
                # Chrome fills the password it saved for the account: nothing secret passes through here.
                tab.op({"op": "autofill", "match": "/password field/", "pick": account})
                tab.click('button "Next"')
            elif kind in ("try_another", "choose_password", "continue"):
                tab.click(move["match"])
            elif kind == "unverified":
                if not any(re.search(r"Go to .*unsafe", c, re.I) for c in s.get("controls") or []):
                    try:
                        tab.click("Advanced", 4)
                    except Failed:
                        pass
                    time.sleep(0.8)
                tab.click("/Go to .*unsafe/")
            elif kind == "consent":  # approved: The user's Continue.
                if move.get("unchecked"):
                    tab.js(TICK_JS)
                tab.click(move["match"])
        except (Failed, ValueError) as e:
            progress(f"That didn't take ({e}); looking again")
            time.sleep(1.5)
            continue
        tab.leave(s.get("href", ""))
    return {"state": "person", "step": "unknown", "why": "it ran out of time partway through Google's pages", "where": ""}


CONSOLE_JS = r"""(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 };
  const said = (e) => ((e.getAttribute("aria-label") || "") + " | " + (e.innerText || "")).replace(/\s+/g, " ").trim();
  const buttons = [...document.querySelectorAll("button, a, [role=button]")].filter(seen);
  const text = document.body ? document.body.innerText : "";
  return {
    href: location.href, title: document.title,
    enable: buttons.some((e) => /enable this API|^\| Enable$/i.test(said(e))),
    manage: buttons.some((e) => /manage this API|^\| Manage$|Disable API/i.test(said(e))),
    enabled: /API Enabled|Disable API/i.test(text),
    missing: /couldn.t find|not found|doesn.t exist|You don.t have (the required )?permission|need additional access/i.test(text),
    signin: location.hostname === "accounts.google.com",
  };
})()"""
"""Runs on a Cloud console API page: whether the API is enabled, can be, or the page can't tell."""


def console_api(tab, api, project, owner, deadline, dry_run=False, progress=lambda m: None):
    """Enables one API in the Cloud project through its console page, as a person would: {"api", "state": already |
    enabled | would_enable | failed, "why"}."""
    url = f"https://console.cloud.google.com/apis/library/{api}?project={urllib.parse.quote(project)}&authuser={urllib.parse.quote(owner)}"
    tab.op({"op": "navigate", "url": url}, 60)
    clicked = None
    while time.time() < deadline:
        try:
            s = tab.js(CONSOLE_JS)
        except (Failed, ValueError):
            time.sleep(1.5)
            continue
        if s.get("signin"):
            return {"api": api, "state": "failed", "why": f"the Mac's Chrome isn't signed in to the Cloud console as {owner}"}
        if s.get("manage") or s.get("enabled") or f"/apis/api/{api}" in s.get("href", ""):
            return {"api": api, "state": "enabled" if clicked else "already", "why": "enabled now" if clicked else "it was enabled already"}
        if s.get("missing") and not s.get("enable"):
            return {"api": api, "state": "failed", "why": f"the console has no API {api} for project {project} as {owner} ({s.get('title')})"}
        if s.get("enable") and not clicked:
            if dry_run:
                return {"api": api, "state": "would_enable", "why": "it isn't enabled; its Enable button is there"}
            progress(f"Enabling {api}")
            try:
                tab.click("/enable this API/", 8)
            except Failed:
                tab.js("""(() => { const b = [...document.querySelectorAll("button")].find((e) => /enable this API/i.test(e.getAttribute("aria-label") || "")); if (b) b.click(); return !!b })()""")
            clicked = time.time()
        time.sleep(2)
    return {"api": api, "state": "failed", "why": "the console page didn't say it was enabled in time" if clicked else "the console page never showed the API's Enable or Manage button"}
