"""people-lookup: public-records results for a phone number, a name, an address or an email, from free
people-search sites.

It reads FastPeopleSearch (first: its phone results name the number's listed owner, and its person pages open
without a human check) and TruePeopleSearch (the fallback) in a background tab of the user's browser
(switch-ext-browser). It never solves a human check: a Cloudflare challenge or captcha comes back as status `blocked`
with the reason, and that site rests for half an hour.

Tools: people-search_phone {number}, people-search_name {name, city?, state?}, people-search_address {street, city?, state?, zip?},
people-search_email {email} and people-search_person {url} (a person page from an earlier result). Each answers {status, query,
source, url, best, matches, details, ...}. Every lookup is recorded as person-lookup:<kind>-<key>, and a repeat
within 30 days is answered from its own cache unless refresh is set. A phone lookup also records what it found on
the number's person:<digits> entity. It looks nothing up by itself.

Polite by design: one page at a time, at least 6 s between pages, at most 30 pages an hour.
"""

import json
import os
import random
import re
import threading
import time
import urllib.parse

from server import app, home, op_text
from server import health as register_health

PART = "people"
SESSION = "people"
STREAM = "people/lookups"
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_JS = open(os.path.join(HERE, "people_page.js")).read()

app.event("people_lookup", "A lookup's answer: public records for a phone number, a name, an address or an email",
          stream=STREAM, kind="observation")
app.event("people_person", "What a phone lookup found for that number's person:<digits> entity", stream=STREAM,
          kind="observation")

CACHE_DAYS = 30
MIN_GAP_S = 6.0
PAGES_PER_HOUR = 30
COOLDOWN_S = 30 * 60

FPS = "https://www.fastpeoplesearch.com"
TPS = "https://www.truepeoplesearch.com"

# Canadian area codes: the US people-search sites don't cover them.
CANADA = {
    "204": "Manitoba", "226": "Ontario", "236": "British Columbia", "249": "Ontario", "250": "British Columbia",
    "257": "British Columbia", "263": "Quebec", "289": "Ontario", "306": "Saskatchewan", "343": "Ontario",
    "354": "Quebec", "365": "Ontario", "367": "Quebec", "368": "Alberta", "382": "Ontario", "387": "Ontario",
    "403": "Alberta", "416": "Ontario (Toronto)", "418": "Quebec", "428": "New Brunswick", "431": "Manitoba",
    "437": "Ontario (Toronto)", "438": "Quebec (Montreal)", "450": "Quebec", "468": "Quebec", "474": "Saskatchewan",
    "506": "New Brunswick", "514": "Quebec (Montreal)", "519": "Ontario", "548": "Ontario", "579": "Quebec",
    "581": "Quebec", "584": "Manitoba", "587": "Alberta", "604": "British Columbia (Vancouver)", "613": "Ontario (Ottawa)",
    "639": "Saskatchewan", "647": "Ontario (Toronto)", "672": "British Columbia", "683": "Ontario", "705": "Ontario",
    "709": "Newfoundland and Labrador", "742": "Ontario", "753": "Ontario", "778": "British Columbia", "780": "Alberta",
    "782": "Nova Scotia / PEI", "807": "Ontario", "819": "Quebec", "825": "Alberta", "867": "Northern Canada",
    "873": "Quebec", "879": "Newfoundland and Labrador", "902": "Nova Scotia / PEI", "905": "Ontario",
}
NON_US = {"242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"}

browse_lock = threading.Lock()
cache_lock = threading.Lock()
state = {"pages": [], "last_page": 0.0, "cooldown": {}, "lookups": 0, "blocked": 0}


def now_ms():
    return int(time.time() * 1000)


class Blocked(Exception):
    pass


def browser(args, timeout=75):
    """One op in the user's browser; answers {ok, output, error}."""
    return op_text(SESSION, args, timeout)


def browse(url, settle=1.5):
    """Loads url in the background tab and reads it with people_page.js."""
    with browse_lock:
        t = time.time()
        state["pages"] = [p for p in state["pages"] if t - p < 3600]
        if len(state["pages"]) >= PAGES_PER_HOUR:
            raise RuntimeError(f"rate limit: {PAGES_PER_HOUR} pages in the last hour; try again in {int(3600 - (t - state['pages'][0])) // 60 + 1} min")
        gap = MIN_GAP_S + random.uniform(0, 2) - (t - state["last_page"])
        if gap > 0:
            time.sleep(gap)
        ops = [{"op": "navigate", "url": url}, {"op": "wait", "seconds": settle}, {"op": "js", "code": PAGE_JS}]
        res = browser({"op": "steps", "steps": ops}, timeout=75)
        state["last_page"] = time.time()
        state["pages"].append(state["last_page"])
        text = res.get("output") or res.get("error") or ""
        m = re.findall(r"@@PL@@(\{.*\})", text)
        if not res.get("ok") or not m:
            raise RuntimeError((res.get("error") or text or "the browser failed")[:300])
        return json.loads(m[-1])


def browse_wait(seconds):
    """Re-reads the tab after a wait, without loading anything."""
    with browse_lock:
        res = browser({"op": "steps", "steps": [{"op": "wait", "seconds": seconds}, {"op": "js", "code": PAGE_JS}]}, timeout=45)
        try:
            m = re.findall(r"@@PL@@(\{.*\})", res.get("output") or "")
            return json.loads(m[-1])
        except Exception:
            return {"page": "challenge"}


def blank():
    try:
        browser({"op": "release"}, timeout=20)
    except Exception:
        pass


def cooling(site):
    return time.time() < state["cooldown"].get(site, 0)


def read(site, url):
    """One page from one site; raises Blocked on a human check."""
    if cooling(site):
        raise Blocked(f"{site} showed a human check recently; resting until {time.strftime('%H:%M', time.localtime(state['cooldown'][site]))}")
    page = browse(url)
    if page.get("page") == "challenge" and page.get("site") == site:
        # A managed check often passes by itself in the user's own browser and redirects; give it a few seconds,
        # touching nothing (a check that wants a click is a human's, and stays one).
        page = browse_wait(6)
    if page.get("page") == "challenge":
        state["cooldown"][site] = time.time() + COOLDOWN_S
        state["blocked"] += 1
        raise Blocked(f"{site} asked for a human check (Cloudflare/captcha) at {page.get('url')}")
    return page


# Queries.


def phone_digits(number):
    d = re.sub(r"\D", "", str(number or ""))
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return d


def fmt_phone(d):
    return f"({d[:3]}) {d[3:6]}-{d[6:]}"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def place(city=None, state_=None, zip_=None):
    return ", ".join(x for x in [city, " ".join(y for y in [state_, zip_] if y)] if x)


def pick(results, owner):
    if owner:
        for r in results:
            if r.get("name", "").lower() == owner.lower():
                return r
    return results[0] if results else None


def trim(person):
    if not person:
        return person
    p = dict(person)
    for k, n in (("relatives", 15), ("associates", 10), ("past_addresses", 10), ("phones", 10), ("businesses", 6), ("past_locations", 8), ("aka", 10)):
        if isinstance(p.get(k), list):
            p[k] = p[k][:n]
    return p


def search(kind, key, label, sources, details=None):
    """Tries each (site, url) in order; returns the answer dict."""
    blocked, tried = [], []
    for site, url in sources:
        try:
            page = read(site, url)
        except Blocked as e:
            blocked.append(str(e))
            continue
        tried.append(site)
        results = [r for r in (page.get("results") or []) if r.get("name")]
        if page.get("page") != "results":
            blocked.append(f"{site}: unexpected page ({page.get('title')})")
            continue
        if not results:
            continue
        best = pick(results, page.get("current_owner"))
        ans = {"status": "ok", "source": site, "url": page["url"], "current_owner": page.get("current_owner"),
               "best": trim(best), "matches": [trim(r) for r in results[:8]], "details": None, "details_status": None}
        # A phone's current owner is one person; a name or an address can be many, so only a lone match gets its page.
        if details is None:
            details = kind == "phone" or len(results) == 1
        if details and best and best.get("url"):
            ans.update(person_page(best["url"]))
        return ans
    if blocked and not tried:
        return {"status": "blocked", "reason": "; ".join(blocked), "tried": tried}
    return {"status": "none", "reason": f"no public records found ({', '.join(tried)})" + (f"; also: {'; '.join(blocked)}" if blocked else ""), "tried": tried}


def person_page(url):
    site = "fastpeoplesearch" if "fastpeoplesearch" in url else "truepeoplesearch"
    try:
        page = read(site, url)
    except Blocked as e:
        return {"details_status": f"blocked: {e}"}
    if page.get("page") != "person":
        return {"details_status": f"not read ({page.get('page')})"}
    return {"details": trim(page["person"]), "details_status": "ok", "details_url": page["url"]}


def summarize(kind, label, ans):
    if ans["status"] != "ok":
        return f"{label}: {ans['status']}" + (f" ({ans.get('reason')})" if ans.get("reason") else "")
    def who(p):
        bits = [p.get("full_name") or p.get("name")]
        if p.get("age"):
            bits.append(str(p["age"]))
        if p.get("location"):
            bits.append(p["location"])
        return ", ".join(b for b in bits if b)

    matches = ans.get("matches") or []
    if kind in ("phone", "person") or len(matches) <= 1:
        p = ans.get("details") or ans.get("best") or {}
        lead = ("current owner" if kind == "phone" and ans.get("current_owner")
                else "likely" if len(matches) <= 1 else f"{len(matches)} people listed, first")
        others = [m["name"] for m in matches[1:4]]
        return f"{label}: {lead} {who(p)} ({ans['source']})" + (f"; also listed: {', '.join(others)}" if others else "")
    shown = "; ".join(who(m) for m in matches[:4])
    return f"{label}: {len(matches)} records ({ans['source']}): {shown}" + ("; ..." if len(matches) > 4 else "")


def line_of(ans):
    """The finding in a few words, for a card about the number (no number in front)."""
    site = {"fastpeoplesearch": "FastPeopleSearch", "truepeoplesearch": "TruePeopleSearch"}
    if ans["status"] == "ok":
        line = ans["summary"].split(": ", 1)[-1].split("; also listed")[0]
        for k, v in site.items():
            line = line.replace(f"({k})", f"per {v}")
        return line
    if ans["status"] == "none":
        return "no listing on FastPeopleSearch or TruePeopleSearch"
    if ans.get("region"):
        return f"no US listing; it's a Canadian number ({ans['region'].replace(', Canada', '')})" if ans["region"].endswith("Canada") else f"no US listing ({ans['region']})"
    return f"no US listing ({ans.get('reason')})"


def _cache():
    try:
        with open(home(PART, "cache.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def cached(entity):
    with cache_lock:
        f = _cache().get(entity)
    if not f or f.get("status") not in ("ok", "none", "unsupported"):
        return None
    if now_ms() - (f.get("looked_up_at") or 0) > CACHE_DAYS * 86400_000:
        return None
    return f


def keep(entity, ans):
    with cache_lock:
        c = _cache()
        c[entity] = ans
        for k in [k for k, v in c.items() if now_ms() - (v.get("looked_up_at") or 0) > CACHE_DAYS * 86400_000]:
            c.pop(k, None)
        tmp = home(PART, "cache.json.tmp")
        with open(tmp, "w") as f:
            json.dump(c, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, home(PART, "cache.json"))


def lookup(kind, args):
    refresh = bool(args.get("refresh"))
    details = args.get("details")  # None: the lookup decides (a phone's owner, or a lone match)
    about_extra = []
    if kind == "phone":
        d = phone_digits(args.get("number"))
        raw = str(args.get("number") or "")
        if raw.strip().startswith("+") and not raw.strip().startswith("+1"):
            ans = {"status": "unsupported", "reason": "an international number; these sites cover US numbers only"}
            return finish(kind, re.sub(r"\D", "", raw), raw, ans, [], refresh=True)
        if len(d) != 10:
            raise ValueError(f"not a 10-digit North American number: {raw!r}")
        key, label = d, fmt_phone(d)
        about_extra = [f"person:{d}"]
        npa = d[:3]
        if npa in CANADA:
            ans = {"status": "unsupported", "region": f"{CANADA[npa]}, Canada",
                   "reason": f"a Canadian number ({CANADA[npa]}); US people-search sites have no Canadian records"}
            return finish(kind, key, label, ans, about_extra, refresh=True)
        if npa in NON_US:
            ans = {"status": "unsupported", "reason": "a Caribbean or other non-US NANP number; these sites cover US numbers only"}
            return finish(kind, key, label, ans, about_extra, refresh=True)
        sources = [("fastpeoplesearch", f"{FPS}/{d[:3]}-{d[3:6]}-{d[6:]}"),
                   ("truepeoplesearch", f"{TPS}/resultphone?phoneno=" + urllib.parse.quote(f"({d[:3]}){d[3:6]}-{d[6:]}"))]
    elif kind == "name":
        name = " ".join(str(args.get("name") or "").split())
        if len(name.split()) < 2:
            raise ValueError("give a first and last name")
        city, st = args.get("city"), args.get("state")
        where = place(city, st)
        key, label = slug(f"{name} {where}"), f"{name}" + (f" in {where}" if where else "")
        fps = f"{FPS}/name/{slug(name)}" + (f"_{slug(f'{city or ''} {st or ''}')}" if where else "")
        tps = f"{TPS}/results?name=" + urllib.parse.quote(name) + (f"&citystatezip=" + urllib.parse.quote(where) if where else "")
        sources = [("fastpeoplesearch", fps), ("truepeoplesearch", tps)]
    elif kind == "address":
        street = " ".join(str(args.get("street") or "").split())
        city, st, z = args.get("city"), args.get("state"), args.get("zip")
        where = place(city, st, z)
        if not street or not where:
            raise ValueError("give a street and a city/state or zip")
        key, label = slug(f"{street} {where}"), f"{street}, {where}"
        sources = [("fastpeoplesearch", f"{FPS}/address/{slug(street)}_{slug(' '.join(x for x in [city, st, z] if x))}"),
                   ("truepeoplesearch", f"{TPS}/resultaddress?streetaddress=" + urllib.parse.quote(street) + "&citystatezip=" + urllib.parse.quote(where))]
    elif kind == "email":
        email = str(args.get("email") or "").strip().lower()
        if "@" not in email:
            raise ValueError("give an email address")
        key, label = slug(email), email
        sources = [("truepeoplesearch", f"{TPS}/resultemail?email=" + urllib.parse.quote(email))]
    elif kind == "person":
        url = str(args.get("url") or "")
        if not re.match(r"^https://www\.(fastpeoplesearch|truepeoplesearch)\.com/", url):
            raise ValueError("give a person page URL from an earlier result (fastpeoplesearch.com or truepeoplesearch.com)")
        key, label = slug(urllib.parse.urlparse(url).path)[-60:], url
        sources = None
    else:
        raise ValueError(f"unknown kind {kind}")

    entity = f"person-lookup:{kind}-{key}"
    if not refresh:
        hit = cached(entity)
        if hit:
            hit = dict(hit)
            hit["cached"] = True
            return hit
    try:
        if kind == "person":
            r = person_page(url)
            ans = {"status": "ok" if r.get("details_status") == "ok" else ("blocked" if str(r.get("details_status", "")).startswith("blocked") else "error"),
                   "source": "fastpeoplesearch" if "fastpeoplesearch" in url else "truepeoplesearch", "url": url, **r}
            if ans["status"] != "ok":
                ans["reason"] = r.get("details_status")
        else:
            ans = search(kind, key, label, sources, details=details)
    finally:
        blank()
    return finish(kind, key, label, ans, about_extra)


def finish(kind, key, label, ans, about_extra, refresh=False):
    entity = f"person-lookup:{kind}-{key}"
    ans = dict(ans)
    ans.update({"kind": kind, "query": label, "looked_up_at": now_ms(), "cached": False})
    summary = summarize(kind, label, ans)
    ans["summary"] = summary
    state["lookups"] += 1
    if ans["status"] in ("ok", "none", "unsupported"):
        keep(entity, ans)
        app.emit("people_lookup", {"entity": entity, "kind": "person-lookup", "name": label, "summary": summary, "facts": ans},
                 about=[entity] + about_extra)
        if kind == "phone" and about_extra:
            p = ans.get("details") or ans.get("best") or {}
            facts = {
                "public_records": summary,
                "public_records_line": line_of(ans),
                "public_records_lookup": entity,
                "public_records_at": ans["looked_up_at"],
                "public_records_name": (p.get("full_name") or p.get("name")) if ans["status"] == "ok" else None,
                "public_records_location": p.get("location") if ans["status"] == "ok" else None,
            }
            if ans.get("region"):
                facts["region"] = ans["region"]
            app.emit("people_person", {"entity": about_extra[0], "facts": facts}, about=about_extra + [entity])
    return ans


def act(action, args):
    if action in ("phone", "name", "address", "email", "person"):
        return lookup(action, args)
    raise ValueError(f"unknown action {action}")


TOOLS = [
    {
        "name": "phone",
        "description": "Reverse-lookup a US phone number: its current owner (with their full record) and other people listed for it.",
        "input_schema": {
            "type": "object",
            "required": [
                "number"
            ],
            "properties": {
                "number": {
                    "type": "string",
                    "description": "Any format, with or without +1."
                },
                "details": {
                    "type": "boolean",
                    "description": "Open the owner's person page (default true)."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "Look again even if a lookup from the last 30 days exists."
                }
            }
        }
    },
    {
        "name": "name",
        "description": "Find people by name, optionally narrowed by city and state. Several matches come back as a list (each with a url for people-search_person); a lone match gets its full record.",
        "input_schema": {
            "type": "object",
            "required": [
                "name"
            ],
            "properties": {
                "name": {
                    "type": "string",
                    "description": "First and last name."
                },
                "city": {
                    "type": "string"
                },
                "state": {
                    "type": "string",
                    "description": "Two-letter state."
                },
                "details": {
                    "type": "boolean"
                },
                "refresh": {
                    "type": "boolean"
                }
            }
        }
    },
    {
        "name": "address",
        "description": "Who lives at (or is tied to) a US street address.",
        "input_schema": {
            "type": "object",
            "required": [
                "street"
            ],
            "properties": {
                "street": {
                    "type": "string"
                },
                "city": {
                    "type": "string"
                },
                "state": {
                    "type": "string"
                },
                "zip": {
                    "type": "string"
                },
                "details": {
                    "type": "boolean"
                },
                "refresh": {
                    "type": "boolean"
                }
            }
        }
    },
    {
        "name": "email",
        "description": "Who an email address belongs to (TruePeopleSearch; its email data is the weakest, so check it against other facts).",
        "input_schema": {
            "type": "object",
            "required": [
                "email"
            ],
            "properties": {
                "email": {
                    "type": "string"
                },
                "details": {
                    "type": "boolean"
                },
                "refresh": {
                    "type": "boolean"
                }
            }
        }
    },
    {
        "name": "person",
        "description": "One person's full record from a person page URL an earlier result gave (fastpeoplesearch.com or truepeoplesearch.com).",
        "input_schema": {
            "type": "object",
            "required": [
                "url"
            ],
            "properties": {
                "url": {
                    "type": "string"
                },
                "refresh": {
                    "type": "boolean"
                }
            }
        }
    }
]
def tool(name):
    return lambda **args: act(name, args)


for spec in TOOLS:
    app.tool(tool(spec["name"]), name=spec["name"], description=spec["description"],
             schema=spec["input_schema"], read_only=True, open_world=True)


register_health(PART, lambda: {
    "lookups": state["lookups"], "blocked": state["blocked"],
    "pages_last_hour": len([p for p in state["pages"] if time.time() - p < 3600]),
    "cooldown": {s: int(u) for s, u in state["cooldown"].items() if u > time.time()}})
