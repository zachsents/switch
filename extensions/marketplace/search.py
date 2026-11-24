"""The marketplace extension's search: searches Facebook Marketplace for many queries at once, anywhere, at any
radius, through the user's Chrome signed in to Facebook (the browser extension's tab), and keeps saved searches
that say what's new.

It reads Marketplace the way its own page does: the search page's GraphQL query (its persisted
id and variables, read off a real Marketplace page every few days) sent from a bare facebook.com
tab, so no chat popup opens, nothing is clicked and nothing goes out. A search is one call: each
query paged through, the listings merged and deduped (the same listing, and the same item a
seller relisted), filtered, given an approximate distance from a table of US places, and sorted.
details reads the first few listings' own pages too (description, condition, seller rating).
listing reads one listing's page and its photo viewer's query, and brings its photos back as
files: each downloaded from Facebook's CDN here (its links are signed, so no sign-in is needed),
kept a few days in its home, and the first few shown to the asker inline.
"""

import concurrent.futures
import functools
import gzip
import shutil
import subprocess
import json
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime

import sbmcp
from browser import Browser, BrowserError
from server import app, session_live

NAME = "marketplace-search"
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = sbmcp.home()
"""Where it keeps what lasts between runs."""
STATE = os.path.join(HOME, "state.json")
TAB = Browser(app, session="marketplace-search")
"""Its own tab in the user's Chrome, through the browser extension."""
HEARTBEAT_S = 600
"""How often it says how it is, in vitals/marketplace."""
TICK_S = 300
"""How often it looks for saved searches that are due."""
TEMPLATE_DAYS = 3
"""How long the queries read off Marketplace's page are trusted before they're read again."""
FB = "https://www.facebook.com"
BARE = FB + "/robots.txt"
"""A facebook.com page with nothing on it: Facebook's own requests work from it, and no chat opens."""
SLICE = 16000
GEOCODE_PAUSE_S = 1.0
"""Between OpenStreetMap lookups, as its usage policy asks."""
KM_PER_MILE = 1.609344
PAGE_JS = open(os.path.join(HERE, "page_search.js"), encoding="utf-8").read()
PHOTOS = os.path.join(HOME, "photos")
"""Where a listing's photos land, a folder per listing, kept PHOTO_KEEP_DAYS."""
PHOTO_KEEP_DAYS = 3
PHOTO_MAX = 40
"""Most photos a listing's call downloads (Marketplace allows 20 a listing, a shop's more)."""
SHOW = 8
"""How many photos a listing's call shows the asker inline, unless it says."""
PHOTO_MAX_BYTES = 15 * 1024 * 1024
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")
DAY_MS = 86400000

CONDITIONS = {"new": "new", "like new": "used_like_new", "used like new": "used_like_new", "good": "used_good",
              "used good": "used_good", "used": "used_good", "fair": "used_fair", "used fair": "used_fair"}
SORTS = ("relevance", "newest", "price", "price_desc", "miles")
"""How a search's listings are ordered, here: Facebook is always asked in its own order (relevance),
since its other orders loosen the match until a table saw search brings ladders."""


lock = threading.RLock()  # the state file
browsing = threading.RLock()  # one conversation with the tab at a time
health = {"started_at": int(time.time() * 1000), "calls": 0, "failed": 0, "last_error": None, "last_search": None,
          "searches": 0, "signed_in": None, "photos": 0, "photo_failures": 0, "last_photo_error": None}


class Unavailable(Exception):
    """The user's Chrome, or Facebook in it, can't do it now."""


def now_ms():
    return int(time.time() * 1000)


# The world outside: the tab in the user's Chrome, and OpenStreetMap for places the table lacks.


def browser(args, timeout=60):
    """One browser op on this extension's own tab."""
    try:
        return TAB.op(args, timeout)
    except BrowserError as e:
        raise Unavailable(f"The browser: {str(e)[:300]}") from None


def geocode_remote(q=None, city=None, state=None):
    """A place's [lat, lon, name] from OpenStreetMap's Nominatim, or None: free words (q), or a
    town by its city and state (a settlement, so Powell Butte is the town and not Portland's park)."""
    ask = {"q": q} if q else {"city": city, "state": state, "featureType": "settlement"}
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {**ask, "format": "json", "limit": 1, "countrycodes": "us"})
    req = urllib.request.Request(url, headers={"User-Agent": "switchboard-marketplace-search/1"})
    with urllib.request.urlopen(req, timeout=15) as r:
        got = json.load(r)
    if not got:
        return None
    return [round(float(got[0]["lat"]), 5), round(float(got[0]["lon"]), 5), got[0].get("display_name", q)[:80]]


def fetch_photo(url, timeout=20):
    """One photo's bytes from Facebook's CDN: its links are signed, so no cookie is needed."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(PHOTO_MAX_BYTES + 1)
    if len(data) > PHOTO_MAX_BYTES:
        raise ValueError(f"it's over {PHOTO_MAX_BYTES // 1048576} MB")
    return data


# The tab


_tab = {"at": 0.0}


def navigate(url, timeout=60):
    browser({"op": "navigate", "url": url}, timeout)
    _tab["at"] = time.time()


def page(op, timeout=90):
    """Runs one of page.js's ops in the tab and returns what it made, read back in slices."""
    code = PAGE_JS.replace("__MPS_ARGS__", json.dumps(op))
    n = browser({"op": "js", "code": code, "timeout": timeout}, timeout)
    try:
        size = int(str(n).strip())
    except ValueError:
        raise Unavailable(f"The facebook.com tab answered {str(n)[:200]!r}")
    # Each slice comes back as a JSON string, so no slice is ever taken for a number or an object.
    out = "".join(str(browser({"op": "js", "code": f"JSON.stringify(window.__mpsOut.slice({i},{i + SLICE}))"}, 30))
                  for i in range(0, size, SLICE))
    if len(out) < size:
        raise Unavailable(f"Read {len(out)} of {size} characters back from the tab")
    return json.loads(out.replace("~", ""))


def on_facebook(op, timeout=90):
    """page(op) on a bare facebook.com page, loading it first when the tab may have gone or wandered."""
    if time.time() - _tab["at"] > 900:
        navigate(BARE)
    got = page(op, timeout)
    if got.get("signed_in") is False and not str(got.get("url", "")).startswith(FB):
        navigate(BARE)
        got = page(op, timeout)
    health["signed_in"] = got.get("signed_in")
    if got.get("signed_in") is True:
        session_live("facebook")
    if got.get("signed_in") is False:
        raise Unavailable("Facebook isn't signed in in Chrome")
    return got


# State


def blank():
    return {"templates": None, "places": {}, "cities": {}, "watches": {}}


def load():
    try:
        with open(STATE, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        return blank()
    for k, v in blank().items():
        s.setdefault(k, v)
    return s


def save(s):
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, separators=(",", ":"))
    os.replace(tmp, STATE)


def update(fn):
    with lock:
        s = load()
        out = fn(s)
        save(s)
        return out


# Marketplace's own queries


def templates(force=False, progress=None):
    """The search and listing queries as Marketplace's page sends them, and the account's own
    location: read off a real search page and a listing's page, kept for TEMPLATE_DAYS."""
    with lock:
        t = load()["templates"]
    if t and not force and now_ms() - t["at"] < TEMPLATE_DAYS * 86400000 and t.get("search"):
        return t
    if progress:
        progress("Reading Marketplace's search query off its page")
    with browsing:
        navigate(FB + "/marketplace/category/search/?query=" + urllib.parse.quote("desk"))
        a = page({"op": "templates"})
        if a.get("signed_in") is False:
            navigate(BARE)
            raise Unavailable("Facebook isn't signed in in Chrome")
        if not a.get("search"):
            navigate(BARE)
            raise Unavailable("Marketplace's search page didn't carry its search query (it may have changed): " + ", ".join(a.get("names") or [])[:300])
        pdp = media = None
        if a.get("sample"):
            navigate(f"{FB}/marketplace/item/{a['sample']}/")
            b = page({"op": "templates"})
            pdp, media = b.get("pdp"), b.get("media")
        navigate(BARE)
    t = {"search": a["search"], "pdp": pdp or (t or {}).get("pdp"), "media": media or (t or {}).get("media"),
         "place": a.get("place"), "at": now_ms(), "user": a.get("user")}
    update(lambda s: s.__setitem__("templates", t))
    return t


# Places


_places = None


def places():
    global _places
    if _places is None:
        with gzip.open(os.path.join(HERE, "us-places.json.gz"), "rt", encoding="utf-8") as f:
            _places = json.load(f)
    return _places


STATES = {"alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar", "california": "ca", "colorado": "co",
          "connecticut": "ct", "delaware": "de", "florida": "fl", "georgia": "ga", "hawaii": "hi", "idaho": "id",
          "illinois": "il", "indiana": "in", "iowa": "ia", "kansas": "ks", "kentucky": "ky", "louisiana": "la",
          "maine": "me", "maryland": "md", "massachusetts": "ma", "michigan": "mi", "minnesota": "mn",
          "mississippi": "ms", "missouri": "mo", "montana": "mt", "nebraska": "ne", "nevada": "nv",
          "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc",
          "north dakota": "nd", "ohio": "oh", "oklahoma": "ok", "oregon": "or", "pennsylvania": "pa",
          "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", "tennessee": "tn", "texas": "tx",
          "utah": "ut", "vermont": "vt", "virginia": "va", "washington": "wa", "west virginia": "wv",
          "wisconsin": "wi", "wyoming": "wy", "district of columbia": "dc"}


def norm_city(city):
    c = (city or "").strip().lower()
    c = re.sub(r"^(saint|st\.?)\s+", "saint ", c)
    c = re.sub(r"^(fort|ft\.?)\s+", "fort ", c)
    c = re.sub(r"^(mount|mt\.?)\s+", "mount ", c)
    return c


_looked_up = {}
"""Places Facebook names that the table lacks, as OpenStreetMap placed them (None: not found)."""


def place_of(city, state):
    """A listing's city and state as [lat, lon]: from the table, else from what OpenStreetMap said
    when locate() asked it."""
    if not city or not state:
        return None
    st = state.strip().lower()
    st = STATES.get(st, st)
    t = places()
    for c in {norm_city(city), (city or "").strip().lower(), norm_city(city).replace("saint ", "st. "),
              norm_city(city).replace("saint ", "st "), norm_city(city).replace("mount ", "mt ")}:
        hit = t.get(f"{c}|{st}")
        if hit:
            return hit
    got = _looked_up.get(f"{norm_city(city)}|{st}")
    return got[:2] if got else None


def locate(items, budget=6):
    """Asks OpenStreetMap where the cities the table lacks are (a few a search, a second apart as
    its policy asks), and keeps what it says."""
    if not _looked_up:
        with lock:
            _looked_up.update(load().get("cities") or {})
    missing = []
    for it in items:
        c, st = it.get("city"), it.get("state")
        if c and st and place_of(c, st) is None:
            k = f"{norm_city(c)}|{STATES.get(st.strip().lower(), st.strip().lower())}"
            if k not in _looked_up and k not in missing:
                missing.append(k)
    found = {}
    for k in missing[:budget]:
        city, st = k.split("|")
        try:
            got = geocode_remote(city=city, state=st.upper())
        except Exception as e:
            app.log("geocode", k, e)
            continue
        found[k] = got
        _looked_up[k] = got
        time.sleep(GEOCODE_PAUSE_S)
    if found:
        def put(s):
            s.setdefault("cities", {}).update(found)
        update(put)


def where(near):
    """Where a search is centered: "lat,lon", "City, ST", or a place OpenStreetMap knows; left
    out, the location the user's Marketplace is set to. Answers {lat, lon, name, radius_km?}."""
    if not near or not str(near).strip():
        t = templates()
        p = t.get("place") or {}
        if p.get("lat") is None:
            raise ValueError("No place given, and Marketplace's own location couldn't be read")
        return {"lat": p["lat"], "lon": p["lon"], "name": "the Marketplace location", "radius_km": p.get("radius_km")}
    q = str(near).strip()
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$", q)
    if m:
        return {"lat": float(m.group(1)), "lon": float(m.group(2)), "name": q}
    parts = [x.strip() for x in q.split(",")]
    if len(parts) >= 2:
        hit = place_of(parts[0], parts[1].split()[0] if parts[1] else "")
        if hit:
            return {"lat": hit[0], "lon": hit[1], "name": q}
    key = q.lower()
    with lock:
        cached = load()["places"].get(key)
    if cached:
        return {"lat": cached[0], "lon": cached[1], "name": cached[2] if len(cached) > 2 else q}
    got = geocode_remote(q)
    if not got:
        raise ValueError(f"Couldn't find {q!r}: give it as \"City, ST\" or \"lat,lon\"")
    update(lambda s: s["places"].__setitem__(key, got))
    return {"lat": got[0], "lon": got[1], "name": got[2]}


def miles_between(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * math.asin(min(1.0, math.sqrt(h)))


# Searching


def age_words(created, at=None):
    if not created:
        return None
    s = max(0, (at or time.time()) - created)
    if s < 3600:
        return f"{max(1, int(s // 60))} min"
    if s < 86400:
        return f"{int(s // 3600)} h"
    d = int(s // 86400)
    if d < 14:
        return f"{d} day" + ("s" if d != 1 else "")
    if d < 60:
        return f"{d // 7} weeks"
    return f"{d // 30} months"


def day_of(created):
    if not created:
        return None
    return datetime.fromtimestamp(created).strftime("%Y-%m-%d")


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def regex(pattern, what):
    if not pattern:
        return None
    try:
        return re.compile(pattern, re.I)
    except re.error as e:
        raise ValueError(f"{what} isn't a regex Python reads: {e}")


def as_list(x):
    if x is None:
        return []
    if isinstance(x, str):
        return [p.strip() for p in re.split(r"[,\n]", x) if p.strip()]
    return [str(p).strip() for p in x if str(p).strip()]


def build(queries, near=None, radius_miles=None, min_price=None, max_price=None, condition=None, days=None,
          shipping=False, include=None, exclude=None, pending=False, beyond=False, sort="relevance", pages=3):
    """A search's definition, checked: what a watch keeps and search runs."""
    qs = []
    for q in as_list(queries):
        if q.lower() not in [x.lower() for x in qs]:
            qs.append(q)
    if not qs:
        raise ValueError("Give at least one query")
    if len(qs) > 40:
        raise ValueError("At most 40 queries at once")
    conds = []
    for c in as_list(condition):
        key = CONDITIONS.get(c.lower().replace("_", " ").replace("-", " "), c.lower() if c.lower() in CONDITIONS.values() else None)
        if not key:
            raise ValueError(f"condition {c!r}: use new, like new, good or fair")
        if key not in conds:
            conds.append(key)
    sort = sort or "relevance"
    if sort not in SORTS:
        raise ValueError(f"sort is one of {', '.join(SORTS)}")
    regex(include, "include")
    regex(exclude, "exclude")
    return {"queries": qs, "near": near or None, "radius_miles": float(radius_miles) if radius_miles else None,
            "min_price": min_price, "max_price": max_price, "condition": conds, "days": int(days) if days else None,
            "shipping": bool(shipping), "include": include or None, "exclude": exclude or None, "pending": bool(pending),
            "beyond": bool(beyond), "sort": sort or "relevance", "pages": max(1, min(int(pages or 3), 8))}


def fb_filters(d, center):
    radius_km = (d["radius_miles"] * KM_PER_MILE) if d["radius_miles"] else (center.get("radius_km") or 64)
    f = {"lat": center["lat"], "lon": center["lon"], "radius_km": round(radius_km), "shipping": d["shipping"]}
    if d["min_price"]:
        f["min_cents"] = int(round(float(d["min_price"]) * 100))
    if d["max_price"]:
        f["max_cents"] = int(round(float(d["max_price"]) * 100))
    if d["condition"]:
        f["condition"] = ",".join(d["condition"])
    if d["days"]:
        today = int(time.time() // 86400)
        f["ctime_days"] = ";".join(str(today - i) for i in range(0, min(d["days"], 60) + 1))
    return f


def search_now(d, details=0, photos=False, progress=None):
    """Runs a search definition: every query paged through, merged, deduped, filtered and sorted.
    Answers the listings that fit and what was left out."""
    center = where(d["near"])
    radius_mi = d["radius_miles"] or round((center.get("radius_km") or 64) / KM_PER_MILE)
    f = fb_filters(d, center)
    t = templates(progress=progress)
    per_query, raw = [], []
    refreshed = False
    with browsing:
        chunks = [d["queries"][i:i + 5] for i in range(0, len(d["queries"]), 5)]
        for n, chunk in enumerate(chunks):
            if progress:
                progress(f"Searching {', '.join(chunk)}" + (f" ({n + 1} of {len(chunks)})" if len(chunks) > 1 else ""),
                         n, len(chunks))
            op = {"op": "search", "search": t["search"], "queries": chunk, "filters": f, "pages": d["pages"],
                  "pause_ms": 350, "photos": bool(photos)}
            got = on_facebook(op, timeout=40 + 4 * d["pages"] * len(chunk))
            results = got.get("results") or []
            if not refreshed and results and all(r["errors"] and not r["items"] for r in results):
                # Every query failed: the persisted query may have changed. Read it again, once.
                refreshed = True
                t = templates(force=True, progress=progress)
                op["search"] = t["search"]
                got = on_facebook(op, timeout=40 + 4 * d["pages"] * len(chunk))
                results = got.get("results") or []
            for r in results:
                per_query.append({"query": r["query"], "pages": r["pages"], "listings": len(r["items"]),
                                  "more": r["has_next"], **({"errors": r["errors"]} if r["errors"] else {})})
                for item in r["items"]:
                    item["query"] = r["query"]
                    raw.append(item)
    out = merge(raw, d, center, radius_mi)
    if details and out["listings"]:
        with browsing:
            read_details(out["listings"][:max(0, min(int(details), 40))], center, progress)
    health["searches"] += 1
    health["last_search"] = now_ms()
    out["searched"] = {"queries": d["queries"], "near": center["name"], "lat": round(center["lat"], 4),
                       "lon": round(center["lon"], 4), "radius_miles": radius_mi}
    out["per_query"] = per_query
    return out


def merge(raw, d, center, radius_mi):
    """The raw results of every query as one list: deduped, filtered and sorted."""
    inc, exc = regex(d["include"], "include"), regex(d["exclude"], "exclude")
    locate(raw)
    by_id = {}
    for it in raw:
        cur = by_id.get(it["id"])
        if cur is None:
            it["queries"] = [it.pop("query")]
            by_id[it["id"]] = it
        else:
            if it["query"] not in cur["queries"]:
                cur["queries"].append(it["query"])
            cur["rank"] = min(cur["rank"], it["rank"])
    dropped = {"duplicates": len(raw) - len(by_id), "relisted": 0, "beyond_radius": 0, "words": 0, "price": 0,
               "too_old": 0, "pending_or_sold": 0}
    cutoff = time.time() - d["days"] * 86400 if d["days"] else None
    keep = []
    for it in by_id.values():
        p = place_of(it.get("city"), it.get("state"))
        it["miles"] = round(miles_between((center["lat"], center["lon"]), p)) if p else None
        if it.get("sold") or it.get("hidden") or not it.get("live", True) or (it.get("pending") and not d["pending"]):
            dropped["pending_or_sold"] += 1
            continue
        if not d["beyond"] and it["miles"] is not None and it["miles"] > radius_mi * 1.25 + 5 \
                and "SHIPPING" not in " ".join(it.get("delivery") or []):
            dropped["beyond_radius"] += 1
            continue
        if (inc and not inc.search(it["title"])) or (exc and exc.search(it["title"])):
            dropped["words"] += 1
            continue
        price = it.get("price")
        if price is not None and ((d["min_price"] and price < float(d["min_price"])) or
                                  (d["max_price"] and price > float(d["max_price"]))):
            dropped["price"] += 1
            continue
        if cutoff and it.get("created") and it["created"] < cutoff:
            dropped["too_old"] += 1
            continue
        keep.append(it)
    # The same item a seller listed more than once: keep the newest.
    seen = {}
    for it in sorted(keep, key=lambda x: -(x.get("created") or 0)):
        k = (it.get("seller_id") or it["id"], norm_title(it["title"]))
        if k in seen and it.get("seller_id"):
            seen[k].setdefault("also", []).append(it["id"])
            dropped["relisted"] += 1
            continue
        seen[k] = it
    keep = list(seen.values())
    key = {
        "relevance": lambda x: (x["rank"], -len(x["queries"]), -(x.get("created") or 0)),
        "newest": lambda x: -(x.get("created") or 0),
        "price": lambda x: (x.get("price") is None, x.get("price") or 0),
        "price_desc": lambda x: -(x.get("price") or 0),
        "miles": lambda x: (x["miles"] is None, x["miles"] or 0),
    }[d["sort"]]
    keep.sort(key=key)
    return {"found": len(raw), "unique": len(by_id), "fit": len(keep), "left_out": {k: v for k, v in dropped.items() if v},
            "listings": [row(x) for x in keep]}


def delivery_words(types):
    t = set(types or [])
    pick = bool(t & {"IN_PERSON", "DOOR_PICKUP", "PUBLIC_MEETUP"}) or not t
    ships = "SHIPPING" in t
    return "pickup or ships" if pick and ships else ("ships" if ships else "pickup")


def row(x):
    r = {
        "id": x["id"], "title": x["title"], "price": x.get("price"), "price_text": x.get("price_text"),
        "was": x.get("was"), "place": ", ".join(p for p in (x.get("city"), x.get("state")) if p) or None,
        "miles": x.get("miles"), "listed": day_of(x.get("created")), "age": age_words(x.get("created")),
        "created": x.get("created"), "delivery": delivery_words(x.get("delivery")),
        "url": f"{FB}/marketplace/item/{x['id']}/", "queries": x.get("queries") or [],
        "seller": x.get("seller"), "seller_id": x.get("seller_id"),
    }
    if x.get("pending"):
        r["pending"] = True
    if x.get("also"):
        r["also"] = x["also"]
    if x.get("photo"):
        r["photo"] = x["photo"]
    return {k: v for k, v in r.items() if v is not None}


def read_details(rows, center, progress=None):
    """Adds each listing's own page to its row: description, condition, seller rating, exact miles."""
    t = templates(progress=progress)
    if not t.get("pdp"):
        t = templates(force=True, progress=progress)
        if not t.get("pdp"):
            raise Unavailable("Couldn't read Marketplace's listing query off a listing's page")
    if progress:
        progress(f"Reading {len(rows)} listings' own pages")
    got = on_facebook({"op": "details", "pdp": t["pdp"], "ids": [r["id"] for r in rows], "concurrency": 3},
                      timeout=30 + 2 * len(rows))
    items, errors = got.get("items") or {}, got.get("errors") or {}
    for r in rows:
        dd = items.get(r["id"])
        if not dd:
            if r["id"] in errors:
                r["details_error"] = errors[r["id"]]
            continue
        add_details(r, dd, center)
    return rows


def add_details(r, dd, center):
    desc = (dd.get("description") or "").strip()
    r["description"] = desc[:700] + ("…" if len(desc) > 700 else "")
    for k in ("condition", "inventory"):
        if dd.get(k) is not None:
            r[k] = dd[k]
    s = dd.get("seller") or {}
    if s.get("rating") is not None:
        r["seller_rating"] = round(s["rating"], 2)
        r["seller_ratings"] = s.get("ratings")
    if s.get("join_time"):
        r["seller_since"] = datetime.fromtimestamp(s["join_time"]).strftime("%Y")
    if dd.get("lat") is not None and center:
        r["miles"] = round(miles_between((center["lat"], center["lon"]), (dd["lat"], dd["lon"])), 1)
    if dd.get("place"):
        r["place"] = dd["place"]
    if dd.get("shipping_offered"):
        r["shipping_price"] = dd.get("shipping_price")
    if dd.get("messaged"):
        r["messaged"] = True
    if dd.get("attributes"):
        r["attributes"] = {a["name"]: a.get("label") or a.get("value") for a in dd["attributes"] if a.get("name")}
    if dd.get("pending"):
        r["pending"] = True
    if dd.get("sold"):
        r["sold"] = True
    return r


def listing_id(x):
    m = re.search(r"(?:item/|^)(\d{8,20})", str(x).strip())
    if not m:
        raise ValueError(f"{x!r} isn't a Marketplace listing's id or link")
    return m.group(1)


def describe(d):
    bits = [" / ".join(d["queries"][:6]) + (f" +{len(d['queries']) - 6}" if len(d["queries"]) > 6 else "")]
    bits.append(f"within {int(d['radius_miles'])} mi of {d['near']}" if d["radius_miles"] and d["near"]
                else (f"near {d['near']}" if d["near"] else (f"within {int(d['radius_miles'])} mi" if d["radius_miles"] else "near the Marketplace location")))
    if d["min_price"] or d["max_price"]:
        bits.append(f"${d['min_price'] or 0:g}–" + (f"${d['max_price']:g}" if d["max_price"] else "any"))
    if d["condition"]:
        bits.append("/".join(c.replace("used_", "").replace("_", " ") for c in d["condition"]))
    if d["days"]:
        bits.append(f"listed in the last {d['days']} days")
    if d["include"]:
        bits.append(f"title matches /{d['include']}/")
    if d["exclude"]:
        bits.append(f"not /{d['exclude']}/")
    return ", ".join(bits)


# Tools


def counted(fn):
    """Counts a tool's calls and failures for status and the heartbeat."""
    @functools.wraps(fn)
    def run(*a, **k):
        health["calls"] += 1
        try:
            return fn(*a, **k)
        except Exception as e:
            health["failed"] += 1
            health["last_error"] = f"{type(e).__name__}: {e}"[:400]
            raise
    return run


SEARCH_PROPS = {
    "queries": {"type": "array", "items": {"type": "string"}, "description": "What to search for, each searched on its own, like [\"resin printer\", \"elegoo saturn\", \"anycubic photon\"] (at most 40)."},
    "near": {"type": "string", "description": "Where: \"City, ST\" (\"Bend, OR\"), \"lat,lon\", or any place OpenStreetMap knows. Default: where the user's Marketplace is set."},
    "radius_miles": {"type": "number", "description": "How far from it (default: Marketplace's own, 40 mi)."},
    "min_price": {"type": "number", "description": "Dollars."},
    "max_price": {"type": "number", "description": "Dollars."},
    "condition": {"type": "array", "items": {"type": "string"}, "description": "Only these: new, like new, good, fair."},
    "days": {"type": "integer", "description": "Only listed in the last this many days."},
    "shipping": {"type": "boolean", "description": "Also listings that ship from farther away (default: local pickup only)."},
    "include": {"type": "string", "description": "A regex the title must match, case-insensitive, like \"saturn|photon|mars|formlabs\" (Marketplace's search is loose)."},
    "exclude": {"type": "string", "description": "A regex that rules a title out, like \"resin (art|epoxy)|parts only|broken\"."},
    "pending": {"type": "boolean", "description": "Keep listings marked pending (default: left out)."},
    "beyond": {"type": "boolean", "description": "Keep what Facebook adds from beyond the radius (default: left out)."},
    "sort": {"type": "string", "enum": list(SORTS), "description": "relevance (Facebook's order, best rank across queries; default), newest, price, price_desc, miles."},
    "pages": {"type": "integer", "description": "Pages of about 20 listings per query (default 3, at most 8)."},
}


@app.tool(read_only=True, schema={
    "type": "object",
    "properties": {
        **SEARCH_PROPS,
        "details": {"type": "integer", "description": "Also read the first this many listings' own pages: description, condition, seller rating, exact miles (default 0, at most 40; about 0.4 s each)."},
        "photos": {"type": "boolean", "description": "Each listing's photo link too."},
        "limit": {"type": "integer", "description": "Most listings to answer (default 60)."},
    },
    "required": ["queries"],
})
@counted
def search(queries, near=None, radius_miles=None, min_price=None, max_price=None, condition=None, days=None,
           shipping=False, include=None, exclude=None, pending=False, beyond=False, sort="relevance", pages=3,
           details=0, photos=False, limit=60, ctx=None):
    """Facebook Marketplace listings for several queries at once, anywhere, at any radius, read
    through the user's Chrome: merged and deduped (the same listing, and the same item a seller
    relisted), filtered, each with price (and was-price), place, approximate miles, when it was
    listed and its age, pickup or shipping, which queries found it and its link; with details,
    the top ones' description, condition and seller rating. Saves nothing; watch keeps a search."""
    d = build(queries, near, radius_miles, min_price, max_price, condition, days, shipping, include, exclude,
              pending, beyond, sort, pages)
    out = search_now(d, details=details, photos=photos, progress=ctx.progress if ctx else None)
    out["describes"] = describe(d)
    n = max(1, int(limit or 60))
    if len(out["listings"]) > n:
        out["more"] = len(out["listings"]) - n
        out["listings"] = out["listings"][:n]
    for r in out["listings"]:
        r.pop("seller_id", None)
        r.pop("created", None)
    return out


def image_type(data):
    """A picture's MIME type and extension from its first bytes, or (None, None) when it isn't one."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    return None, None


def prune_photos(keep_days=PHOTO_KEEP_DAYS):
    """Takes away listings' photo folders nobody has fetched again in keep_days."""
    try:
        names = os.listdir(PHOTOS)
    except OSError:
        return 0
    gone = 0
    for name in names:
        path = os.path.join(PHOTOS, name)
        try:
            if os.path.isdir(path) and time.time() - os.path.getmtime(path) > keep_days * 86400:
                shutil.rmtree(path)
                gone += 1
        except OSError:
            pass
    return gone


def get_photos(lid, photos, want, save_to=None, progress=None):
    """Downloads a listing's first `want` photos into its folder in PHOTOS.
    Answers each photo's entry (the ones fetched with their file and size; the rest with their
    link) and the bytes of each one fetched, by its number."""
    folder = os.path.join(PHOTOS, lid)
    dest = os.path.abspath(os.path.expanduser(save_to)) if save_to else None
    if want:
        os.makedirs(folder, exist_ok=True)
        os.utime(folder)  # fetched again: kept PHOTO_KEEP_DAYS from now
        if dest:
            os.makedirs(dest, exist_ok=True)
    if progress and want:
        progress(f"Downloading {min(want, len(photos))} of its {len(photos)} photos")

    def one(n, p):
        e = {"n": n, "width": p.get("width"), "height": p.get("height"), "caption": p.get("caption")}
        if n > want:
            return {**e, "url": p["uri"]}, None
        try:
            data = fetch_photo(p["uri"])
            mime, ext = image_type(data)
            if not mime:
                raise ValueError(f"Facebook's CDN answered {len(data)} bytes that aren't a picture")
            name = f"{lid}-{n:02d}.{ext}"
            path = os.path.join(folder, name)
            with open(path + ".part", "wb") as f:
                f.write(data)
            os.replace(path + ".part", path)
            e.update(name=name, type=mime, bytes=len(data), path=path)
            if dest:
                shutil.copyfile(path, os.path.join(dest, name))
                e["saved"] = os.path.join(dest, name)
            return e, data
        except Exception as x:
            err = f"{type(x).__name__}: {x}"[:300]
            health["photo_failures"] += 1
            health["last_photo_error"] = err
            return {**e, "url": p["uri"], "error": err}, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        done = list(pool.map(lambda a: one(*a), enumerate(photos, 1)))
    fetched = {e["n"]: (e["type"], data) for e, data in done if data is not None}
    health["photos"] += len(fetched)
    return [{k: v for k, v in e.items() if v is not None} for e, _ in done], fetched


LISTING_SCHEMA = {
    "type": "object",
    "properties": {
        "listing": {"type": "string", "description": "Its id, or its link (facebook.com/marketplace/item/<id>/...)."},
        "near": {"type": "string", "description": "Where miles are from: \"City, ST\", \"lat,lon\" or any place OpenStreetMap knows (default: the user's Marketplace location)."},
        "photos": {"type": "integer", "description": f"How many of its photos to download as files (default all of them, up to {PHOTO_MAX}; 0 for none, which answers their links)."},
        "show": {"type": "integer", "description": f"How many of those to show you inline (default {SHOW}; 0 for none). Every one downloaded is a file either way."},
        "save_to": {"type": "string", "description": "Also copy them into this folder on this machine (made when missing), like ~/Desktop/dryer."},
    },
    "required": ["listing"],
}


def listing_media(t, lid, progress=None):
    """The listing's details and photos, as page.js's details op answers them with the photo query,
    reading the queries off Marketplace's pages again once when the photo query is missing or failed."""
    for attempt in (0, 1):
        with browsing:
            got = on_facebook({"op": "details", "pdp": t["pdp"], "media": t.get("media"), "ids": [lid], "concurrency": 1},
                              timeout=45)
        dd = (got.get("items") or {}).get(lid)
        stale = not t.get("media") or (dd and dd.get("media_error"))
        if attempt or not dd or not stale or now_ms() - t.get("at", 0) < 3600000:
            return got, dd
        t = templates(force=True, progress=progress)
    return got, dd


@app.tool(read_only=True, schema=LISTING_SCHEMA)
@counted
def listing(listing, near="", photos=None, show=None, save_to=None, ctx=None):
    """One Marketplace listing in full, read from its own page through the user's Chrome: title,
    price, description, condition and the item's other attributes, place and miles from near (default
    the user's Marketplace location), when it was listed, pickup or shipping (and its price), pending or
    sold, the seller (rating when it's public, since when) and whether the user has messaged them; and its
    photos as files: each downloaded here (path), with its size and Facebook's caption, the first few
    shown to you inline. listing is its id or link."""
    progress = ctx.progress if ctx else None
    lid = listing_id(listing)
    center = where(near or None)
    want = PHOTO_MAX if photos is None or photos is True else max(0, min(int(photos or 0), PHOTO_MAX))
    show = SHOW if show is None else max(0, int(show))
    t = templates(progress=progress)
    if not t.get("pdp"):
        t = templates(force=True, progress=progress)
    got, dd = listing_media(t, lid, progress)
    if not dd:
        raise LookupError((got.get("errors") or {}).get(lid) or f"No listing {lid}")
    r = {"id": lid, "title": dd["title"], "price": dd.get("price"), "price_text": dd.get("price_text"),
         "was": dd.get("was_text"), "listed": day_of(dd.get("created")), "age": age_words(dd.get("created")),
         "delivery": delivery_words(dd.get("delivery")), "url": f"{FB}/marketplace/item/{lid}/",
         "seller": (dd.get("seller") or {}).get("name"), "from": center["name"]}
    add_details(r, dd, center)
    if dd.get("description"):
        r["description"] = dd["description"]
    prune_photos()
    shots = [p for p in (dd.get("photos") or []) if p.get("uri")][:PHOTO_MAX]
    fetched = {}
    if shots:
        r["photos"], fetched = get_photos(lid, shots, want, save_to, progress)
        r["photo_count"] = len(shots)
        if fetched:
            r["folder"] = os.path.join(PHOTOS, lid)
            if save_to:
                r["saved_to"] = os.path.abspath(os.path.expanduser(save_to))
        r["shown"] = min(show, len(fetched))
    else:
        r["photo_count"] = 0
        if dd.get("media_error"):
            r["photos_error"] = dd["media_error"]
    videos = [v for v in (dd.get("videos") or []) if v.get("url") or v.get("thumbnail")]
    if videos or dd.get("videos"):
        r["videos"] = videos or len(dd["videos"])
    r = {k: v for k, v in r.items() if v is not None}
    pictures = [sbmcp.image(fetched[n][1], fetched[n][0]) for n in sorted(fetched)[:show]]
    if not pictures:
        return r
    return sbmcp.content(sbmcp.text(json.dumps(r, ensure_ascii=False)), *pictures, structured=r)


# Saved searches


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:60] or "search"


def emit_listing(w, r, change, prev=None):
    facts = {k: r.get(k) for k in ("id", "title", "price", "was", "place", "miles", "listed", "age", "delivery", "url",
                                   "queries", "seller", "condition", "description", "seller_rating", "pending") if r.get(k) is not None}
    facts.update({"change": change, "watch": w["name"]})
    if prev is not None:
        facts["prev_price"] = prev
    where_ = f" in {r['place']}" if r.get("place") else ""
    miles = f" ({r['miles']:g} mi)" if r.get("miles") is not None else ""
    price = r.get("price_text") or (f"${r['price']:g}" if r.get("price") is not None else "no price")
    if change == "new":
        summary = f"New on {w['title']}: {r['title']}, {price}{where_}{miles}, listed {r.get('age') or '?'} ago"
    else:
        summary = f"Price {'cut' if change == 'price cut' else 'up'} on {w['title']}: {r['title']}, {price} (was ${prev:g}){where_}{miles}"
    app.emit("listing", {"entity": f"marketplace-listing:{r['id']}", "kind": "marketplace-listing", "name": r["title"],
                         "summary": summary, "facts": facts},
             about=[f"marketplace-listing:{r['id']}", f"marketplace-watch:{w['name']}"],
             importance=0.6 if change in ("new", "price cut") else 0.3)
    return summary


def push(text, w):
    """Tells the user of a new listing or price cut: an event, and a push to the phone."""
    app.emit("notice", {"entity": f"marketplace-watch:{w['name']}", "summary": text, "name": w["title"]},
             about=[f"marketplace-watch:{w['name']}"], importance=0.8)
    try:
        p = subprocess.run(["sb", "notify", "--title", "Marketplace", text], capture_output=True, text=True, timeout=30)
        if p.returncode != 0:
            health["last_error"] = f"notify failed: {(p.stderr or p.stdout).strip()[:300]}"
            app.log(health["last_error"])
    except Exception as e:
        health["last_error"] = f"notify failed: {e}"
        app.log(health["last_error"])


def scan_watch(name, progress=None):
    """Runs a saved search now: records what's new and price changes since its last scan."""
    with lock:
        w = load()["watches"].get(name)
    if not w:
        raise LookupError(f"No saved search {name!r}")
    out = search_now(w["def"], details=w.get("details") or 0, progress=progress)
    seen = dict(w.get("seen") or {})
    baseline = not w.get("scans")
    changes, lines = [], []
    fits_now = set()
    for r in out["listings"]:
        fits_now.add(r["id"])
        old = seen.get(r["id"])
        entry = {"id": r["id"], "t": r["title"], "p": r.get("price"), "pl": r.get("place"), "mi": r.get("miles"),
                 "c": r.get("created"), "f": (old or {}).get("f") or now_ms(), "fits": True}
        for k in ("n", "cut"):  # when it was found new, and its latest price cut, for the widget
            if (old or {}).get(k):
                entry[k] = old[k]
        if old is None:
            if not baseline:
                entry["n"] = now_ms()
                lines.append(emit_listing(w, r, "new"))
                changes.append({"change": "new", "id": r["id"], "title": r["title"], "price": r.get("price"), "url": r["url"]})
        elif old.get("p") is not None and r.get("price") is not None and r["price"] != old["p"]:
            change = "price cut" if r["price"] < old["p"] else "price up"
            if change == "price cut":
                entry["cut"] = now_ms()
            lines.append(emit_listing(w, r, change, old["p"]))
            changes.append({"change": change, "id": r["id"], "title": r["title"], "price": r.get("price"),
                            "prev_price": old["p"], "url": r["url"]})
        seen[r["id"]] = entry
    for k, v in seen.items():
        if k not in fits_now:
            v["fits"] = False
    # Forget what hasn't fit for two weeks, so the state stays small.
    cutoff = now_ms() - 14 * 86400000
    seen = {k: v for k, v in seen.items() if v.get("fits") or v.get("f", 0) > cutoff}

    def put(s):
        cur = s["watches"].get(name)
        if not cur:
            return None
        cur["seen"] = seen
        cur["scans"] = (cur.get("scans") or 0) + 1
        cur["last_scan"] = now_ms()
        cur["next_scan"] = now_ms() + int(cur["every_hours"] * 3600000)
        cur["last_error"] = None
        return dict(cur)
    w = update(put) or w
    news = [c for c in changes if c["change"] == "new"]
    cuts = [c for c in changes if c["change"] == "price cut"]
    if baseline:
        summary = f"{w['title']}: first scan, {out['fit']} listings fit"
    elif changes:
        ups = len(changes) - len(news) - len(cuts)
        said = [f"{len(news)} new" if news else "", (f"{len(cuts)} price cut" + ("s" if len(cuts) > 1 else "")) if cuts else "",
                (f"{ups} price rise" + ("s" if ups > 1 else "")) if ups else ""]
        summary = f"{w['title']}: " + ", ".join(x for x in said if x) + f" ({out['fit']} fit)"
    else:
        summary = f"{w['title']}: nothing new ({out['fit']} fit)"
    app.emit("scan", {"entity": f"marketplace-watch:{w['name']}", "kind": "marketplace-watch", "name": w["title"], "summary": summary,
                      "facts": {"definition": w["def"], "describes": describe(w["def"]), "baseline": baseline,
                                "changed": bool(changes) and not baseline, "changes": changes[:30], "fit": out["fit"],
                                "found": out["found"], "left_out": out["left_out"], "per_query": out["per_query"],
                                "every_hours": w["every_hours"], "next_scan": w["next_scan"]}},
             about=[f"marketplace-watch:{w['name']}"], importance=0.6 if changes and not baseline else 0.2)
    if w.get("notify") and (news or cuts):
        first = next(i for i, c in enumerate(changes) if c["change"] in ("new", "price cut"))
        more = len(news) + len(cuts) - 1
        push(lines[first] + (f" (and {more} more)" if more else ""), w)
    return {"summary": summary, "baseline": baseline, "changes": changes, "fit": out["fit"],
            "listings": [{k: v for k, v in r.items() if k not in ("seller_id", "created")} for r in out["listings"][:20]],
            "per_query": out["per_query"], "next_scan": w["next_scan"]}


@app.tool(schema={
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "What it's looking for, like \"Resin printer\" (saving a name again replaces that search)."},
        **SEARCH_PROPS,
        "details": {"type": "integer", "description": "Read the first this many listings' own pages each scan (default 0)."},
        "every_hours": {"type": "number", "description": "How often to scan (default 6, at least 1)."},
        "notify": {"type": "boolean", "description": "Notify the user when a scan finds a new listing or a price cut (default false: it's only recorded)."},
    },
    "required": ["name", "queries"],
})
@counted
def watch(name, queries, near=None, radius_miles=None, min_price=None, max_price=None, condition=None, days=None,
          shipping=False, include=None, exclude=None, pending=False, beyond=False, sort="newest", pages=2, details=0,
          every_hours=6, notify=False, ctx=None):
    """Save a Marketplace search (or replace one of the same name) and scan it now; that first scan
    marks what's there already. After that it's scanned every every_hours, and each new listing or
    price change that fits is emitted as a listing event (with notify, the user hears of new ones and
    price cuts too), and the watches widget counts them."""
    d = build(queries, near, radius_miles, min_price, max_price, condition, days, shipping, include, exclude,
              pending, beyond, sort or "newest", pages or 2)
    key = slug(name)
    every = max(1.0, float(every_hours or 6))

    def put(s):
        old = s["watches"].get(key) or {}
        same = old.get("def") == d
        s["watches"][key] = {
            "name": key, "title": str(name).strip(), "def": d, "every_hours": every,
            "notify": bool(notify), "details": max(0, min(int(details or 0), 20)),
            "seen": old.get("seen") if same else {}, "scans": old.get("scans", 0) if same else 0,
            "created": old.get("created") or now_ms(),
            "next_scan": now_ms() + int(every * 3600000),
        }
    update(put)
    result = scan_watch(key, progress=ctx.progress if ctx else None)
    result["saved"] = key
    result["describes"] = describe(d)
    return result


@app.tool()
@counted
def scan(name: str, ctx=None):
    "Scan a saved search now, record what's new or changed price since its last scan, and answer it."
    return scan_watch(slug(name), progress=ctx.progress if ctx else None)


@app.tool()
@counted
def unwatch(name: str):
    "Stop a saved search: no more scans."
    key = slug(name)
    w = update(lambda s: s["watches"].pop(key, None))
    if not w:
        raise LookupError(f"No saved search {name!r}")
    app.emit("watch_gone", {"entity": f"marketplace-watch:{key}"}, about=[f"marketplace-watch:{key}"])
    return f"Stopped {w['title']}"


@app.tool(read_only=True)
def watches():
    "The saved searches: what each looks for, how often and when it last and next scans, and how many listings fit."
    with lock:
        ws = load()["watches"]
    return {"watches": [{"name": k, "title": w["title"], "describes": describe(w["def"]), "every_hours": w["every_hours"],
                         "last_scan": w.get("last_scan"), "next_scan": w.get("next_scan"), "scans": w.get("scans", 0),
                         "fit": sum(1 for v in (w.get("seen") or {}).values() if v.get("fits")),
                         "notify": w.get("notify"), "last_error": w.get("last_error")}
                        for k, w in ws.items()]}


def counts(w, since):
    """How many listings that fit now a saved search found new, and saw cut in price, since then."""
    fits = [v for v in (w.get("seen") or {}).values() if v.get("fits")]
    return sum(1 for v in fits if (v.get("n") or 0) >= since), sum(1 for v in fits if (v.get("cut") or 0) >= since)


@app.tool(read_only=True)
def watches_view():
    "The watches widget's data: a row per saved search, with what it found new and its price drops in the last day."
    with lock:
        ws = load()["watches"]
    rows = []
    for w in sorted(ws.values(), key=lambda w: w.get("created") or 0):
        new, cuts = counts(w, now_ms() - DAY_MS)
        values = [x for x in (f"{new} new" if new else "", f"{cuts} cheaper" if cuts else "") if x]
        error = w.get("last_error")
        rows.append({"label": w["title"], "detail": error or describe(w["def"]), "alert": bool(error),
                     "mark": "warn" if error else "", "values": values})
    return {"rows": rows, "empty": "" if rows else "No watches"}


BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"


app.widget("watches", "Marketplace", lambda: sbmcp.surface("watches", [
    {"id": "root", "component": "Column", "catalogId": BASIC_CATALOG, "children": ["list", "empty"]},
    {"id": "list", "component": "List", "catalogId": BASIC_CATALOG, "children": {"componentId": "watch", "path": "/rows"}},
    {"id": "watch", "component": "Row", "label": {"@path": "label"}, "mark": {"@path": "mark"},
     "detail": {"@path": "detail"}, "alert": {"@path": "alert"}, "values": {"@path": "values"}},
    {"id": "empty", "component": "Text", "catalogId": BASIC_CATALOG, "text": {"@path": "/empty"}, "variant": "caption"},
]), tool="watches_view", refresh=["marketplace.scan", "marketplace.watch_gone"])


@app.tool(read_only=True)
def status():
    "How the search half itself is: calls answered and failed, its last error, whether Facebook is signed in, how old its copy of Marketplace's queries is, and its saved searches."
    with lock:
        s = load()
    t = s.get("templates") or {}
    return {**health, "session": TAB.session, "templates_at": t.get("at"), "has_listing_query": bool(t.get("pdp")),
            "has_photo_query": bool(t.get("media")), "marketplace_location": t.get("place"), "watches": len(s["watches"]),
            "photo_folder": PHOTOS}


# Background: saved searches and the heartbeat


def due_watches():
    with lock:
        ws = load()["watches"]
    return [k for k, w in ws.items() if (w.get("next_scan") or 0) <= now_ms()]


def run_due():
    for key in due_watches():
        try:
            scan_watch(key)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"[:400]
            health["last_error"] = err

            def put(s):
                w = s["watches"].get(key)
                if w:
                    w["last_error"] = err
                    w["next_scan"] = now_ms() + 3600000  # try again in an hour
            update(put)
            app.log(f"scan {key} failed: {err}")


def heartbeat():
    """Says how it is, in vitals/marketplace-search: what keeps its --health-every promise."""
    with lock:
        s = load()
    error = health["last_error"]
    facts = {**health, "watches": {k: {"last_scan": w.get("last_scan"), "next_scan": w.get("next_scan"), "last_error": w.get("last_error")}
                                   for k, w in s["watches"].items()},
             "templates_at": (s.get("templates") or {}).get("at")}
    prune_photos()
    summary = f"{len(s['watches'])} saved searches" + (f"; last error: {error}" if error else "; ready")
    app.emit("heartbeat", {"entity": f"sense:{NAME}", "summary": summary, "facts": facts})


@app.background
def beat():
    while True:
        heartbeat()
        time.sleep(HEARTBEAT_S)


@app.background
def scheduler():
    time.sleep(30)
    while True:
        try:
            run_due()
        except Exception as e:
            app.log("scheduler:", e)
        time.sleep(TICK_S)

