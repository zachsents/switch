"""ebay-comps: what a model sells for on eBay, from its sold listings, in one call.

eBay answers a plain fetch of its search with a 403, and its API gives sold prices only to approved partners, so
every page loads in the user's browser (switch-ext-browser, a background tab): navigate like a person, read the result
cards back with ebay_page.js, parse them here. It never solves a human check: one answers status blocked with the
tab left open and a need for the user to pass it. Polite: one page at a time, a few seconds apart, at most 60 an
hour, and a lookup is answered from its cache for 6 hours.

eBay pads a search for a less common model with things like it (a sold search for an X100V answered with every
compact camera sold that day: 3 X100Vs in 240), so when a full page is mostly other models it reads the same search
with each word quoted too, and puts the two together.

- ebay_comps: sold prices by condition (new/sealed, open box, used, refurbished, for parts), with the listings that
  aren't the model (other models and variants, accessories, lots, outliers) left out and counted, each kept sale
  listed, and optionally a chart. Records ebay-comps:<query>.
- ebay_listings: the cheapest live listings that are the model, by condition, delivered price first.
"""

import datetime
import hashlib
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

import sbmcp
from server import app, home, keep_file, need, op_text
from server import health as register_health

PART = "ebay"
HERE = os.path.dirname(os.path.abspath(__file__))
SESSION = "ebay"
MIN_GAP_S = 3.0
PAGES_PER_HOUR = 60
COOLDOWN_S = 30 * 60
CHECK_SETTLE_S = 6
"""How long a human check gets to pass by itself (a managed one sometimes does) before it counts."""
CACHE_S = 6 * 3600
PAGE_JS = open(os.path.join(HERE, "ebay_page.js")).read()
STREAM = "commerce/ebay-comps"

app.event("ebay_comps", "A model's eBay sold prices, as last looked up", stream=STREAM, kind="observation")

state = {
    "started_at": int(time.time() * 1000), "calls": 0, "failed": 0, "last_error": None, "last_lookup": None,
    "pages": [], "last_page": 0.0, "challenges": 0, "cooldown_until": 0.0,
}
browse_lock = threading.Lock()
cache_lock = threading.Lock()


class Blocked(Exception):
    """eBay put up a human check, or a cooldown after one is running."""


def browser(args, timeout=75):
    """One op in the user's browser; answers {ok, output, error}."""
    return op_text(SESSION, args, timeout)


def _answer(res):
    """The @@EC@@ JSON in a browser answer, or raises with what went wrong."""
    text = res.get("output") or ""
    found = re.findall(r"@@EC@@(\{.*\})", text)
    if res.get("ok") and found:
        return json.loads(found[-1])
    error = res.get("error") or text or "the browser answered nothing"
    raise RuntimeError(error[:300])


def _read_rest(first):
    """The page's whole reading: the first piece came with the load, the rest from where each ended."""
    text, piece = first["part"], first
    while piece["end"] < piece["len"]:
        piece = _answer(browser({"op": "js", "code": f"window.__ebayCompsPart({piece['end']})"}, timeout=30))
        text += piece["part"]
    return json.loads(text)


def load(url):
    """Loads one eBay search page in the background tab, politely, and answers what ebay_page.js read."""
    with browse_lock:
        now = time.time()
        if now < state["cooldown_until"]:
            raise Blocked(f"eBay asked for a human check recently; resting until {time.strftime('%H:%M', time.localtime(state['cooldown_until']))}")
        state["pages"] = [p for p in state["pages"] if now - p < 3600]
        if len(state["pages"]) >= PAGES_PER_HOUR:
            raise RuntimeError(f"{PAGES_PER_HOUR} eBay pages in the last hour; try again in {int(3600 - (now - state['pages'][0])) // 60 + 1} min")
        gap = MIN_GAP_S + random.uniform(0, 1.5) - (now - state["last_page"])
        if gap > 0:
            time.sleep(gap)
        steps = [{"op": "navigate", "url": url}, {"op": "js", "code": PAGE_JS, "timeout": 30}]
        res = browser({"op": "steps", "steps": steps})
        state["tab_open"] = True
        state["last_page"] = time.time()
        state["pages"].append(state["last_page"])
        page = _read_rest(_answer(res))
        if page.get("challenge"):
            # A managed check sometimes passes by itself in the user's own browser: look again once, touching nothing.
            time.sleep(CHECK_SETTLE_S)
            page = _read_rest(_answer(browser({"op": "js", "code": PAGE_JS, "timeout": 30})))
        if page.get("challenge"):
            state["challenges"] += 1
            state["cooldown_until"] = time.time() + COOLDOWN_S
            need(PART, "check", "eBay wants a human check: pass it in the browser tab", session=f"ebay-{SESSION}",
                 url=page.get("url"))
            raise Blocked(f"eBay asked for a human check at {page.get('url')}")
        return page


def release():
    """Closes the tab once a call is done with it."""
    try:
        browser({"op": "release"}, timeout=20)
    except Exception:  # a tab left open is harmless; the answer matters more than tidying
        pass


# Reading the cards.

MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
CONDITION = re.compile(r"^(brand new|new|pre-owned|used|open box|parts only|for parts|refurbished|certified|excellent - refurbished|"
                       r"very good - refurbished|good - refurbished|seller refurbished|remanufactured|like new)\b", re.I)
FAULTY = re.compile(r"\b(not working|non[- ]?working|for parts|for repair|parts only|parts or repair|faulty|broken|defective|no power|"
                    r"won'?t (turn|power) on|does ?n[o']t (work|power)|dead|as[- ]is|untested|cracked|water damage)\b", re.I)
SEALED = re.compile(r"\b(sealed|nib|bnib|nisb|unopened|new in box)\b", re.I)
LOT = re.compile(r"\b(lot|lots|bulk|wholesale|bundle of \d+)\b|\b\d+\s?(pcs|pieces|pack|units)\b|\(\s?[2-9]\s?\)|\bx\s?[2-9]\b", re.I)
ACCESSORY = re.compile(r"\b(box only|empty box|manual only|case only|screen protector|decal|skin|sticker|replacement part|"
                       r"(instruction|owner'?s?|user'?s?) (manual|guide|book)|manual book|user guide)s?\b", re.I)
UNITS = "gb|tb|mb|mm|cm|k|mp|in|inch|oz|lbs?|ml|mah|hz|fps"
VARIANTS = {"max", "plus", "pro", "ultra", "mini", "lite", "se", "air", "neo", "note", "fold", "flip", "edge", "prime", "slim",
            "xl", "xs", "s", "x", "ii", "iii", "iv", "mk2", "mk3", "mk4", "mkii", "mkiii", "mkiv", "mark", "program", "gen",
            "2", "3", "4", "5", "6", "7", "8", "9"}
"""Words that, right after the model's own words, make it another model: Pro Max for Pro, Saturn 3 Ultra for Saturn 3."""
PARTS = {"lpu", "assembly", "motherboard", "mainboard", "logic", "board", "screen", "lcd", "display", "tank", "vat", "fep",
         "plate", "platform", "cartridge", "motor", "fan", "cable", "charger", "case", "cover", "housing", "frame", "flex", "module",
         "tray", "lid", "door", "glass", "sensor", "connector", "nozzle", "hotend", "extruder", "belt", "knob",
         "remote", "strap", "box", "eyepiece", "viewfinder", "winder", "grip", "hood", "cap", "mount", "adapter", "stand"}
"""What, named right after the model, is a piece of it for sale rather than the model. Not "parts":
"iPhone 13 Pro Parts Bad Battery" is the phone, sold for parts, which its condition says."""
SOLD_ALONE = {"plate", "platform", "tank", "vat", "fep", "cartridge", "cable", "charger", "case", "cover", "tray", "strap",
              "remote", "hood", "cap", "adapter", "stand", "grip", "winder", "assembly", "lpu"}
"""Parts that, named right after the thing itself, are what's for sale: "Printer Build Plate", "Camera Strap"."""
OF_A_PART = {"build", "resin", "body", "lens", "replacement", "spare", "oem", "original", "genuine", "official"}
"""Words between the thing and a part that keep it a part: "Printer Build Plate", "Camera Body Cap"."""
DESCRIPTORS = {"resin", "oem", "original", "genuine", "official", "replacement", "spare", "new", "used", "black", "white", "grey", "gray", "silver"}
WHOLE = {"printer", "camera", "phone", "smartphone", "console", "laptop", "notebook", "tablet", "computer", "drone", "scanner",
         "machine"}
"""Nouns that name the thing itself, so the words before them describe it ("LCD 3D Printer")."""
JOINERS = {"for", "fits", "fit", "compatible", "with", "w", "and", "includes", "including", "bundle", "or"}
BUCKETS = ["new", "open_box", "used", "refurbished", "parts"]
LABELS = {"new": "new", "open_box": "open box", "used": "used", "refurbished": "refurbished", "parts": "for parts"}
CONDITION_IDS = {"new": "1000", "open_box": "1500", "refurbished": "2000|2010|2020|2030|2500", "used": "3000", "parts": "7000"}
"""eBay's own condition ids, for narrowing a search to some conditions."""


def tokens(text):
    """A title's words, lowercased, with a number and its unit joined (128 GB -> 128gb), decimals kept whole (6.1)
    and a plus sign read as the word (Form 3+ -> form 3 plus)."""
    text = re.sub(r"['’]", "", re.sub(r"['’]s\b", "", (text or "").lower()))
    text = re.sub(r"(?<=[a-z0-9])\+", " plus", text).replace("&", " and ")
    text = re.sub(rf"(\d)\s+({UNITS})\b(?!/)", r"\1\2", text)
    return [w.strip(".") for w in re.split(r"[^a-z0-9.]+", text) if w.strip(".")]


def money(text):
    m = re.match(r"^\$\s?([\d,]+(?:\.\d+)?)", (text or "").strip())
    return float(m.group(1).replace(",", "")) if m else None


def parse_card(card):
    """One result card's text, made sense of: price, shipping, date, condition, how it sold."""
    rows = card.get("rows") or []
    subtitles = card.get("subtitles") or []
    condition = next((part.strip() for s in subtitles for part in s.split(" · ") if CONDITION.match(part.strip())), None)
    product = next((s for s in subtitles if " · " in s and not CONDITION.match(s)), None)
    price_text = (card.get("price") or "").strip()
    ranged = re.match(r"^\$([\d,.]+)\s+to\s+\$([\d,.]+)", price_text)
    sold = re.search(r"Sold\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})", card.get("caption") or "")
    ship = None
    for r in rows:
        if m := re.match(r"^\+\s?\$([\d,.]+)\s+(delivery|shipping|postage)", r, re.I):
            ship = float(m.group(1).replace(",", ""))
            break
        if re.match(r"^free\b.*\b(delivery|shipping|postage)", r, re.I):
            ship = 0.0
            break
    bids = next((int(m.group(1)) for r in rows if (m := re.match(r"^(\d+) bids?$", r))), None)
    offer = any(re.match(r"^best offer accepted", r, re.I) for r in rows)
    location = next((re.sub(r"^(Located in|from)\s+", "", r) for r in rows if re.match(r"^(Located in|from) ", r)), None)
    count_sold = next((int(m.group(1).replace(",", "")) for r in rows if (m := re.match(r"^([\d,]+)\+? sold$", r))), None)
    return {
        "id": card["id"],
        "url": f"https://www.ebay.com/itm/{card['id']}",
        "title": card["title"],
        "sold_on": f"{sold.group(3)}-{MONTHS[sold.group(1).lower()]:02d}-{int(sold.group(2)):02d}" if sold and sold.group(1).lower() in MONTHS else None,
        "price": None if ranged else money(price_text),
        "price_text": price_text,
        "was": money(card.get("strike")),
        "shipping": ship,
        "format": "auction" if bids is not None else "best offer" if offer else "buy it now",
        "bids": bids,
        "best_offer_accepted": offer,
        "condition": condition,
        "product": product,
        "location": location,
        **({"sold_count": count_sold} if count_sold else {}),
    }


def bucket_of(item):
    """new, open_box, used, refurbished or parts, from eBay's condition and what the title owns up to."""
    c = (item["condition"] or "").lower()
    if "parts" in c or FAULTY.search(item["title"]):
        return "parts"
    if "refurb" in c or "remanufactured" in c or "certified" in c:
        return "refurbished"
    if c == "open box" or "(other)" in c:
        return "open_box"
    if c in ("brand new", "new") or c.startswith("new "):
        return "new"
    if c:
        return "used"
    return "refurbished" if re.search(r"\brefurb", item["title"], re.I) else "new" if SEALED.search(item["title"]) else "used"


def _matches(query_words, words):
    """Where each of the query's words is in the title (its position), or None if one is missing.
    A word split differently counts: AE-1 for ae1, and ae1 for AE-1."""
    at = {}
    for i, w in enumerate(words):
        at.setdefault(w, i)
        if i + 1 < len(words):
            at.setdefault(w + words[i + 1], i + 1)
    found, i = [], 0
    while i < len(query_words):
        q = query_words[i]
        if q in at:
            found.append(at[q])
            i += 1
        elif i + 1 < len(query_words) and q + query_words[i + 1] in at:
            found.append(at[q + query_words[i + 1]])
            i += 2
        else:
            return None
    return found


def accessory(words, positions, asked):
    """Whether a title sells something for the model rather than the model: "Resin Tank for Saturn 3
    Ultra", "Finish Kit Compatible Formlabs Form 3", or a part named right after it ("Form 3 LPU",
    "Saturn 3 Ultra 12K LCD Screen", "iPhone 13 Pro Display Assembly")."""
    for i, w in enumerate(words):
        if w not in ("for", "fits", "fit", "compatible"):
            continue
        rest = [x for x in words[i + 1:i + 5] if x not in ("with", "w", "the", "use", "all", "most", "your", "a", "an", "in")]
        if rest and rest[0] in asked:
            return True
        model_after = [p for p in positions if i < p < len(words)]
        if model_after and any(x not in asked for x in words[:i]):
            return True
    in_title = [p for p in positions if p < len(words)]
    if not in_title or any(w in WHOLE for w in words[:max(in_title)]):
        return False  # "Lumix Digital Camera DMC-ZS7 Case Charger": the thing itself, named in or before the model
    return names_a_part(words[max(in_title) + 1:max(in_title) + 7])


def names_a_part(after):
    """Whether the words right after the model's own say a piece of it is for sale. A part named first
    is one ("12K LCD Screen", "LPU Complete Assembly", "Resin Tank") unless the thing itself is named
    next ("LCD 3D Printer"); once it is, only a piece sold on its own named right after it counts
    ("3D Printer Build Plate", "Camera Body Cap", "Camera Strap"), not what describes it or comes
    with it ("Printer Resin LCD Screen", "Printer Open Box", "Camera Battery Charger", "Camera
    Leather Case"). Words joined on with for, with or and are the listing's extras, not what it is."""
    first, parts = None, 0
    for j, x in enumerate(after):
        if x in JOINERS:
            break
        if re.search(r"\d", x) or x in DESCRIPTORS:
            continue
        if x in WHOLE:
            nxt = next((y for y in after[j + 1:j + 3] if y not in OF_A_PART), None)
            return nxt in SOLD_ALONE or parts >= 2
        first = first or x
        parts += x in PARTS
    return first in PARTS


def why_left_out(item, query_words, exclude, include, variants):
    """Why a listing isn't a sale of the model asked about, or None when it is."""
    words = tokens(item["title"])
    positions = _matches(query_words, words) or _matches(query_words, words + tokens(item["product"]))
    if positions is None:
        return "another model"
    asked = set(query_words) | {a + b for a, b in zip(query_words, query_words[1:])}
    if ACCESSORY.search(item["title"]):
        return "accessory or part"
    if accessory(words, positions, asked):
        return "accessory or part"
    if not variants:
        for p in positions:
            if p + 1 < len(words) and words[p + 1] not in asked and words[p + 1] in VARIANTS and words[p + 2:p + 3] != ["series"]:
                return f"a variant ({words[p]} {words[p + 1]})"
    if exclude and exclude.search(item["title"]):
        return "excluded words"
    if include and not include.search(item["title"]):
        return "lacks required words"
    if LOT.search(item["title"]):
        return "lot"
    if item["price"] is None:
        return "price range (variations)" if re.match(r"^\$[\d,.]+\s+to", item["price_text"]) else "price not in dollars"
    return None


def _pct(values, q):
    """The q-th quantile (0..1) of sorted values, interpolated."""
    if len(values) == 1:
        return values[0]
    k = (len(values) - 1) * q
    lo = int(k)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (k - lo)


def stats(items, sold=True):
    """A condition's prices: how many, low, the middle half, median, high; shipping and how they sold."""
    prices = sorted(i["price"] for i in items)
    ships = [i["shipping"] for i in items if i["shipping"] is not None]
    out = {
        "n": len(prices), "low": prices[0], "p25": round(_pct(prices, 0.25), 2), "median": round(statistics.median(prices), 2),
        "p75": round(_pct(prices, 0.75), 2), "high": prices[-1],
        "shipping_median": round(statistics.median(ships), 2) if ships else None,
        "delivered_median": round(statistics.median(i["price"] + i["shipping"] for i in items if i["shipping"] is not None), 2) if ships else None,
    }
    if sold:
        dates = sorted(i["sold_on"] for i in items if i["sold_on"])
        out.update({"auctions": sum(i["format"] == "auction" for i in items),
                    "best_offer_accepted": sum(i["best_offer_accepted"] for i in items),
                    "first_sold": dates[0] if dates else None, "last_sold": dates[-1] if dates else None})
    if items and items[0]["bucket"] == "new":
        out["sealed"] = sum(bool(SEALED.search(i["title"])) for i in items)
    return out


def trim_outliers(items):
    """Leaves out prices far from the rest of their condition (under 40% or over 2.5x its median,
    once it has 5 sales): a part listed as the whole thing, a typo, a bundle with three lenses."""
    if len(items) < 5:
        return items, []
    m = statistics.median(i["price"] for i in items)
    keep = [i for i in items if 0.4 * m <= i["price"] <= 2.5 * m]
    return keep, [i for i in items if i not in keep]


def dollars(x):
    return f"${x:,.0f}" if x >= 100 or float(x).is_integer() else f"${x:,.2f}"


def span(s):
    if s["n"] == 1:
        return dollars(s["median"])
    if s["low"] == s["high"]:
        return f"{dollars(s['low'])} each"
    if s["n"] < 4:
        return f"{dollars(s['low'])}–{dollars(s['high'])}"
    return f"{dollars(s['p25'])}–{dollars(s['p75'])} (median {dollars(s['median'])}, {dollars(s['low'])}–{dollars(s['high'])} overall)"


def search_url(query, sold=True, page=1, condition=None, min_price=None, max_price=None, category=None, us_only=True, exclude_words=(), sort=None,
               quoted=False):
    """The eBay search for it, as a person would build it in the search bar and filters. quoted puts each
    word in quotes, which eBay takes as "this word must be in it" rather than something like it."""
    words = [f'"{w}"' if quoted and not w.startswith("-") else w for w in query.split()]
    words += [f"-{w}" for w in exclude_words if re.fullmatch(r"[\w.]+", w)]
    params = {"_nkw": " ".join(words), "_ipg": "240"}
    if sold:
        params.update({"LH_Sold": "1", "LH_Complete": "1", "_sop": "13"})
    else:
        params.update({"LH_BIN": "1", "_sop": sort or "12"})
    if us_only:
        params["LH_PrefLoc"] = "1"
    if condition:
        params["LH_ItemCondition"] = "|".join(CONDITION_IDS[c] for c in condition)
    if min_price is not None:
        params["_udlo"] = f"{min_price:g}"
    if max_price is not None:
        params["_udhi"] = f"{max_price:g}"
    if category:
        params["_sacat"] = str(category)
    if page > 1:
        params["_pgn"] = str(page)
    return "https://www.ebay.com/sch/i.html?" + urllib.parse.urlencode(params)


def result_count(text):
    m = re.match(r"^([\d,]+)\+?\s+results?", text or "")
    return int(m.group(1).replace(",", "")) if m else None


def _read_search(query, sold, pages, quoted, **search):
    cards, found, urls = [], None, []
    for page in range(1, pages + 1):
        url = search_url(query, sold=sold, page=page, quoted=quoted, **search)
        urls.append(url)
        got = load(url)
        if got.get("layout") == "none" and not got.get("cards") and result_count(got.get("count")) != 0:
            raise RuntimeError(f"eBay's results page didn't look as expected ({got.get('title')!r} at {got.get('url')}): page.js needs a look")
        found = result_count(got.get("count")) if found is None else found
        page_cards = got.get("cards") or []
        if found is not None:
            page_cards = page_cards[:max(0, found - len(cards))]
        cards += page_cards
        if got.get("cut") or len(page_cards) < 200 or (found is not None and len(cards) >= found):
            break
    return cards, found, urls


PADDED = 0.25
"""The share of a full page that's other models past which eBay has padded the search with things like
it (a search for a Fujifilm X100V answered with every compact camera sold today), so the quoted search
is read too."""


def other_models(cards, query):
    """The share of cards whose titles don't have the model's words at all."""
    query_words = tokens(" ".join(w for w in query.split() if not w.startswith("-")))
    off = sum(_matches(query_words, tokens(c["title"])) is None and _matches(query_words, tokens(c["title"]) + tokens(_product(c))) is None
              for c in cards)
    return off / len(cards) if cards else 0.0


def _product(card):
    return next((s for s in card.get("subtitles") or [] if " · " in s and not CONDITION.match(s)), "")


def read_pages(query, sold, pages, **search):
    """Every exact-match card over up to `pages` pages, with what eBay said it found and the searches it
    read. eBay pads a search for a less common model with things like it, newest first, so the model's
    own sales are a few among hundreds: when a full page is mostly other models, the same search with
    each word quoted is read too, and the two are put together (a plain search still finds spellings
    the quoted one misses, like AE1 for AE-1)."""
    cards, found, urls = _read_search(query, sold, pages, False, **search)
    if len(cards) >= 200 and other_models(cards, query) > PADDED:
        more, found_quoted, more_urls = _read_search(query, sold, pages, True, **search)
        seen = {c["id"] for c in cards}
        cards += [c for c in more if c["id"] not in seen]
        found, urls = found_quoted, urls + more_urls
    return cards, found, urls


def _compile(words):
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.I) if words else None


def sift(cards, query, exclude=(), require=(), variants=False, days=None, sold=True, today=None):
    """Cards made sense of, then split into the model's own listings by condition and what's left out (and why)."""
    query_words = tokens(" ".join(w for w in query.split() if not w.startswith("-")))
    exclude_re, include_re = _compile(exclude), _compile(require)
    since = ((today or datetime.date.today()) - datetime.timedelta(days=days)).isoformat() if days else None
    kept, left_out, seen = {b: [] for b in BUCKETS}, {}, set()
    for c in cards:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        item = parse_card(c)
        why = why_left_out(item, query_words, exclude_re, include_re, variants)
        if not why and since and item["sold_on"] and item["sold_on"] < since:
            why = f"sold over {days} days ago"
        if why:
            left_out.setdefault(why, []).append(item)
            continue
        item["bucket"] = bucket_of(item)
        kept[item["bucket"]].append(item)
    odd = pooled_outliers(kept)
    for b in BUCKETS:
        kept[b], more = trim_outliers([i for i in kept[b] if i not in odd])
        odd += more
    if odd:
        left_out.setdefault("price far from the rest", []).extend(odd)
    return kept, left_out


def pooled_outliers(kept):
    """What's priced nothing like the model in any working condition, once there are 5 such sales: under
    30% or over 3x their pooled median. A condition with a sale or two can't judge its own (a $15 manual
    and a $69 case listed as new beside two $1,600 cameras); for-parts sales are left to their own."""
    pool = [i["price"] for b in BUCKETS if b != "parts" for i in kept[b]]
    if len(pool) < 5:
        return []
    m = statistics.median(pool)
    return [i for b in BUCKETS if b != "parts" for i in kept[b] if not 0.3 * m <= i["price"] <= 3 * m]


def compact(item, sold=True):
    out = {k: item[k] for k in ("sold_on" if sold else "location", "price", "shipping", "bucket", "format", "title", "url") if item.get(k) is not None}
    if item.get("shipping") is None:
        out["shipping_note"] = "not given (calculated at checkout, or pickup only)"
    if item.get("best_offer_accepted"):
        out["price_is"] = "listed price; the accepted offer was lower"
    if item.get("bids"):
        out["bids"] = item["bids"]
    if item.get("condition"):
        out["condition"] = item["condition"]
    return out


def _shipping_words(ship):
    if isinstance(ship, (int, float)):
        return f" + {dollars(ship)} shipping" if ship else " shipped free"
    return " (shipping not given)"


def summarize(query, conditions, left_out, sold=True):
    have = [b for b in BUCKETS if b in conditions]
    if not have:
        return f"No eBay {'sales' if sold else 'live listings'} of {query!r} {'in the window' if sold else 'match it'}" + (
            f" ({sum(len(v) for v in left_out.values())} listings weren't it)." if left_out else ".")
    if sold:
        parts = [f"{LABELS[b]} {conditions[b]['n']} sold, {span(conditions[b])}" for b in have]
        dates = sorted(d for b in have for d in (conditions[b]["first_sold"], conditions[b]["last_sold"]) if d)
        head = f"eBay sold, {query!r}" + (f" ({dates[0]} to {dates[-1]})" if dates else "") + ": "
        offers = sum(conditions[b]["best_offer_accepted"] for b in have)
        tail = f" {offers} sold by accepted offer, for less than the listed price shown." if offers else ""
    else:
        parts = [f"{LABELS[b]} from {dollars(conditions[b]['cheapest']['price'])}" +
                 _shipping_words(conditions[b]['cheapest'].get('shipping')) + f" ({conditions[b]['n']} listed)" for b in have]
        head, tail = f"eBay live Buy It Now, {query!r}: ", ""
    missing = [LABELS[b] for b in ("new", "used", "refurbished") if b not in conditions]
    out = head + "; ".join(parts) + "." + (f" None {'sold' if sold else 'listed'} {' or '.join(missing)}." if missing else "") + tail
    if left_out:
        reasons = sorted(left_out.items(), key=lambda kv: -len(kv[1]))
        out += " Left out " + ", ".join(f"{len(v)} {k}" for k, v in reasons[:4]) + "."
    return out


# The cache: a lookup's answer for 6 hours, kept in SB_HOME so a restart keeps it.

_cache = None


def cache():
    global _cache
    if _cache is None:
        try:
            with open(home(PART, "cache.json")) as f:
                _cache = json.load(f)
        except (OSError, ValueError):
            _cache = {}
    return _cache


def cached(key):
    with cache_lock:
        hit = cache().get(key)
        return hit["answer"] if hit and time.time() - hit["at"] < CACHE_S else None


def keep(key, answer):
    with cache_lock:
        c = cache()
        c[key] = {"at": time.time(), "answer": answer}
        for k in sorted(c, key=lambda k: c[k]["at"])[:-200]:
            del c[k]
        tmp = home(PART, "cache.json.tmp")
        with open(tmp, "w") as f:
            json.dump(c, f)
        os.replace(tmp, home(PART, "cache.json"))


def slug(text):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")[:80]


# The chart: sold prices over time, by condition, drawn by matplotlib (in the venv run.sh makes).

CHART_PY = os.path.join(HERE, "chart.py")


def draw_chart(query, items):
    """A PNG of the kept sales (date against price, by condition), kept in home/files, or None when it can't be drawn."""
    points = [{"d": i["sold_on"], "p": i["price"], "b": i["bucket"], "o": i["best_offer_accepted"]} for i in items if i["sold_on"]]
    if len(points) < 2:
        return None
    out = os.path.join(tempfile.mkdtemp(prefix="ebay-comps-"), f"ebay-sold-{slug(query)}.png")
    r = subprocess.run([sys.executable, CHART_PY, out],
                       input=json.dumps({"title": f"eBay sold: {query}", "points": points, "labels": LABELS}),
                       capture_output=True, text=True, timeout=240)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"the chart didn't draw: {(r.stderr or r.stdout).strip()[-300:]}")
    return keep_file(out, "image/png", PART)


# Tools.


def _call(fn):
    """Counts a call and its failure, and closes the tab after (unless a human check holds it)."""
    state["calls"] += 1
    try:
        return fn()
    except Blocked as e:
        state["failed"] += 1
        state["last_error"] = f"Blocked: {e}"
        return {"status": "blocked", "why": str(e), "session": f"ebay-{SESSION}",
                "note": "eBay wants a human check. The tab stays open and a need asks the user to pass it; then call again."}
    except Exception as e:
        state["failed"] += 1
        state["last_error"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        if state.pop("tab_open", None) and time.time() >= state["cooldown_until"]:
            release()


def _words(value):
    if not value:
        return []
    return [w.strip() for w in (value.split(",") if isinstance(value, str) else value) if w and w.strip()]


@app.tool(name="comps", read_only=True, schema={
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "The model, as you'd search eBay: \"elegoo saturn 3 ultra\", \"iphone 13 pro 128gb\", \"canon ae-1\". Every word must be in a listing's title (or its catalog line) for it to count."},
        "exclude": {"type": "array", "items": {"type": "string"}, "description": "Words or phrases that rule a listing out, like [\"body only\", \"16k\"]; single words are left out of eBay's search too."},
        "require": {"type": "array", "items": {"type": "string"}, "description": "Words or phrases a title must have one of, like [\"12k\"]."},
        "condition": {"type": "array", "items": {"type": "string", "enum": BUCKETS}, "description": "Search only these conditions (default all): for one crowded out by the others in 240 results."},
        "variants": {"type": "boolean", "description": "Count variants too (Pro Max in a search for Pro, Ultra in one for Saturn 3). Default false."},
        "days": {"type": "integer", "description": "Only sales in the last this many days (default 90)."},
        "min_price": {"type": "number"}, "max_price": {"type": "number"},
        "category": {"type": "integer", "description": "An eBay category id to search within (_sacat)."},
        "us_only": {"type": "boolean", "description": "Only items located in the US (default true)."},
        "pages": {"type": "integer", "description": "Pages of 240 results to read (default 1, at most 4)."},
        "limit": {"type": "integer", "description": "Kept sales to list, newest first (default 25)."},
        "chart": {"type": "boolean", "description": "Also draw the sales as a chart (date against price, by condition): an image here and a PNG file."},
        "fresh": {"type": "boolean", "description": "Look again even if it was looked up in the last 6 hours."},
        "about": {"type": "array", "items": {"type": "string"}, "description": "Entities its record is about."},
    },
    "required": ["query"],
})
def comps(query, exclude=None, require=None, condition=None, variants=False, days=90, min_price=None, max_price=None,
          category=None, us_only=True, pages=1, limit=25, chart=False, fresh=False, about=None):
    """What a model sells for on eBay: its sold listings over the last 90 days by condition (new/sealed, open box, used, refurbished, for parts), each with how many sold, the middle half of prices, median, low and high, shipping, and how they sold (auctions, accepted offers, whose real price eBay hides); other models and variants, accessories, lots and outliers are left out and counted, with examples. Lists the kept sales newest first, and draws a chart if asked. Answered from its cache within 6 hours unless fresh. Loads eBay in a background tab of the user's browser."""
    def run():
        exclude_w, require_w = _words(exclude), _words(require)
        search = {"condition": condition or None, "min_price": min_price, "max_price": max_price, "category": category,
                  "us_only": us_only, "exclude_words": exclude_w}
        key = "comps:" + hashlib.sha1(json.dumps([query.lower().strip(), exclude_w, require_w, search, variants, days, pages], sort_keys=True, default=str).encode()).hexdigest()
        answer = None if fresh else cached(key)
        if answer is None:
            cards, found, urls = read_pages(query, True, max(1, min(int(pages or 1), 4)), **search)
            kept, left_out = sift(cards, query, exclude_w, require_w, variants, days)
            conditions = {b: stats(kept[b]) for b in BUCKETS if kept[b]}
            items = sorted((i for b in BUCKETS for i in kept[b]), key=lambda i: (i["sold_on"] or "", i["price"]), reverse=True)
            answer = {
                "query": query,
                "summary": summarize(query, conditions, left_out),
                "conditions": conditions,
                "sold": [compact(i) for i in items],
                "left_out": {k: {"n": len(v), "e.g.": [f"{i['title']} ({i['price_text']})" for i in v[:3]]} for k, v in sorted(left_out.items(), key=lambda kv: -len(kv[1]))},
                "found": found, "read": len(cards), "searched": urls[0] if len(urls) == 1 else urls,
                "looked_up_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                "_points": [{"sold_on": i["sold_on"], "price": i["price"], "bucket": i["bucket"], "best_offer_accepted": i["best_offer_accepted"]} for i in items],
            }
            keep(key, answer)
            record(answer, about)
        else:
            answer = {**answer, "cached": True}
        state["last_lookup"] = {"query": query, "at": answer["looked_up_at"], "summary": answer["summary"]}
        out = {k: v for k, v in answer.items() if k != "_points"}
        out["sold"] = out["sold"][:max(0, int(limit if limit is not None else 25))]
        if chart:
            drawn = draw_chart(query, [{**p, "title": ""} for p in answer["_points"]])
            if drawn:
                out["chart"] = drawn
                with open(drawn["path"], "rb") as f:
                    picture = f.read()
                return sbmcp.content(sbmcp.text(json.dumps(out)), sbmcp.image(picture), structured=out)
            out["chart"] = None
        return out
    return _call(run)


@app.tool(name="listings", read_only=True, schema={
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "The model, as you'd search eBay."},
        "exclude": {"type": "array", "items": {"type": "string"}},
        "require": {"type": "array", "items": {"type": "string"}},
        "condition": {"type": "array", "items": {"type": "string", "enum": BUCKETS}},
        "variants": {"type": "boolean"},
        "min_price": {"type": "number", "description": "Default: 40% of the lowest median in its comps from the last 6 hours, when there are any, so parts and accessories don't crowd it out."},
        "max_price": {"type": "number"},
        "category": {"type": "integer"},
        "us_only": {"type": "boolean"},
        "limit": {"type": "integer", "description": "Listings to answer, cheapest delivered first (default 15)."},
    },
    "required": ["query"],
})
def listings(query, exclude=None, require=None, condition=None, variants=False, min_price=None, max_price=None,
             category=None, us_only=True, limit=15):
    """The cheapest live Buy It Now listings that are the model, by condition, cheapest delivered (price plus shipping) first: to set a ceiling for an offer, or to see whether a local listing beats eBay. Same matching as comps. Loads eBay in a background tab of the user's browser."""
    def run():
        exclude_w, require_w = _words(exclude), _words(require)
        floor = min_price
        if floor is None:
            with cache_lock:
                medians = [c["median"] for hit in cache().values() if hit["answer"].get("query", "").lower() == query.lower()
                           and time.time() - hit["at"] < CACHE_S for c in hit["answer"].get("conditions", {}).values()]
            floor = round(0.4 * min(medians)) if medians else None
        cards, found, urls = read_pages(query, False, 1, condition=condition or None, min_price=floor, max_price=max_price,
                                        category=category, us_only=us_only, exclude_words=exclude_w)
        kept, left_out = sift(cards, query, exclude_w, require_w, variants, None, sold=False)
        conditions = {}
        for b in BUCKETS:
            if kept[b]:
                cheapest = sorted(kept[b], key=lambda i: i["price"] + (i["shipping"] or 0))
                conditions[b] = {**stats(kept[b], sold=False), "cheapest": compact(cheapest[0], sold=False)}
        items = sorted((i for b in BUCKETS for i in kept[b]), key=lambda i: i["price"] + (i["shipping"] or 0))
        return {
            "query": query, "summary": summarize(query, conditions, left_out, sold=False), "conditions": conditions,
            "listings": [compact(i, sold=False) for i in items[:max(0, int(limit or 15))]],
            "left_out": {k: {"n": len(v), "e.g.": [f"{i['title']} ({i['price_text']})" for i in v[:3]]} for k, v in sorted(left_out.items(), key=lambda kv: -len(kv[1]))},
            "found": found, "read": len(cards), "searched": urls[0] if len(urls) == 1 else urls, **({"min_price_used": floor} if floor and min_price is None else {}),
        }
    return _call(run)


def facts():
    now = time.time()
    return {
        "started_at": state["started_at"], "calls": state["calls"], "failed": state["failed"], "last_error": state["last_error"],
        "last_lookup": state["last_lookup"], "pages_last_hour": len([p for p in state["pages"] if now - p < 3600]),
        "challenges": state["challenges"], "cooling_down_until": time.strftime("%H:%M", time.localtime(state["cooldown_until"])) if now < state["cooldown_until"] else None,
        "cached_lookups": len(cache()),
    }


register_health(PART, facts)


def record(answer, about=None):
    """Puts what it found on ebay-comps:<query> in commerce/ebay-comps, so the brain knows what the model sells for."""
    app.emit("ebay_comps", {
        "entity": f"ebay-comps:{slug(answer['query'])}",
        "summary": answer["summary"],
        "facts": {"query": answer["query"], "looked_up_at": answer["looked_up_at"], "searched": answer["searched"],
                  "conditions": {b: {k: s[k] for k in ("n", "low", "p25", "median", "p75", "high", "last_sold") if s.get(k) is not None}
                                 for b, s in answer["conditions"].items()},
                  "left_out": {k: v["n"] for k, v in answer["left_out"].items()}},
    }, about=list(about) if about else None)
