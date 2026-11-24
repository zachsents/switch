"""uber: an Uber Courier priced between any two places, or staged for a delivery the user names and stopped at
Confirm delivery, in the user's own browser signed in to Uber.

`uber-courier_quote` prices a courier between any pickup and drop-off (addresses, place names Uber knows, a pin, or the
pickup in config) with nothing typed into Uber's form: it asks Uber's own place search and Products (the GraphQL its
Courier pages send, from a tab on m.uber.com) and answers every option's fare, the fare before Uber's promotion,
suggested tips, how far the nearest courier is and about when it drops off. Nothing is booked.

`uber-courier_stage` takes a delivery as its inputs (drop-off address, recipient name and phone, unit, note, an optional ref
and promise) and fills Uber's Courier form in a background tab: the configured pickup (address, unit, phone, meet at
curb), the drop-off found in Uber's place search, the unit, name and number, Leave at door, the note, and the lowest
tip Uber suggests that isn't $0. It picks the vehicle (Courier Bike when offered for a small box, Courier Saver only
when it still lands by the promise, else Courier), skips one Uber shows Unavailable, reads everything back and answers
the fare, tip, total, card and drop-off estimate. Nothing is booked.

`uber-courier_confirm` (speaks for the user) re-reads the staged tab (the same drop-off, recipient and a total no higher than
what the user approved), fills any contact field Uber's form has blank, presses Confirm delivery, waits for Uber's trip
and records it. `uber-courier_discard` drops a staged one.

`uber-courier_track` and `uber-courier_wait` read Uber's own record of its trips (riders.uber.com's GraphQL) for every courier on the
account: the trips under way and the latest past ones, the live driver, car, plate and ETAs. Courier trips are matched
to the deliveries staged here by drop-off address. While a courier is under way the watcher reads it on its own,
notifies the user of the driver once (and emits uber_driver), records each change (uber_courier) and raises uber_surprise when a booked
courier ends without a drop-off or is still on the road past the promise. It never books or cancels on its own.
"""

import json
import math
import os
import re
import threading
import time
import urllib.parse
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

from browser import Browser, BrowserError
from server import NAME, app, config, load, notify, now_ms, save, session_live

PART = "uber"
WATCH_S = float(os.environ.get("ERRANDS_UBER_WATCH_S") or 40)
"""How often a booked courier's trip is read until its driver shows (then every few minutes until it ends)."""
HEARTBEAT_S = float(os.environ.get("ERRANDS_UBER_HEARTBEAT_S") or 1800)
STREAM = "errands/uber"
PRICE_SLACK = 0.10
"""Uber's price ticks between staging and booking; confirm books it only within this much over what the user saw."""
UBER = "https://m.uber.com/go/connect"
VEHICLES = {"car": re.compile(r"^courier$", re.I), "saver": re.compile(r"saver", re.I), "bike": re.compile(r"bike|bicycle|scooter", re.I)}
"""Uber's names for its Courier products, by the kind each is."""
RUNS_ITSELF = ("From the booking on it runs itself: the watcher notifies the user of the driver, car and plate once (uber_driver), records "
               "each change (uber_courier), and raises uber_surprise when the courier ends without a drop-off or runs past the "
               "promise. Set no wake or delivery check of your own.")

app.event("uber_courier", "An Uber courier for a delivery: staged, booked, discarded, or how its trip stands", stream=STREAM, kind="observation")
app.event("uber_driver", "A booked courier's driver, car and plate, once per trip", stream=STREAM, kind="observation")
app.event("uber_surprise", "A courier that didn't end as it should: ended without a drop-off, or still on the road past the promise",
          stream="surprises", kind="surprise")

health = {"started_at": now_ms(), "calls": 0, "failed": 0, "quoted": 0, "staged": 0, "booked": 0, "mended": 0, "last_error": None,
          "last_quote": None, "last": None, "signed_in": None, "riders": None, "trips_tab": False, "watch_next": 0, "read_at": None}
_lock = threading.Lock()
_state_lock = threading.Lock()
_trips_lock = threading.Lock()


class CourierError(Exception):
    """Something that stops a courier, in words to pass on as they are."""


# ---------------------------------------------------------------------------------------------
# Config: the pickup (where couriers collect from), the note's first words, the time zone.


def cfg():
    return config(PART)


def zone():
    name = cfg().get("zone")
    if name and ZoneInfo:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return datetime.now().astimezone().tzinfo


def pickup_cfg():
    """The configured pickup: {address, unit, phone}; raises when there's none."""
    p = cfg().get("pickup") or {}
    if not (p.get("address") and phone10(p.get("phone"))):
        raise CourierError("No pickup configured: set uber.pickup {address, unit, phone} in the extension's config.json")
    return {"address": p["address"], "unit": (p.get("unit") or "").strip(), "phone": phone10(p["phone"]),
            "label": p["address"] + (f", {p['unit']}" if p.get("unit") else "")}


def note_prefix():
    return (cfg().get("note") or "").strip()


# ---------------------------------------------------------------------------------------------
# The user's browser, one background tab (session) per use.


class Tab:
    def __init__(self, session):
        self.session = session
        self.browser = Browser(app, session=session)

    def op(self, timeout=45, **args):
        try:
            return self.browser.op(args, timeout)
        except BrowserError as e:
            raise CourierError(f"The browser: {e}") from None

    def js(self, code, timeout=30):
        """Runs code in the page; answers its value (JSON-encoded there, decoded here)."""
        out = self.op(op="js", code=f"JSON.stringify((() => {{ {code} }})())", timeout=timeout)
        try:
            return json.loads(out) if isinstance(out, str) else out
        except ValueError:
            return out

    def ajs(self, code, timeout=30):
        """Like js, for code that awaits (a fetch)."""
        # The browser's js op doesn't await a promise (an async IIFE comes back as {}): start it,
        # keep its JSON answer on a window slot, and poll for that.
        slot = f"__uc_{int(time.time() * 1000)}_{os.getpid()}"
        self.op(op="js", code=f"(window.{slot} = null, (async () => {{ try {{ window.{slot} = JSON.stringify(await (async () => {{ {code} }})()); }} "
                f"catch (e) {{ window.{slot} = JSON.stringify({{error: String(e)}}); }} }})(), 1)", timeout=timeout)
        end = time.time() + timeout
        out = None
        while time.time() < end:
            out = self.op(op="js", code=f"window.{slot}", timeout=timeout)
            if out is not None and out != "" and out != "null":
                break
            time.sleep(0.5)
        try:
            self.op(op="js", code=f"(delete window.{slot}, 1)", timeout=10)
        except CourierError:
            pass
        try:
            return json.loads(out) if isinstance(out, str) else out
        except ValueError:
            return out

    def until(self, code, seconds=12, every=0.7, what="the page"):
        end = time.time() + seconds
        while True:
            got = self.js(code)
            if got:
                return got
            if time.time() > end:
                raise CourierError(f"Uber's page didn't show {what} within {int(seconds)} s")
            time.sleep(every)

    def navigate(self, url):
        return self.op(op="navigate", url=url, timeout=60)

    def release(self):
        try:
            self.op(op="release")
        except CourierError:
            pass


def session_for(key):
    return f"{NAME}-uber-{key}"


# ---------------------------------------------------------------------------------------------
# Words and numbers.


def place_query(place):
    return urllib.parse.quote(json.dumps(place, separators=(",", ":")))


def drop_url(pickup_place):
    return f"{UBER}/drop?pickup={place_query(pickup_place)}"


def selection_url(drop_place, pickup_place):
    return f"{UBER}/product-selection?drop%5B0%5D={place_query(drop_place)}&pickup={place_query(pickup_place)}"


def meters(a_lat, a_lng, b_lat, b_lng):
    r = 6371000
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def phone10(phone):
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) == 10 else ""


def delivery_key(text):
    """A delivery's key: the ref the user gave (or the drop-off's street), as lowercase words joined by dashes."""
    k = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40].strip("-")
    if not k:
        raise CourierError("Name the delivery: give its ref")
    return k


STREET_WORDS = {"street": "st", "avenue": "ave", "boulevard": "blvd", "drive": "dr", "road": "rd", "place": "pl", "lane": "ln",
                "court": "ct", "terrace": "ter", "parkway": "pkwy", "circle": "cir", "highway": "hwy", "north": "n", "south": "s",
                "east": "e", "west": "w", "way": "way"}


def norm_street(text):
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return " ".join(STREET_WORDS.get(w, w) for w in words)


def unit_of(line2):
    """The unit a courier needs, or "" for none (N/A, -, blank)."""
    line2 = (line2 or "").strip()
    return "" if re.fullmatch(r"(?i)(n/?a|none|no|-+|\.+|0)?", line2) else line2[:40]


def dollars(text):
    m = re.search(r"\$\s*([\d,]+\.\d\d)", text or "")
    return float(m.group(1).replace(",", "")) if m else None


def local_time(ms):
    return datetime.fromtimestamp(ms / 1000, zone())


def clock(dt):
    return dt.strftime("%I:%M %p").lstrip("0")


def promise_words(ms, now=None):
    """'by 10:00 PM tonight', 'by 6:00 PM Thu Nov 19'."""
    if not ms:
        return ""
    when, today = local_time(ms), local_time(now or time.time() * 1000)
    if when.date() == today.date():
        return f"by {clock(when)} {'tonight' if when.hour >= 17 else 'today'}"
    if when.date() == (today + timedelta(days=1)).date():
        return f"by {clock(when)} tomorrow"
    return f"by {clock(when)} {when.strftime('%a %b')} {when.day}"


def dropoff_epoch(words, now=None):
    """Uber's '10:08 PM dropoff' as epoch ms in local time (the next such time from now)."""
    m = re.search(r"(\d{1,2}):(\d\d)\s*([AP])\.?M", words or "", re.I)
    if not m:
        return None
    hour = int(m.group(1)) % 12 + (12 if m.group(3).upper() == "P" else 0)
    base = local_time(now or time.time() * 1000)
    when = base.replace(hour=hour, minute=int(m.group(2)), second=0, microsecond=0)
    if when < base - timedelta(minutes=30):
        when += timedelta(days=1)
    return int(when.timestamp() * 1000)


def promise_ms(value):
    """A promise as given (epoch ms, an ISO time, or '6:00 PM' today or next) as epoch ms, or None."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip()
    if s.isdigit():
        return int(s)
    try:
        dt = datetime.fromisoformat(s)
        return int((dt if dt.tzinfo else dt.replace(tzinfo=zone())).timestamp() * 1000)
    except ValueError:
        pass
    got = dropoff_epoch(s)
    if not got:
        raise CourierError(f"{value!r} isn't a time (an ISO time like 2026-11-20T18:00, or 6:00 PM)")
    return got


# ---------------------------------------------------------------------------------------------
# What it keeps: each delivery's courier, staged or booked (home/uber/state.json).

_EMPTY = {"deliveries": {}, "log": [], "pickup_place": None}


def load_state():
    st = load(PART)
    for k, v in _EMPTY.items():
        st.setdefault(k, {} if isinstance(v, dict) else ([] if isinstance(v, list) else v))
    return st


def save_state(st):
    save(PART, st)


def update(key, **facts):
    """Changes a delivery's courier in state and records it as uber-courier:<key>; answers it whole."""
    with _state_lock:
        st = load_state()
        c = st["deliveries"].setdefault(key, {"delivery": key})
        c.update(facts)
        c["updated_at"] = now_ms()
        st["log"] = (st["log"] + [{"delivery": key, "at": c["updated_at"], "status": c.get("status")}])[-200:]
        if len(st["deliveries"]) > 120:
            for old in sorted(st["deliveries"], key=lambda k: st["deliveries"][k].get("updated_at", 0))[:-100]:
                st["deliveries"].pop(old, None)
        save_state(st)
    record(c)
    return dict(c)


RECORD_KEYS = ("delivery", "status", "customer", "dropoff", "unit", "product", "fare", "tip", "total", "card", "dropoff_eta", "promised_by",
               "session", "ceiling", "trip", "stage", "driver", "car", "plate", "staged_at", "booked_at", "ended_at", "note", "warnings",
               "phase", "source", "pickup_at", "dropoff_at", "picked_up_at", "delivered_at", "fare_paid", "uber_says", "found_at",
               "driver_told", "driver_told_at", "staged_by", "booked_by", "flagged")


def record(c):
    money = f" ${c['total']:.2f}" if c.get("total") is not None else ""
    summary = {"staged": f"Staged, not booked:{money} {c.get('product') or 'Courier'} to {c.get('customer')}, {c.get('dropoff')}",
               "booked": f"Booked{money} {c.get('product') or 'Courier'} to {c.get('customer')}, {c.get('dropoff')}",
               "discarded": f"Staged courier dropped (not booked) for {c.get('customer')}",
               "unavailable": f"No Uber courier available for {c.get('customer')}",
               "unknown": "Pressed Confirm delivery, outcome unknown: check Uber's Activity",
               "delivered": f"Delivered to {c.get('customer')}, {c.get('dropoff')}",
               "canceled": f"Courier canceled for {c.get('customer')}",
               "ended": f"Uber no longer shows the courier for {c.get('customer')}"}.get(c.get("status"), c.get("status") or "")
    if c.get("status") == "booked" and c.get("source") == "found in Uber":
        summary = f"Courier booked in Uber by hand to {c.get('customer')}, {c.get('dropoff')}"
    if c.get("stage") and c.get("status") in ("booked", "delivered", "canceled"):
        summary += f": {c['stage']}"
    if c.get("status") == "booked" and c.get("driver"):
        summary += f"; {car_words(c)}"
    app.emit("uber_courier", {"entity": f"uber-courier:{c['delivery']}", "name": f"Uber courier: {c['delivery']}",
                              "summary": f"{c['delivery']}: {summary}",
                              "facts": {k: c.get(k) for k in RECORD_KEYS if c.get(k) is not None or k in c}},
             about=[f"uber-courier:{c['delivery']}"])


# ---------------------------------------------------------------------------------------------
# Uber's Courier pages, step by step.

SIGNED_IN = "return !![...document.querySelectorAll('button,[role=button]')].some(b => /profile menu/i.test(b.getAttribute('aria-label') || '')) " \
            "|| (!![...document.querySelectorAll('a')].length && ![...document.querySelectorAll('a')].some(a => a.innerText.trim() === 'Login'))"


def signed_out():
    """The error that stops the tool when the browser isn't signed in to Uber, with the ask to put up."""
    return CourierError("The browser isn't signed in to Uber: put up an ask for the user to sign in to m.uber.com there, "
                        "then try again")


def open_tab(session):
    """A tab on Uber's Courier form, signed in; raises when it isn't."""
    tab = Tab(session)
    tab.navigate(f"{UBER}/drop")
    tab.until("return !!document.querySelector('[data-testid=enhancer-container-drop0] input') || "
              "[...document.querySelectorAll('a')].some(a => a.innerText.trim() === 'Login')", 15, what="its Courier form")
    signed = bool(tab.js(SIGNED_IN))
    health["signed_in"] = {"signed_in": signed, "at": now_ms()}
    if signed:
        session_live("uber")
        return tab
    tab.release()
    raise signed_out()


SEARCH_Q = ("query PudoLocationSearch($latitude: Float!, $longitude: Float!, $query: String!, $type: EnumRVWebCommonPickupOrDropoff!) { "
            "pudoLocationSearch(latitude: $latitude, longitude: $longitude, query: $query, type: $type) { addressLine1 addressLine2 id source provider } }")
RESOLVE_Q = ("query PudoResolveLocation($id: String, $source: EnumRVWebCommonLocationSource, $provider: String, $latitude: Float, $longitude: Float) { "
             "pudoResolveLocation(id: $id, source: $source, provider: $provider, latitude: $latitude, longitude: $longitude) { "
             "addressLine1 addressLine2 id source provider coordinate { latitude longitude } "
             "coordinateRefined { pickup { latitude longitude } dropoff { latitude longitude } } } }")
PRODUCTS_Q = ("query Products($destinations: [InputCoordinate!]!, $pickup: InputCoordinate!, $targetProductType: EnumRVWebCommonTargetProductType) { "
              "products(destinations: $destinations, pickup: $pickup, targetProductType: $targetProductType) { productsUnavailableMessage "
              "tiers { products { id displayName detailedDescription isAvailable etaInMin etaMax estimatedTripTime estimatedTripTimeMax "
              "rankedPricingExplainerText fares { fare fareAmountE5 preAdjustmentValue suggestedUpfrontTipAmounts { amount { amountE5 } } } } } } }")
GQL = r"""
const calls = __CALLS__;
const g = async (operationName, variables, query) => {
  try {
    const r = await fetch('/go/graphql', {method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json', 'x-csrf-token': 'x'}, body: JSON.stringify({operationName, variables, query})});
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return {errors: [{message: 'HTTP ' + r.status + ': ' + t.slice(0, 160)}]}; }
  } catch (e) { return {errors: [{message: String(e)}]}; }
};
return await Promise.all(calls.map(c => g(c[0], c[1], c[2])));
"""
FIELD = {"PudoLocationSearch": "pudoLocationSearch", "PudoResolveLocation": "pudoResolveLocation", "Products": "products"}


def gql(tab, calls):
    """Asks Uber's GraphQL each (operation, variables, query) at once from a tab on m.uber.com; answers each one's
    field, or raises with Uber's own words."""
    got = tab.ajs(GQL.replace("__CALLS__", json.dumps(calls)), timeout=40)
    if not isinstance(got, list) or len(got) != len(calls):
        raise CourierError(f"Uber's page didn't answer its own queries ({str(got)[:200]})")
    out = []
    for (name, _, _), r in zip(calls, got):
        value = ((r or {}).get("data") or {}).get(FIELD[name]) if isinstance(r, dict) else None
        if value is None:
            errors = [e for e in ((r or {}).get("errors") or []) if isinstance(e, dict)]
            said = "; ".join(str(e.get("message")) for e in errors) or "no answer"
            if re.search(r"unauth|log ?in|authenticat|forbidden|HTTP 40[13]", said, re.I):
                raise signed_out()
            codes = " ".join(str((e.get("extensions") or {}).get("code") or "") for e in errors)
            if name == "Products" and "fare_estimate.invalid_request" in codes:
                # Uber prices no Courier to or from an airport, and says only "Something is not right".
                raise CourierError("Uber won't price a Courier between those places (it refused the fare estimate, as it does for airports)")
            words = "; ".join(str((e.get("extensions") or {}).get("subtitle") or "") for e in errors).strip("; ")
            raise CourierError(f"Uber's {name} failed: {said[:200]}" + (f" (\"{words[:160]}\")" if words else ""))
        out.append(value)
    return out


HOME_WORDS = {"home", "pickup", "me", "my place", "the pickup"}
"""Words for the configured pickup."""
LATLNG = re.compile(r"^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$")
STOP_WORDS = {"the", "a", "an", "of", "in", "at", "near", "and", "by", "on", "to", "usa", "us"}
TOO_FAR_KM = 120
"""A pickup and drop-off further apart than this are a wrong pick, not a courier trip (Courier is local)."""


def address_parts(text):
    """An address as typed, '425 Park Ave, Springfield, CA 91340', as (street number, street name words, city)."""
    parts = [p.strip() for p in (text or "").split(",")]
    street, city = parts[0], (parts[1] if len(parts) > 1 else "")
    found = re.match(r"\s*(\d+[A-Za-z]?)\s+\D", street)
    number = found.group(1) if found else ""
    names = [w for w in norm_street(street).split() if w != number.lower() and len(w) > 1 and w not in ("n", "s", "e", "w")]
    return number, names, city


def words_of(text):
    return [w for w in norm_street(text).split() if w not in STOP_WORDS]


def pick_suggestion(options, query):
    """Which of Uber's suggestions (each its lines, [line 1, line 2]) is the place asked for, or None.

    For a street address: one whose street starts with the same number and has the street's first two name words, in
    the city when one was given, best by how many of the words asked it has. For a name: one that has every word
    asked, best by how many are in its name."""
    number, names, city = address_parts(query)
    asked = words_of(query)
    best, best_score = None, -1
    for i, lines in enumerate(options):
        first = (lines[0] if lines else "") or ""
        rest = " ".join(lines[1:])
        if number:
            plain = bool(re.match(r"\s*\d", first))  # an address, not a business with its address under its name
            street = first if plain else rest.split(",")[0]
            where = rest if plain else ", ".join(rest.split(",")[1:])
            s, w = norm_street(street), norm_street(where)
            if not (s.startswith(number.lower() + " ") and all(n in s for n in names[:2]) and (not city or norm_street(city) in w)):
                continue
            text = set(norm_street(f"{first} {rest}").split())
            score = sum(a in text for a in asked) + (1 if plain else 0)
        else:
            head, tail = norm_street(first).split(), norm_street(rest).split()

            def has(a, ws):
                return any(x == a or (len(a) >= 3 and x.startswith(a)) for x in ws)

            if not asked or not all(has(a, head) or has(a, tail) for a in asked):
                continue
            score = sum(2 if has(a, head) else 1 for a in asked)
        if score > best_score:
            best, best_score = i, score
    return best


def place_of(resolved, end):
    """A place Uber resolved, as its Courier pages put it in their links: its door for this end (pickup or dropoff)."""
    refined = (resolved.get("coordinateRefined") or {}).get(end) or resolved.get("coordinate") or {}
    return {"addressLine1": resolved.get("addressLine1"), "addressLine2": resolved.get("addressLine2"), "id": resolved.get("id"),
            "source": resolved.get("source") or "SEARCH", "latitude": refined.get("latitude"), "longitude": refined.get("longitude"),
            "provider": resolved.get("provider") or "uber_places"}


def place_words(place):
    return ", ".join(x for x in (place.get("addressLine1"), place.get("addressLine2")) if x)


def is_home(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower()) in HOME_WORDS


def search_places(tab, asks, near):
    """Finds each (words, end) in Uber's place search near (lat, lng), or as a pin for 'lat, lng'; answers each place
    as Uber's links carry it."""
    lat, lng = near
    places, searches, resolves = [None] * len(asks), [], []
    for i, (words, end) in enumerate(asks):
        pin = LATLNG.match(words or "")
        if pin:
            resolves.append((i, end, {"latitude": float(pin.group(1)), "longitude": float(pin.group(2))}))
        else:
            searches.append((i, end, words))
    if searches:
        found = gql(tab, [("PudoLocationSearch", {"latitude": lat, "longitude": lng, "query": words, "type": "PICKUP" if end == "pickup" else "DROPOFF"},
                           SEARCH_Q) for _, end, words in searches])
        for (i, end, words), options in zip(searches, found):
            lines = [[o.get("addressLine1") or "", o.get("addressLine2") or ""] for o in options]
            pick = pick_suggestion(lines, words)
            if pick is None:
                shown = "; ".join(", ".join(x for x in line if x) for line in lines[:5]) or "nothing"
                raise CourierError(f"Uber's search for {words!r} didn't offer that place (it offered: {shown}); give its street address")
            o = options[pick]
            resolves.append((i, end, {"id": o.get("id"), "source": o.get("source") or "SEARCH", "provider": o.get("provider") or "uber_places"}))
    if resolves:
        got = gql(tab, [("PudoResolveLocation", variables, RESOLVE_Q) for _, _, variables in resolves])
        for (i, end, _), resolved in zip(resolves, got):
            places[i] = place_of(resolved, end)
            if places[i]["latitude"] is None:
                raise CourierError(f"Uber found {place_words(places[i])!r} for {asks[i][0]!r} but not where its door is")
    return places


def pickup_place(tab):
    """The configured pickup as Uber's place search names it (found once per address, then kept)."""
    p = pickup_cfg()
    kept = load_state().get("pickup_place") or {}
    if kept.get("address") == p["address"] and kept.get("place"):
        return kept["place"]
    lat, lng = cfg().get("near") or (0, 0)
    place = search_places(tab, [(p["address"], "pickup")], (lat, lng))[0]
    with _state_lock:
        st = load_state()
        st["pickup_place"] = {"address": p["address"], "place": place}
        save_state(st)
    return place


def find_places(tab, asks):
    """Finds each (words, end): the configured pickup for 'home' (or 'pickup'), a pin for 'lat, lng', else Uber's
    search near the pickup."""
    out = [None] * len(asks)
    rest = []
    home_place = None
    for i, (words, end) in enumerate(asks):
        if is_home(words):
            home_place = home_place or pickup_place(tab)
            out[i] = dict(home_place)
        else:
            rest.append(i)
    if rest:
        try:
            near = home_place or pickup_place(tab)
            near = (near["latitude"], near["longitude"])
        except CourierError:
            near = tuple(cfg().get("near") or (0, 0))
        found = search_places(tab, [asks[i] for i in rest], near)
        for i, place in zip(rest, found):
            out[i] = place
    return out


def fare_options(products, at_ms):
    """Uber's Products answer as each Courier option: its fare and the fare before any promotion, whether Uber has a
    courier for it, how far away the courier is, about when it drops off, what it carries, and the tips Uber suggests
    (the lowest non-zero one added in total)."""
    out = []
    for tier in products.get("tiers") or []:
        for p in tier.get("products") or []:
            fare = (p.get("fares") or [{}])[0]
            price = (fare.get("fareAmountE5") or 0) / 1e5 if fare.get("fareAmountE5") else dollars(fare.get("fare"))
            was = dollars(fare.get("preAdjustmentValue"))
            tips = sorted({round(t["amount"]["amountE5"] / 1e5, 2) for t in fare.get("suggestedUpfrontTipAmounts") or []
                           if (t.get("amount") or {}).get("amountE5")})
            lo, hi = p.get("etaInMin"), p.get("etaMax")
            trip, trip_max = p.get("estimatedTripTime"), p.get("estimatedTripTimeMax")
            drop = clock(local_time(at_ms + trip * 1000)) if trip else None
            if drop and trip_max and trip_max > trip:
                drop = f"{drop}–{clock(local_time(at_ms + trip_max * 1000))}"
            available = bool(p.get("isAvailable")) and price is not None
            out.append({"name": p.get("displayName") or "Courier", "price": round(price, 2) if price is not None else None,
                        "was": was if was and price is not None and was > price + 0.004 else None,
                        "promo": p.get("rankedPricingExplainerText") or None, "available": available,
                        "courier_minutes": (f"{lo}–{hi}" if lo is not None and hi and hi != lo else lo) if available else None,
                        "dropoff": drop if available else None, "carries": p.get("detailedDescription") or None,
                        "tips": tips, "total_with_tip": round(price + tips[0], 2) if price is not None and tips else price})
    return out


def option_words(o):
    if not o["available"]:
        return f"{o['name']} unavailable" + (f" (${o['price']:.2f})" if o.get("price") is not None else "")
    words = f"{o['name']} ${o['price']:.2f}" + (f" (was ${o['was']:.2f})" if o.get("was") else "")
    if o.get("courier_minutes") is not None:
        words += f", courier {o['courier_minutes']} min away"
    if o.get("dropoff"):
        words += f", dropoff about {o['dropoff']}"
    return words


PRODUCTS = ("return [...document.querySelectorAll('[data-testid=\"product_selector.list_item\"]')].map(li => "
            "({id: li.getAttribute('data-itemid'), lines: li.innerText.split('\\n').map(s => s.trim()).filter(Boolean)}))")


def read_products(tab):
    items = tab.until(f"const p = (() => {{ {PRODUCTS} }})(); return p.length ? p : null", 15, what="Courier's options")
    for _ in range(3):
        if all(any("$" in line for line in it["lines"]) for it in items):
            break
        time.sleep(1.5)
        items = tab.js(PRODUCTS) or items
    out = []
    for it in items:
        lines = it["lines"]
        text = " ".join(lines)
        prices = [dollars(line) for line in lines if dollars(line) is not None]
        eta = re.search(r"(\d+)\s*mins?\s*away", text)
        drop = re.search(r"(\d{1,2}:\d\d\s*[AP]M)\s*dropoff", text, re.I)
        out.append({"id": it["id"], "name": lines[0], "price": prices[0] if prices else None, "was": prices[1] if len(prices) > 1 else None,
                    "pickup_minutes": int(eta.group(1)) if eta else None, "dropoff": drop.group(1) if drop else None,
                    "unavailable": bool(re.search(r"unavailable", text, re.I)), "text": text})
    return out


def kind_of(product):
    for kind, pat in VEHICLES.items():
        if pat.search(product["name"]):
            return kind
    return "other"


def candidates(products, vehicle, promised_by, large):
    """The products to try, best first: Courier Bike for a small box when offered; Courier Saver only when it still
    lands by the promise; else Courier; Saver after all only when nothing else is there."""
    by = {}
    for p in products:
        by.setdefault(kind_of(p), p)
    if vehicle != "auto":
        if vehicle not in by:
            raise CourierError(f"Uber doesn't offer Courier {vehicle} for this trip (it offers {', '.join(p['name'] for p in products)})")
        return [by[vehicle]]
    order = []
    if "bike" in by and not large:
        order.append(by["bike"])
    saver = by.get("saver")
    if saver and promised_by and saver.get("dropoff"):
        lands = dropoff_epoch(saver["dropoff"])
        if lands and lands <= promised_by - 10 * 60000:
            order.append(saver)
    if "car" in by:
        order.append(by["car"])
    if saver and saver not in order:
        order.append(saver)
    if "bike" in by and by["bike"] not in order:
        order.append(by["bike"])
    return order or products


REVIEW = ("const t = document.querySelector('main') ? document.querySelector('main').innerText : ''; "
          "const r = t.split('\\n').map(s => s.trim()).filter(Boolean); const i = r.indexOf('Review'); "
          "const b = document.querySelector('[data-testid=request_trip_button]'); "
          "return {lines: i >= 0 ? r.slice(i + 1, i + 5) : [], button: b ? b.innerText.replace(/\\s+/g, ' ').trim() : null, "
          "disabled: b ? !!b.disabled || b.getAttribute('aria-disabled') === 'true' : null, path: location.pathname, "
          "card: (([...document.querySelectorAll('main button')].find(x => /payment method/i.test(x.getAttribute('aria-label') || '')) || {}).innerText || '').trim(), "
          "drop: new URLSearchParams(location.search).get('drop[0]')}")


def review(tab):
    r = tab.until(f"const v = (() => {{ {REVIEW} }})(); return v.button ? v : null", 15, what="its Confirm delivery step")
    head = " ".join(r["lines"][:3])
    r["unavailable"] = bool(re.search(r"\bunavailable\b", head, re.I))
    eta = re.search(r"(\d+)\s*mins?\s*away", head)
    drop = re.search(r"(\d{1,2}:\d\d\s*[AP]M)\s*dropoff", head, re.I)
    r["pickup_minutes"] = int(eta.group(1)) if eta else None
    r["dropoff"] = drop.group(1) if drop else None
    m = re.search(r"\$\s*([\d,]+\.\d\d)(?:\s*\(\+\s*\$\s*([\d,]+\.\d\d)\))?", r["button"] or "")
    r["fare"] = float(m.group(1).replace(",", "")) if m else None
    r["tip"] = float(m.group(2).replace(",", "")) if m and m.group(2) else 0.0
    r["total"] = round((r["fare"] or 0) + r["tip"], 2) if r["fare"] is not None else None
    return r


APT = 'input[placeholder="Apt / Suite / Floor"]'
PHONE = 'input[aria-label^="Please enter a phone number"]'
RECIPIENT = 'input[placeholder="Recipient name"]'
DROP_NOTE = 'textarea[placeholder="Add a dropoff note"]'
SET_FIELD = ("const e = [...document.querySelectorAll('main ' + {sel})][{i}]; if (!e) throw new Error('Uber has no field ' + {sel}); "
             "e.scrollIntoView({{block: 'center'}}); e.focus(); "
             "const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; "
             "Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, {text}); "
             "e.dispatchEvent(new Event('input', {{bubbles: true}})); e.dispatchEvent(new Event('change', {{bubbles: true}})); e.blur();")


def fill(tab, fields):
    """Sets each (selector, index, text) field as typing would (React's own value setter and input events), in one go."""
    # Each snippet in its own block: they're joined into one scope and each declares `const e`.
    code = " ".join("{ " + SET_FIELD.format(sel=json.dumps(sel), i=int(i), text=json.dumps(text)) + " }" for sel, i, text in fields)
    tab.js(code + " return true", timeout=60)


READBACK = ("const v = s => [...document.querySelectorAll('main ' + s)].map(e => e.value); "
            f"return {{apt: v({json.dumps(APT)}), phones: v({json.dumps(PHONE)}), recipient: v({json.dumps(RECIPIENT)}), "
            f"note: v({json.dumps(DROP_NOTE)}), pressed: [...document.querySelectorAll('main button[aria-checked=true]')].map(b => b.getAttribute('aria-label'))}}")

TIPS = ("return [...document.querySelectorAll('main button')].map(b => b.getAttribute('aria-label') || '')"
        ".filter(l => /^\\$\\d+(\\.\\d\\d)?$/.test(l)).map(l => parseFloat(l.slice(1)))")


def pick_tip(tab, tip):
    """Presses the lowest tip Uber suggests that isn't $0, or the one asked for."""
    offered = tab.js(TIPS) or []
    nonzero = sorted(t for t in offered if t > 0)
    if tip in (None, "", "lowest"):
        want = nonzero[0] if nonzero else None
    else:
        want = float(tip)
        if want and want not in offered:
            raise CourierError(f"Uber suggests tips of {', '.join(f'${t:.2f}' for t in offered)}; ${want:.2f} isn't one")
    if want is None:
        return 0.0
    label = f"${want:.2f}"
    tab.js(f"const b = [...document.querySelectorAll('main button')].find(b => b.getAttribute('aria-label') === {json.dumps(label)}); "
           "if (!b) throw new Error('no tip button'); b.click(); return true")
    return want


# ---------------------------------------------------------------------------------------------
# Its tools.


def approval_for(c):
    """What the user approves: the words, and the gated call that books it."""
    who = f"**{c['customer']}**, {c['dropoff']}" + (f" {c['unit']}" if c.get("unit") else "")
    due = f" Due {c['promise']}." if c.get("promise") else ""
    eta = ""
    if c.get("dropoff_eta"):
        eta = f" Drop-off about **{c['dropoff_eta']}** if booked now"
        if c.get("pickup_minutes") is not None:
            eta += f", courier {c['pickup_minutes']} min out"
        eta += "."
        if c.get("late"):
            eta += " That's past the promise."
    tip = f" + ${c['tip']:.2f} tip" if c.get("tip") else ""
    money = f"Uber {c['product']}, **${c['fare']:.2f}{tip} = ${c['total']:.2f}**" + (f" on {c['card']}" if c.get("card") else "") + "."
    others = [p for p in c.get("offered", []) if p["name"] != c["product"]]
    alt = ""
    if others:
        alt = " (" + "; ".join(f"{p['name']} ${p['price']:.2f}" + (f", dropoff {p['dropoff']}" if p.get("dropoff") else "")
                               + (" (unavailable)" if p.get("unavailable") else "") for p in others if p.get("price") is not None) + ")"
    lines = [f"**{c['delivery']}** to {who}.{due}", "", money + eta + alt, "",
             f"Pickup: {c.get('pickup') or 'the configured pickup'}, meet at curb. Drop-off: leave at door"
             + (f", note \"{c['note']}\"" if c.get("note") else "") + ".",
             "", f"Confirm books it while it's no more than **${c['ceiling']:.2f}**."]
    for w in c.get("warnings") or []:
        lines += ["", f"Heads up: {w}"]
    return {"title": f"Book Uber courier: {(c['customer'] or 'recipient').split()[0]}, {c.get('city') or c['dropoff']}"[:60],
            "text": "\n".join(lines),
            "confirm": {"tool": "uber-courier_confirm", "arguments": {"delivery": c["delivery"], "max_total": c["ceiling"]}}}


STAGE_SCHEMA = {"type": "object", "required": ["dropoff"], "properties": {
    "dropoff": {"type": "string", "description": "The drop-off: a street address ('425 Park Ave, Springfield, CA 91340'), a place's name Uber knows, or 'lat, lng'."},
    "name": {"type": "string", "description": "The recipient's name."},
    "phone": {"type": "string", "description": "The recipient's phone, any form (default: the pickup's, so the courier calls the user)."},
    "unit": {"type": "string", "description": "The drop-off's apartment, suite or floor."},
    "note": {"type": "string", "description": "The drop-off note, after config's note (a gate code, where to leave it). Never what's in the box."},
    "ref": {"type": "string", "description": "The delivery's key, the user's own (an order number, say); default: the drop-off's street."},
    "promised_by": {"type": ["string", "number"], "description": "When it's due: an ISO time, '6:00 PM', or epoch ms. Picks Saver only when it still lands by then."},
    "vehicle": {"type": "string", "enum": ["auto", "bike", "car", "saver"], "description":
                "auto (default): Courier Bike when offered for a small box, Courier Saver only when it lands by the promise, else Courier; or exactly bike, car or saver."},
    "large": {"type": "boolean", "description": "Too big or heavy for a bike."},
    "tip": {"type": ["string", "number"], "description": "lowest (default: the lowest non-zero tip Uber suggests) or one of its suggested amounts."},
    "again": {"type": "boolean", "description": "Stage it even though a courier for this delivery was already booked."},
}}


@app.tool(name="stage", open_world=True, schema=STAGE_SCHEMA)
def stage(dropoff: str, name: str = "", phone: str = "", unit: str = "", note: str = "", ref: str = "", promised_by=None,
          vehicle: str = "auto", large: bool = False, tip=None, again: bool = False, ctx=None):
    """Stage an Uber Courier delivery in the user's browser, stopping at Confirm delivery: the configured pickup (its
    unit and phone, meet at curb), the drop-off from Uber's own place search, the unit, recipient's name and number,
    Leave at door, the note, and the lowest non-zero tip. Picks the vehicle and skips any Uber shows Unavailable, reads
    everything back, and answers the fare, tip, total, card and drop-off estimate with `approval` (the words and the
    uber-courier_confirm call that books it). Nothing is booked. Records uber-courier:<delivery>."""
    health["calls"] += 1
    key = delivery_key(ref or (dropoff or "").split(",")[0])
    if vehicle not in ("auto", "bike", "car", "saver"):
        raise CourierError("vehicle is auto, bike, car or saver")
    if not _lock.acquire(timeout=240):
        raise CourierError("Another courier is being staged or booked right now; try again in a minute")
    try:
        return _stage(key, dropoff, name, phone, unit, note, promise_ms(promised_by), vehicle, large, tip, again, ctx)
    except Exception as e:
        health["failed"] += 1
        health["last_error"] = f"stage {key}: {type(e).__name__}: {e}"[:400]
        raise
    finally:
        _lock.release()


LAST_TRIP = ("ended_at", "ended_seen_at", "ending_seen", "found_at", "source", "phase", "stage", "uber_says", "pickup_at", "dropoff_at",
             "picked_up_at", "delivered_at", "fare_paid")
"""What a courier's earlier trip left on its delivery's record, cleared when another is staged."""


def _stage(key, dropoff, to_name, to_phone, unit, note, promised, vehicle, large, tip, again, ctx):
    progress = (lambda m: ctx.progress(m)) if ctx is not None else (lambda m: None)
    pickup = pickup_cfg()
    if not (dropoff or "").strip():
        raise CourierError("Give the drop-off")
    mine = load_state()["deliveries"].get(key) or {}
    if not again and mine.get("status") in ("booked", "unknown"):
        raise CourierError(f"A courier for {key} was already booked ({mine.get('product')}, trip {mine.get('trip') or 'unknown'}); "
                           "again: true stages another")
    given = phone10(to_phone)
    if (to_phone or "").strip() and not given:
        raise CourierError(f"{to_phone!r} isn't a US phone number (10 digits)")
    customer = (to_name or "").strip() or "the recipient"
    phone = given
    theirs = bool(phone)
    if not theirs:
        phone = pickup["phone"]  # Uber refuses Confirm delivery with the recipient's phone blank
    unit = unit_of(unit)
    drop_note = " ".join(x for x in (note_prefix(), (note or "").strip()) if x)[:240]
    warnings = []
    if customer == "the recipient":
        warnings.append("No recipient name, so Uber shows \"the recipient\": give name.")
    if not theirs:
        warnings.append("No recipient phone, so it's the pickup's: the courier calls the user, not the recipient. Give phone to put theirs.")

    progress("Opening Uber's Courier form")
    tab = open_tab(session_for(key))
    try:
        progress("Finding the pickup and drop-off")
        pick_up, place = find_places(tab, [("home", "pickup"), (dropoff, "dropoff")])
        km = meters(pick_up["latitude"], pick_up["longitude"], place["latitude"], place["longitude"]) / 1000
        if km > TOO_FAR_KM:
            raise CourierError(f"Uber found {place_words(place)!r} for the drop-off, {int(km)} km from the pickup: give its full address")
        tab.navigate(selection_url(place, pick_up))
        products = read_products(tab)
        chosen, rv, skipped, fallback = None, None, [], None
        for n, p in enumerate(candidates(products, vehicle, promised, large)):
            progress(f"Trying {p['name']}")
            if n:
                tab.navigate(selection_url(place, pick_up))
                read_products(tab)
            tab.js(f"const li = document.querySelector('li[data-itemid=\"{p['id']}\"]'); if (!li) throw new Error('no such product'); li.click(); return true")
            rv = review(tab)
            if rv.get("disabled"):
                skipped.append(p["name"])
                continue
            if rv["unavailable"]:
                skipped.append(p["name"])
                if fallback is None or (kind_of(p) == "car" and kind_of(fallback) != "car"):
                    fallback = p  # with no courier in sight, a car is likeliest to be found
                continue
            chosen = p
            break
        if chosen is None and fallback is not None:
            tab.navigate(selection_url(place, pick_up))
            read_products(tab)
            tab.js(f"const li = document.querySelector('li[data-itemid=\"{fallback['id']}\"]'); li.click(); return true")
            rv = review(tab)
            chosen = fallback
            warnings.append(f"Uber shows no courier nearby right now (\"Unavailable\" for {', '.join(skipped)}), with no dropoff estimate, "
                            f"so this is {chosen['name']}, likeliest to be found. Finding a courier may take a while, or fail.")
        elif chosen is not None and skipped:
            warnings.append(f"Uber shows {', '.join(skipped)} unavailable right now, so this is {chosen['name']}.")
        if chosen is None:
            update(key, status="unavailable", customer=customer, dropoff=place_words(place), session=tab.session,
                   warnings=[f"Uber won't take {', '.join(skipped)} right now"])
            tab.release()
            raise CourierError(f"Uber won't take {', '.join(skipped) or 'any Courier option'} for {key} right now; try again in a few minutes")

        progress("Filling pickup and drop-off details")
        fields = []
        if pickup["unit"]:
            fields.append((APT, 0, pickup["unit"]))
        fields.append((PHONE, 0, pickup["phone"]))
        if unit:
            fields.append((APT, 1, unit))
        fields.append((RECIPIENT, 0, customer))
        fields.append((PHONE, 1, phone))
        tab.js("const b = document.querySelector('main button[aria-label=\"Leave at door\"]'); if (!b) throw new Error('no Leave at door'); b.click(); return true")
        if drop_note:
            fields.append((DROP_NOTE, 0, drop_note))
        fill(tab, fields)
        tip_given = pick_tip(tab, tip)
        time.sleep(1.2)
        back = tab.js(READBACK)
        rv = review(tab)
        problems = []
        apts = back.get("apt") or []
        if (pickup["unit"] and (apts or [""])[0] != pickup["unit"]) or (unit and (apts[1:] or [""])[0] != unit):
            problems.append(f"unit fields read back {apts}")
        phones = [re.sub(r"\D", "", x) for x in back.get("phones") or []]
        if phones[:1] != [pickup["phone"]] or phones[1:2] != [phone]:
            problems.append(f"phones read back {back.get('phones')}")
        if (back.get("recipient") or [""])[0] != customer:
            problems.append(f"recipient reads {back.get('recipient')}")
        if drop_note and (back.get("note") or [""])[0] != drop_note:
            problems.append(f"dropoff note reads {back.get('note')}")
        if "Leave at door" not in (back.get("pressed") or []):
            problems.append("Leave at door isn't selected")
        if tip_given and abs((rv.get("tip") or 0) - tip_given) > 0.009:
            problems.append(f"the tip shows {rv.get('tip')} instead of {tip_given}")
        if rv.get("fare") is None:
            problems.append(f"Confirm delivery shows no price ({rv.get('button')})")
        if json.loads(rv["drop"] or "{}").get("id") != place.get("id"):
            problems.append("the dropoff changed while filling")
        if problems:
            raise CourierError("Uber's form didn't take everything: " + "; ".join(problems) + ". The tab is still open as " + tab.session)

        lands = dropoff_epoch(rv["dropoff"]) if rv.get("dropoff") else None
        late = bool(promised and lands and lands > promised)
        if late:
            warnings.append(f"Uber's dropoff estimate ({rv['dropoff']}) is after the promise ({promise_words(promised)}).")
        c = update(key, status="staged", customer=customer, dropoff=place_words(place), unit=unit or None,
                   city=(place.get("addressLine2") or "").split(",")[0].strip() or None, pickup=pickup["label"],
                   phone=phone, recipient_phone=theirs, place_id=place.get("id"), drop_lat=place.get("latitude"), drop_lng=place.get("longitude"),
                   product=chosen["name"], product_id=chosen["id"], fare=rv["fare"],
                   tip=rv["tip"], total=rv["total"], card=rv.get("card") or None, dropoff_eta=rv.get("dropoff"),
                   pickup_minutes=rv.get("pickup_minutes"), promised_by=promised, promise=promise_words(promised), late=late,
                   ceiling=round(rv["total"] * (1 + PRICE_SLACK), 2), session=tab.session, note=drop_note or None,
                   offered=[{k: p[k] for k in ("name", "price", "dropoff", "unavailable")} for p in products],
                   staged_at=now_ms(), warnings=warnings or None,
                   trip=None, driver=None, car=None, plate=None, booked_at=None, pressed_at=None,
                   staged_by=getattr(ctx, "work", None), booked_by=None, driver_told=False, driver_told_at=None,
                   flagged=None, **{k: None for k in LAST_TRIP})
        health["staged"] += 1
        health["last"] = {"delivery": key, "status": "staged", "at": c["staged_at"]}
        health["last_error"] = None
        return {"delivery": key, "status": "staged", "booked": False, "customer": customer, "dropoff": c["dropoff"], "unit": unit or None,
                "product": c["product"], "fare": c["fare"], "tip": c["tip"], "total": c["total"], "card": c["card"],
                "dropoff_eta": c["dropoff_eta"], "pickup_minutes": c["pickup_minutes"], "promise": c["promise"], "late": late,
                "note": drop_note or None, "offered": c["offered"], "session": tab.session,
                "ceiling": c["ceiling"], "warnings": warnings, "approval": approval_for(c), "after_approve": RUNS_ITSELF,
                "summary": (f"Staged, not booked: {c['product']} for {key} to {customer}, ${c['fare']:.2f}"
                            + (f" + ${c['tip']:.2f} tip" if c['tip'] else "") + f" = ${c['total']:.2f}"
                            + (f", dropoff about {c['dropoff_eta']}" if c['dropoff_eta'] else "") + ". uber-courier_confirm books it.")}
    except CourierError:
        raise
    except Exception as e:
        raise CourierError(f"{type(e).__name__}: {e}") from e


QUOTE_SCHEMA = {"type": "object", "properties": {
    "pickup": {"type": "string", "description": "Where the courier picks up: a street address, a place's name Uber knows, 'lat, lng', or home (default: the configured pickup)."},
    "dropoff": {"type": "string", "description": "Where it drops off, the same ways (default: home)."},
}}


@app.tool(name="quote", read_only=True, open_world=True, schema=QUOTE_SCHEMA)
def quote(pickup: str = "home", dropoff: str = "home", ctx=None):
    """What an Uber Courier costs right now from any pickup to any drop-off, read live from Uber in the user's browser
    (nothing typed into Uber's form, nothing booked): each Courier option with its fare, the fare before Uber's
    promotion, the suggested tips and the total with the lowest non-zero one, how far the nearest courier is, about
    when it drops off, what it carries, and whether Uber has a courier for it. Answers the places Uber found for the
    words (check they're the ones meant), and a link to Uber's own Courier options for them."""
    health["calls"] += 1
    try:
        return _quote(pickup, dropoff, ctx)
    except Exception as e:
        health["failed"] += 1
        health["last_error"] = f"quote: {type(e).__name__}: {e}"[:400]
        raise


def _quote(pickup, dropoff, ctx):
    if is_home(pickup) and is_home(dropoff):
        raise CourierError("Give a pickup or a drop-off that isn't home (the other one defaults to it)")
    if ctx is not None:
        ctx.progress("Asking Uber")
    tab = open_tab(f"{NAME}-uber-quote-{os.urandom(3).hex()}")
    try:
        pick_up, drop = find_places(tab, [(pickup, "pickup"), (dropoff, "dropoff")])
        km = meters(pick_up["latitude"], pick_up["longitude"], drop["latitude"], drop["longitude"]) / 1000
        if km > TOO_FAR_KM:
            raise CourierError(f"Uber found {place_words(pick_up)!r} for the pickup and {place_words(drop)!r} for the drop-off, "
                               f"{int(km)} km apart: too far for a courier, so one of them isn't the place meant; give its full address")
        at = now_ms()
        products = gql(tab, [("Products", {"pickup": {"latitude": pick_up["latitude"], "longitude": pick_up["longitude"]},
                                           "destinations": [{"latitude": drop["latitude"], "longitude": drop["longitude"]}],
                                           "targetProductType": "CONNECT"}, PRODUCTS_Q)])[0]
    finally:
        tab.release()
    options = fare_options(products, at)
    open_ = [x for x in options if x["available"]]
    route = f"{place_words(pick_up)} to {place_words(drop)}"
    if open_:
        said = f"{route}: " + "; ".join(option_words(x) for x in options) + ". Nothing booked."
    else:
        said = (f"{route}: Uber has no courier for it right now"
                + (f" ({'; '.join(option_words(x) for x in options)})" if options else f" ({products.get('productsUnavailableMessage') or 'no Courier options'})") + ".")
    health["quoted"] += 1
    health["last_quote"] = {"route": route, "at": at, "cheapest": min((x["price"] for x in open_), default=None)}
    health["last_error"] = None
    return {"pickup": place_words(pick_up), "dropoff": place_words(drop), "km": round(km, 1), "options": options,
            "quoted_at": clock(local_time(at)), "link": selection_url(drop, pick_up), "summary": said}


@app.tool(name="confirm", open_world=True, speaks_for_person=True, schema={"type": "object", "required": ["delivery"], "properties": {
    "delivery": {"type": "string", "description": "The staged delivery's key (stage's delivery)."},
    "max_total": {"type": "number", "description": "The most it may come to now, tip included (default: the approval's ceiling)."},
    "again": {"type": "boolean", "description": "Press Confirm delivery even though an earlier press may have gone in (check Uber's Activity first)."}}})
def confirm(delivery: str, max_total: float = None, again: bool = False, ctx=None):
    """Book a staged courier, once the user approved it: re-reads the staged tab and refuses if anything changed
    (another drop-off or recipient, or a total above max_total), fills any blank contact field Uber needs, presses
    Confirm delivery, waits for Uber's trip and records uber-courier:<delivery> as booked. When Uber refuses and its form
    then shows a blank contact field, it fills it and presses once more, after the same checks; never a third time,
    and never after a trip may have gone in. Spends the user's money: only with their approval of that courier."""
    health["calls"] += 1
    key = delivery_key(delivery)
    if not _lock.acquire(timeout=240):
        raise CourierError("Another courier is being staged or booked right now; try again in a minute")
    try:
        return _confirm(key, max_total, again, getattr(ctx, "work", None))
    except Exception as e:
        health["failed"] += 1
        health["last_error"] = f"confirm {key}: {type(e).__name__}: {e}"[:400]
        raise
    finally:
        _lock.release()


DIALOG = ("const d = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true], [data-baseweb=modal]')]"
          ".map(e => e.innerText.trim()).filter(Boolean); return d.length ? [...new Set(d)].join(' | ').slice(0, 300) : null")
"""Words of a dialog Uber put over the form (its refusals come as one with an Ok button)."""

CONFIRMATION = "/go/connect/product-confirmation"
LOOKS = 27
"""How many times confirm looks for Uber's answer after a press, 1.5 s apart (about 40 s)."""


def digits(text):
    return re.sub(r"\D", "", text or "")


def contact_gaps(back, c):
    """The contact fields Uber needs that the tab has blank, as (selector, index, text, what) to fill: the pickup's
    phone, the recipient's name and phone. Uber refuses Confirm delivery while one is blank, and says "vehicle no
    longer available" instead of why."""
    phones = back.get("phones") or []
    gaps = []
    pickup_phone = pickup_cfg()["phone"]
    if not digits((phones[:1] or [""])[0]):
        gaps.append((PHONE, 0, pickup_phone, "the pickup phone"))
    if not ((back.get("recipient") or [""])[0] or "").strip():
        gaps.append((RECIPIENT, 0, c.get("customer") or "the recipient", "the recipient's name"))
    if not digits((phones[1:2] or [""])[0]):
        gaps.append((PHONE, 1, c.get("phone") or pickup_phone,
                     "the recipient's phone" + ("" if c.get("recipient_phone") else " (the pickup's)")))
    return gaps


def changed_contact(back, c):
    """Words for a recipient the tab shows that isn't the one staged (another name or number, not a blank one), or None."""
    name = ((back.get("recipient") or [""])[0] or "").strip()
    phone = digits(((back.get("phones") or [])[1:2] or [""])[0])
    if name and name != c.get("customer"):
        return f"the recipient reads {name!r}, not {c.get('customer')!r}"
    if phone and c.get("phone") and phone != c["phone"]:
        return f"the recipient's phone reads {phone}, not {c['phone']}"
    return None


def mend(tab, c, gaps):
    """Fills each blank contact field and reads the form back; raises when Uber's form didn't take one."""
    fill(tab, [(sel, i, text) for sel, i, text, _ in gaps])
    time.sleep(1.2)
    back = tab.js(READBACK)
    phones = back.get("phones") or []
    missed = [what for sel, i, text, what in gaps
              if (digits((phones[i:i + 1] or [""])[0]) != digits(text) if sel == PHONE else ((back.get("recipient") or [""])[0] or "") != text)]
    if missed:
        raise CourierError(f"Uber's form didn't take {', '.join(missed)} (it reads {back.get('recipient')}, {phones}); "
                           f"nothing was booked, and the tab is still open as {tab.session}")
    return back


def press(tab):
    """Presses Confirm delivery once and watches for Uber's answer: (trip, refused, last look)."""
    tab.op(op="click", match="/Confirm delivery/", timeout=30)
    trip, refused, seen, got = None, None, 0, None
    end = time.monotonic() + 45
    for _ in range(LOOKS):
        got = tab.js("return {path: location.pathname, trip: new URLSearchParams(location.search).get('trip_uuid'), "
                     "text: (document.querySelector('main') || document.body).innerText.slice(0, 600)}")
        if got and got.get("trip"):
            trip = got["trip"]
            break
        try:
            refused = tab.js(DIALOG)
        except CourierError:
            refused = None
        seen = seen + 1 if refused else 0
        if seen >= 3:  # a dialog still up three looks on (about 4 s) is Uber's answer, not a passing one
            break
        if time.monotonic() > end:
            break
        time.sleep(1.5)
    return trip, (refused if seen >= 3 else None), got or {}


def live_trip_to(key):
    """Uber's own record of a trip under way for this delivery (riders.uber.com), or None."""
    try:
        trips = survey([], past=0, only=key)
    except CourierError:
        return None
    return next((x for x in trips if x.get("delivery") == key and x["live"]), None)


def ready_to_press(tab, c, ceiling, key):
    """Re-reads the staged tab and refuses anything the user didn't approve. Answers (review, readback)."""
    rv = review(tab)
    if rv["path"] != CONFIRMATION:
        raise CourierError(f"The staged tab isn't at Confirm delivery any more ({rv['path']}); stage {key} again")
    if json.loads(rv["drop"] or "{}").get("id") != c.get("place_id"):
        raise CourierError("The staged tab's dropoff isn't the one staged; stage it again")
    back = tab.js(READBACK)
    changed = changed_contact(back, c)
    if changed:
        raise CourierError(f"The staged tab's recipient changed ({changed}); stage it again")
    if rv.get("disabled"):
        raise CourierError(f"Uber won't take {c.get('product')} now (Confirm delivery is disabled); stage {key} again for another option")
    if rv["total"] is None or rv["total"] > ceiling + 0.004:
        raise CourierError(f"It comes to ${rv['total']} now, over the ${ceiling:.2f} approved; stage it again")
    return rv, back


def _confirm(key, max_total, again, by=None):
    c = load_state()["deliveries"].get(key)
    if not c or c.get("status") not in ("staged", "unknown"):
        raise CourierError(f"There's no staged courier for {key}" + (f" (it's {c['status']})" if c else "") + "; stage it first")
    if c.get("pressed_at") and not again:
        raise CourierError(f"Confirm delivery was already pressed for {key} at {clock(local_time(c['pressed_at']))}; check Uber's Activity, "
                           "then again: true only if no trip went in")
    ceiling = float(max_total if max_total is not None else c.get("ceiling") or c.get("total") or 0)
    tab = Tab(c["session"])
    rv, back = ready_to_press(tab, c, ceiling, key)
    mended = []
    gaps = contact_gaps(back, c)
    if gaps:  # never press into Uber's refusal: fill what's blank first
        mend(tab, c, gaps)
        mended += [what for *_, what in gaps]
        rv, back = ready_to_press(tab, c, ceiling, key)
    trip, presses = None, 0
    while True:
        presses += 1
        update(key, pressed_at=now_ms())
        trip, refused, got = press(tab)
        if trip:
            break
        t = live_trip_to(key)  # before anything else: did a trip to this door go in?
        if t:
            trip = t["uuid"]
            break
        if refused:
            try:
                tab.op(op="click", match="/^(Ok|OK|Got it|Close)$/", timeout=10)
            except CourierError:
                pass
            time.sleep(1)
        still_form = got.get("path") == CONFIRMATION and not got.get("trip")
        left = contact_gaps(tab.js(READBACK), c) if still_form else []
        # On Uber's word (its dialog), any blank field is why; with no word, only the recipient's phone, the one Uber is
        # known to refuse over, so a press that may yet have gone in is never repeated.
        why = left if refused else [g for g in left if g[0] == PHONE and g[1] == 1]
        if why and presses == 1:
            try:
                mend(tab, c, why)
                mended += [what for *_, what in why if what not in mended]
                rv, back = ready_to_press(tab, c, ceiling, key)
            except CourierError as e:
                update(key, status="staged", pressed_at=None, refused=refused or "no answer", mended=mended or None)
                raise CourierError(f"Uber refused {key}'s Confirm delivery" + (f" (\"{refused}\")" if refused else "")
                                   + f" with {', '.join(w for *_, w in why)} blank on its form, so nothing was booked; "
                                   f"not pressed again: {e}") from e
            continue
        if refused or why:
            update(key, status="staged", pressed_at=None, refused=refused or "no answer", mended=mended or None)
            if left:
                state = f"its form shows {', '.join(w for *_, w in left)} blank" + (" again after filling it" if mended else "")
            else:
                state = "every contact field was filled" + (f" ({', '.join(mended)} here)" if mended else "") + ", so it's something else"
            words = f": \"{refused}\"" if refused else " with no word why"
            raise CourierError(f"Uber refused {key}'s Confirm delivery" + (f" {presses} times" if presses > 1 else "") + f"{words}. "
                               f"Nothing was booked (no trip under way to {c.get('dropoff')}), and {state}. The tab is still open, "
                               "so confirm again once it's fixed, or stage it again for another option.")
        update(key, status="unknown", mended=mended or None)
        raise CourierError(f"Pressed Confirm delivery for {key}, but Uber showed no trip within 40 s (it shows: "
                           f"{got.get('text', '')[:200]!r}); check Uber's Activity before pressing again")
    c = update(key, status="booked", trip=trip, booked_at=now_ms(), total=rv["total"], fare=rv["fare"], tip=rv["tip"],
               mended=mended or None, presses=presses, refused=None, booked_by=by or c.get("staged_by"), source="booked here")
    health["booked"] += 1
    if mended:
        health["mended"] += 1
    health["last"] = {"delivery": key, "status": "booked", "at": c["booked_at"]}
    health["last_error"] = None
    live = {}
    try:
        trips = survey([trip], past=0)
        t = next((x for x in trips if x["uuid"] == trip), None)
        if t:
            live = view(apply(t)[1])
    except CourierError:
        pass  # the watcher reads it in a minute
    return handed({"delivery": key, "status": "booked", "booked": True, "trip": trip, "total": rv["total"], "fare": rv["fare"], "tip": rv["tip"],
                   "customer": c["customer"], "dropoff": c["dropoff"],
                   **{k: live.get(k) for k in ("stage", "driver", "car", "plate", "dropoff_eta") if live.get(k)},
                   **({"mended": mended} if mended else {}), "presses": presses,
                   "summary": f"Booked {c.get('product')} for {key} to {c['customer']}: ${rv['total']:.2f}, trip {trip}."
                              + (f" {live['stage']}." if live.get("stage") else "")
                              + (f" Filled {', '.join(mended)}, blank on Uber's form" + (", and pressed once more after Uber refused" if presses > 1 else "")
                                 + "." if mended else "")
                              + " " + RUNS_ITSELF, "after": RUNS_ITSELF}, None)


# ---------------------------------------------------------------------------------------------
# Uber's own record of its trips: riders.uber.com's GraphQL (the queries its Activity page sends). One read answers
# every courier on the account, booked here or by hand: the trips under way and the latest ones past, the live driver,
# car, plate and ETAs, and each trip's own pickup and drop-off times and addresses. Each courier trip is matched to a
# delivery staged here by its drop-off address.

RIDERS = "https://riders.uber.com/trips"
TRIPS_SESSION = f"{NAME}-uber-trips"
ACTIVITIES_Q = ("query Activities($limit: Int = 5) { activities { ongoing { activities { uuid title subtitle description } } "
                "past(limit: $limit, orderTypes: [RIDES, TRAVEL], profileType: PERSONAL) { activities { uuid title subtitle description } } } }")
STATUS_Q = ("query GetStatus($latitude: Float!, $longitude: Float!) { status(latitude: $latitude, longitude: $longitude) { trip { ...T } trips { ...T } } } "
            "fragment T on RVWebCommonTrip { uuid clientStatus isConnect eta etaStringShort etaToDestination fareString "
            "driver { name rating status } vehicle { colorTranslatedName make model licensePlate description } statusMessage { title subtitle } "
            "waypoints { type title subtitle etaInSeconds coordinate { latitude longitude } } }")
TRIP_Q = ("query GetTrip($tripUUID: String!) { getTrip(tripUUID: $tripUUID) { trip { uuid status beginTripTime dropoffTime driver fare "
          "isConnectTrip waypoints } } }")
READ_TRIPS = r"""
if (location.host !== 'riders.uber.com') return {signed_in: false, url: location.href};
const gql = async (operationName, variables, query) => {
  try {
    const r = await fetch('/graphql', {method: 'POST', credentials: 'include',
      headers: {'content-type': 'application/json', 'x-csrf-token': 'x'}, body: JSON.stringify({operationName, variables, query})});
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return {errors: [{message: 'HTTP ' + r.status + ': ' + t.slice(0, 160)}]}; }
  } catch (e) { return {errors: [{message: String(e)}]}; }
};
const [a, s] = await Promise.all([gql('Activities', {limit: __LIMIT__}, __A__), gql('GetStatus', {latitude: 0, longitude: 0}, __S__)]);
const said = [a, s].flatMap(x => (x.errors || []).map(e => String(e.message)));
if (!a.data && said.some(m => /unauth|log ?in|authenticat|forbidden|HTTP 40[13]/i.test(m))) return {signed_in: false, url: location.href, errors: said};
const acts = ((a.data || {}).activities) || {};
const ongoing = (acts.ongoing || {}).activities || [];
const past = (acts.past || {}).activities || [];
const st = ((s.data || {}).status) || {};
const live = [...(st.trips || []), ...(st.trip ? [st.trip] : [])];
const ids = [...new Set([...ongoing.map(x => x.uuid), ...live.map(x => x.uuid), ...__FOLLOW__, ...past.slice(0, __PAST__).map(x => x.uuid)].filter(Boolean))];
const got = await Promise.all(ids.map(id => gql('GetTrip', {tripUUID: id}, __G__)));
const details = {};
ids.forEach((id, i) => { const d = ((got[i].data || {}).getTrip || {}).trip; details[id] = d || {error: ((got[i].errors || [])[0] || {}).message || 'no trip'}; });
return {signed_in: true, ongoing, past, live, details, errors: said.slice(0, 4)};
"""


def read_script(follow=(), past=5):
    return (READ_TRIPS.replace("__A__", json.dumps(ACTIVITIES_Q)).replace("__S__", json.dumps(STATUS_Q)).replace("__G__", json.dumps(TRIP_Q))
            .replace("__LIMIT__", str(max(int(past), 3))).replace("__PAST__", str(int(past))).replace("__FOLLOW__", json.dumps(list(follow))))


def riders_read(follow=(), past=5):
    """Reads Uber's trips in a tab kept at riders.uber.com between reads; asks the user to sign in when it isn't."""
    tab = Tab(TRIPS_SESSION)
    try:
        here = tab.js("return location.href") or ""
    except CourierError:
        here = ""
    if not str(here).startswith("https://riders.uber.com/"):
        tab.navigate(RIDERS)
    raw = tab.ajs(read_script(follow, past), timeout=40)
    signed = bool(raw and isinstance(raw, dict) and raw.get("signed_in"))
    health["riders"] = {"signed_in": signed, "at": now_ms()}
    if not signed:
        tab.release()
        raise signed_out()
    health["trips_tab"] = True
    health["read_at"] = now_ms()
    return raw


def release_trips_tab():
    if health.get("trips_tab"):
        Tab(TRIPS_SESSION).release()
        health["trips_tab"] = False


def uber_time(text):
    """Uber's 'Tue Nov 17 2026 06:26:57 GMT+0000 (Coordinated Universal Time)' as epoch ms, or None."""
    m = re.match(r"\w{3} (\w{3}) (\d{1,2}) (\d{4}) (\d\d:\d\d:\d\d) GMT([+-]\d{4})", text or "")
    if not m:
        return None
    return int(datetime.strptime(" ".join(m.groups()), "%b %d %Y %H:%M:%S %z").timestamp() * 1000)


def when_words(ms, now=None):
    """'10:43 PM' today, else 'Nov 16, 10:43 PM'."""
    if not ms:
        return None
    t = local_time(ms)
    return clock(t) if t.date() == local_time(now or now_ms()).date() else f"{t.strftime('%b')} {t.day}, {clock(t)}"


def tidy_address(text):
    """Uber's '425 Park Ave, Springfield, CA 91340-6825, USA' as '425 Park Ave, Springfield, CA'."""
    text = re.sub(r",\s*(USA|United States)$", "", (text or "").strip())
    return re.sub(r"\s+\d{5}(-\d{4})?$", "", text) or None


def minute(ms):
    """An estimate to the minute, so a trip read every minute doesn't change on every read."""
    return int(round(ms / 60000) * 60000) if ms else None


def person(name):
    name = (name or "").strip()
    return (name.title() if name.isupper() else name) or None


ARRIVING = re.compile(r"pickup (in|at )?\s*\d|be ready|arriv|picking up|on (his|her|their|the) way to (you|pick)|heading to (you|pick)", re.I)
DELIVERING = re.compile(r"heading to deliver|deliver(ing)? (the |your )?package|on (its|the) way to|drop-?off (at |in |\d)", re.I)
NOT_FOUND = re.compile(r"couldn't find|could not find|no (couriers?|drivers?) (are )?available|unable to find|wasn't able to", re.I)
CLIENT_PHASE = {"waitingforpickup": "to_pickup", "accepted": "to_pickup", "arriving": "to_pickup", "driverarrived": "to_pickup",
                "ontrip": "to_dropoff", "enroute": "to_dropoff", "intransit": "to_dropoff", "delivering": "to_dropoff",
                "dispatching": "finding", "looking": "finding", "searching": "finding", "matching": "finding"}
"""Uber's status's clientStatus, as a phase; any it doesn't know falls to Uber's words."""
NO_PLATE = {"OTHER", "UNKNOWN", "NONE", "NULL", "NA", "N/A", "TBD", "TEMP", "-", "--", "?"}


def real_plate(plate):
    """A plate Uber gave, or None for its placeholders (a courier whose plate Uber doesn't know shows "OTHER")."""
    p = re.sub(r"\s+", " ", str(plate or "")).strip().upper()
    if not p or p in NO_PLATE or not re.search(r"[A-Z0-9]", p) or len(p) > 9:
        return None
    return p


def trip_of(uuid, live, activity, detail, ongoing, now):
    """One trip, from what Uber's three queries said of it: where it stands (phase: finding, to_pickup, to_dropoff,
    delivered, canceled), Uber's words, the driver, car and plate, the addresses, the ETAs and the times it happened."""
    live, activity = live or {}, activity or {}
    d = {} if detail.get("error") else detail
    status = (d.get("status") or "").upper()
    words = " · ".join(x for x in (activity.get("title"), activity.get("subtitle"), activity.get("description"),
                                   (live.get("statusMessage") or {}).get("title"), (live.get("statusMessage") or {}).get("subtitle")) if x)
    stops = d.get("waypoints") or []
    points = live.get("waypoints") or []
    drop_point = next((w for w in reversed(points) if "PICK" not in str(w.get("type") or "").upper()), None) if points else None
    pick_point = next((w for w in points if "PICK" in str(w.get("type") or "").upper()), points[0] if len(points) > 1 else None)
    said_at = re.search(r"(?:deliver|drop-?off|heading to)[^·]*? at ([^·]+)", words, re.I)
    if len(stops) > 1:
        dropoff = tidy_address(stops[-1])
    elif drop_point and drop_point.get("title"):
        dropoff = ", ".join(x for x in (drop_point.get("title"), drop_point.get("subtitle")) if x)
    elif said_at:
        dropoff = said_at.group(1).strip()
    elif not ongoing and activity.get("title") and re.match(r"\d", activity["title"]):
        dropoff = activity["title"]
    else:
        dropoff = None
    coord = (drop_point or {}).get("coordinate") or {}
    driver = person((live.get("driver") or {}).get("name") or d.get("driver"))
    v = live.get("vehicle") or {}
    car = " ".join(x for x in (v.get("colorTranslatedName"), v.get("make"), v.get("model")) if x) or v.get("description") or None
    is_live = bool(ongoing or live) and status not in ("COMPLETED",) and "CANCEL" not in status
    begin, end = uber_time(d.get("beginTripTime")), uber_time(d.get("dropoffTime"))
    if status == "COMPLETED":
        phase = "delivered"
    elif "CANCEL" in status or "UNFULFILL" in status or (status in ("FAILED", "EXPIRED") and not is_live):
        phase = "canceled"
    elif is_live and CLIENT_PHASE.get(str(live.get("clientStatus") or "").lower().replace("_", "")):
        phase = CLIENT_PHASE[str(live["clientStatus"]).lower().replace("_", "")]
        if phase == "finding" and driver:
            phase = "to_pickup"
    elif is_live:
        if DELIVERING.search(words) and not re.search(r"pickup in\s*\d", words, re.I) or status in ("ON_TRIP", "BEGIN_TRIP", "IN_PROGRESS", "STARTED"):
            phase = "to_dropoff"
        elif driver or ARRIVING.search(words):
            phase = "to_pickup"
        else:
            phase = "finding"
    else:
        phase = "delivered" if end else "ended"
    drop_s, pick_s = (drop_point or {}).get("etaInSeconds"), (pick_point or {}).get("etaInSeconds")
    dropoff_at = minute(now + int(drop_s) * 1000 if drop_s is not None and phase in ("to_pickup", "to_dropoff") else
                        dropoff_epoch(words, now) if phase in ("to_pickup", "to_dropoff") and re.search(r"drop-?off", words, re.I) else None)
    if drop_s is None and live.get("etaToDestination") is not None and phase in ("to_pickup", "to_dropoff"):
        drop_s = live["etaToDestination"]
        dropoff_at = minute(now + int(drop_s) * 1000)
    pick_m = re.search(r"pickup in\s*(\d+)\s*min", words, re.I)
    pick_min = live.get("eta") if isinstance(live.get("eta"), (int, float)) else None
    pickup_at = minute(now + int(pick_s) * 1000 if pick_s is not None and phase == "to_pickup" else
                       now + int(pick_min) * 60000 if pick_min is not None and phase == "to_pickup" else
                       now + int(pick_m.group(1)) * 60000 if pick_m and phase == "to_pickup" else None)
    picked_up_at = begin if phase in ("to_dropoff", "delivered") else None
    delivered_at = end if phase == "delivered" else None
    who = driver or "The courier"
    stage = {"finding": "Uber is finding a courier" + (" (it says it can't find one)" if NOT_FOUND.search(words) else ""),
             "to_pickup": f"{who} is on the way to pick up" + (f", about {when_words(pickup_at, now)}" if pickup_at else ""),
             "to_dropoff": "Picked up" + (f" {when_words(picked_up_at, now)}" if picked_up_at else "")
                           + (f", drop-off about {when_words(dropoff_at, now)}" if dropoff_at else ", on the way to drop-off"),
             "delivered": "Delivered" + (f" {when_words(delivered_at, now)}" if delivered_at else ""),
             "canceled": "Canceled" + ("" if driver else " before any courier took it"),
             "ended": "Uber no longer shows it under way"}[phase]
    return {"uuid": uuid, "live": is_live, "connect": bool(d.get("isConnectTrip") or live.get("isConnect") or re.search(r"\bpackage\b|courier", words, re.I)),
            "phase": phase, "stage": stage, "uber_says": words or None, "uber_status": status or live.get("clientStatus") or None,
            "driver": driver, "car": car, "plate": real_plate(v.get("licensePlate")), "pickup": tidy_address(stops[0]) if len(stops) > 1 else None,
            "dropoff": dropoff, "dropoff_lat": coord.get("latitude"), "dropoff_lng": coord.get("longitude"),
            "pickup_at": pickup_at, "dropoff_at": dropoff_at, "picked_up_at": picked_up_at, "delivered_at": delivered_at,
            "fare": d.get("fare") or live.get("fareString") or (dollars(activity.get("description")) and activity.get("description").split("•")[0].strip()) or None,
            "ended_at": end or (now if phase == "canceled" else None), "missing": bool(detail.get("error"))}


def parse_trips(raw, now=None):
    """Every trip in one read of READ_TRIPS, under way first."""
    now = now or now_ms()
    ongoing = {a["uuid"]: a for a in raw.get("ongoing") or [] if a.get("uuid")}
    past = {a["uuid"]: a for a in raw.get("past") or [] if a.get("uuid")}
    live = {t["uuid"]: t for t in raw.get("live") or [] if t.get("uuid")}
    details = raw.get("details") or {}
    trips = [trip_of(u, live.get(u), ongoing.get(u) or past.get(u), details.get(u) or {}, u in ongoing, now)
             for u in dict.fromkeys([*live, *ongoing, *details])]
    return sorted(trips, key=lambda t: (not t["live"], -(t["delivered_at"] or t["picked_up_at"] or now)))


SUFFIXES = {"st", "ave", "blvd", "dr", "rd", "pl", "ln", "ct", "ter", "pkwy", "cir", "hwy", "n", "s", "e", "w"}


def street_key(text):
    """A street address's (house number, name words): '3400D Main Blvd West' and '3400 Main Blvd W' are one door."""
    words = norm_street((text or "").split(",")[0]).split()
    m = re.match(r"(\d+)", words[0]) if words else None
    if not m:
        return None
    return m.group(1), set(w for w in words[1:] if w not in SUFFIXES) or set(words[1:])


def zip_of(text):
    m = re.search(r"\b(\d{5})(?:-\d{4})?\b", ",".join((text or "").split(",")[1:]))
    return m.group(1) if m else None


def same_door(c, trip):
    """Whether a trip's drop-off is this delivery's: the same house number and street (and ZIP when both say), or,
    when Uber gives only a pin, within 80 m of the drop-off staged."""
    ok, tk = street_key(c.get("dropoff")), street_key(trip.get("dropoff"))
    if ok and tk:
        if ok[0] != tk[0] or not ok[1] & tk[1]:
            return False
        oz, tz = zip_of(c.get("dropoff")), zip_of(trip.get("dropoff"))
        return not (oz and tz and oz != tz)
    if c.get("drop_lat") is not None and trip.get("dropoff_lat") is not None:
        return meters(c["drop_lat"], c["drop_lng"], trip["dropoff_lat"], trip["dropoff_lng"]) <= 80
    return False


def match_delivery(trip, deliveries, now=None):
    """The staged delivery a courier trip is for, by its drop-off: of those staged here before the trip and not yet
    holding another trip, the newest at the same door."""
    t0 = trip.get("picked_up_at") or trip.get("delivered_at") or now or now_ms()
    hits = [c for c in deliveries.values() if c.get("status") in ("staged", "unknown", "booked") and not c.get("trip")
            and (c.get("staged_at") or 0) <= t0 and same_door(c, trip)]
    hits.sort(key=lambda c: -(c.get("staged_at") or 0))
    return hits[0] if hits else None


_paged = set()
"""Trips whose page was read for a car and plate the status lacked: once each."""


def trip_page(uuid):
    """The driver, car and plate as Uber's own trip page shows them, for a trip under way whose status didn't carry
    its vehicle; {} when it shows none."""
    tab = Tab(f"{NAME}-uber-trip-page")
    try:
        tab.navigate(f"https://m.uber.com/go/on-trip?trip_uuid={uuid}")
        got = tab.until("const m = document.querySelector('main'); return m && m.innerText.trim() ? "
                        "{path: location.pathname, trip: new URLSearchParams(location.search).get('trip_uuid'), lines: m.innerText.split('\\n').map(s => s.trim()).filter(Boolean)} : null",
                        15, what="the trip")
    except CourierError:
        return {}
    finally:
        tab.release()
    lines = got.get("lines") or []
    plate = next((line for line in lines[:10] if re.fullmatch(r"[A-Z0-9]{5,8}", line) and re.search(r"\d", line)
                  and re.search(r"[A-Z]", line) and real_plate(line)), None)
    if not plate:
        return {}
    i = lines.index(plate)
    name = lines[i + 2] if i + 2 < len(lines) and not lines[i + 2].startswith("Send") else None
    return {"plate": plate, "car": lines[i + 1] if i + 1 < len(lines) else None, "driver": person(name)}


def survey(follow=(), past=5, only=None):
    """Every courier trip Uber shows (under way, the latest past ones and those followed), each with the delivery it's
    for ('delivery' and 'source') when one matches. A trip under way whose status had no car gets it from its trip
    page, once."""
    with _trips_lock:
        raw = riders_read(follow, past)
    trips = [t for t in parse_trips(raw) if t["connect"] or t["uuid"] in follow]
    deliveries = load_state()["deliveries"]
    mine = {c["trip"]: c for c in deliveries.values() if c.get("trip")}
    for t in trips:
        c = mine.get(t["uuid"])
        if c:
            t.update(delivery=c["delivery"], source=c.get("source") or "booked here", customer=c.get("customer"))
            continue
        c = match_delivery(t, deliveries)
        if c:
            t.update(delivery=c["delivery"], source="found in Uber", customer=c.get("customer"))
    for t in trips:
        known = mine.get(t["uuid"]) or {}
        if (t.get("delivery") and (only is None or t["delivery"] == only) and t["phase"] in ("to_pickup", "to_dropoff") and not t["plate"]
                and not known.get("plate") and t["uuid"] not in _paged):
            _paged.add(t["uuid"])
            t.update({k: v for k, v in trip_page(t["uuid"]).items() if v and not (k == "driver" and t["driver"])})
    return trips


TRIP_FACTS = ("phase", "stage", "uber_says", "driver", "car", "plate", "pickup_at", "dropoff_at", "picked_up_at", "delivered_at", "source")


def apply(t):
    """Writes what a read found of a delivery's courier trip onto uber-courier:<delivery>; answers (before, after)."""
    before = load_state()["deliveries"].get(t["delivery"]) or {}
    facts = {k: t.get(k) for k in TRIP_FACTS if t.get(k) is not None and t.get(k) != before.get(k)}
    if before.get("plate") and not real_plate(before["plate"]):
        facts["plate"] = None
    if t.get("dropoff_at") and t["phase"] in ("to_pickup", "to_dropoff"):
        facts["dropoff_eta"] = when_words(t["dropoff_at"])
    if t.get("pickup_at") and t["phase"] == "to_pickup":
        facts["pickup_minutes"] = max(0, round((t["pickup_at"] - now_ms()) / 60000))
    elif t["phase"] != "to_pickup" and before.get("pickup_minutes") is not None:
        facts["pickup_minutes"] = None
    if t["phase"] == "to_dropoff" and not t.get("picked_up_at") and not before.get("picked_up_at"):
        facts["picked_up_at"] = minute(now_ms())
    facts = {k: v for k, v in facts.items() if v != before.get(k)}
    if before.get("trip") != t["uuid"]:
        facts.update(trip=t["uuid"], source=t.get("source"), found_at=now_ms(), driver_told=False, ended_at=None, ending_seen=None,
                     ended_seen_at=None, flagged=None, stage=t["stage"])
        if t.get("source") == "found in Uber" and before.get("pressed_at") and before.get("status") in ("staged", "unknown"):
            facts.update(status="booked", source="booked here", booked_at=now_ms())
        elif t.get("source") == "found in Uber":
            facts.update(status="booked", booked_at=now_ms())
    if t["phase"] in ("delivered", "canceled") and before.get("status") != t["phase"]:
        facts.update(status=t["phase"], ended_at=t.get("ended_at") or now_ms(), ended_seen_at=now_ms())
        if t["phase"] == "delivered" and t.get("fare"):
            facts["fare_paid"] = t["fare"]
    elif t["phase"] == "ended" and not before.get("ended_at"):
        # A followed trip Uber stopped showing without saying how: believed only on the second read.
        if before.get("ending_seen"):
            facts.update(ended_at=now_ms(), status="ended", ended_seen_at=now_ms())
        else:
            facts["ending_seen"] = now_ms()
    if not facts:
        return before, dict(before)
    return before, update(t["delivery"], **facts)


_tell_lock = threading.Lock()


def car_words(c):
    """'Sam in a Gray Toyota RAV4, plate 8ABC123' (or 'no plate in Uber' when Uber has none for it)."""
    if not c.get("driver"):
        return ""
    car = f" in a {c['car']}" if c.get("car") else ""
    plate = f", plate {c['plate']}" if c.get("plate") else (", no plate in Uber" if c.get("car") else "")
    return f"{c['driver']}{car}{plate}"


def driver_words(c):
    """The one message about a courier's driver: (title, text), with the delivery and street so the right box goes
    to the right car."""
    first = (c.get("customer") or "the recipient").split()[0]
    street = (c.get("dropoff") or "").split(",")[0]
    when = []
    if c.get("phase") == "to_pickup" and c.get("pickup_minutes") is not None:
        when.append(f"pickup in about {c['pickup_minutes']} min")
    if c.get("dropoff_eta"):
        when.append(f"drop-off about {c['dropoff_eta']}")
    late = ""
    if c.get("promised_by") and c.get("dropoff_at") and c["dropoff_at"] > c["promised_by"] + 60000:
        late = f" (promised by {when_words(c['promised_by'])})"
    text = f"{c['delivery']}{' to ' + street if street else ''}: {car_words(c)}" + (", " + ", ".join(when) if when else "") + late + "."
    return f"{first}'s courier: {c['driver']}", text


def claim_telling(key, by):
    """Whoever first learns a courier's driver tells the user, once: the watcher by an event, or the work whose call
    answered it first. Answers the courier when this caller is the one to tell, else None."""
    with _tell_lock:
        c = load_state()["deliveries"].get(key) or {}
        if not c.get("driver") or c.get("driver_told") or c.get("status") != "booked" or c.get("phase") not in ("to_pickup", "to_dropoff"):
            return None
        return update(key, driver_told=by, driver_told_at=now_ms())


def handed(out, by):
    """A track, wait or confirm answer for a work (by): whether the user has heard of this courier's driver, and if
    this answer is the first to carry it, the words for the work to tell them itself."""
    if not out.get("delivery") or not by:
        return out
    c = claim_telling(out["delivery"], by)
    if c:
        title, text = driver_words(c)
        out.update(tell_user={"title": title, "text": text},
                   summary=out.get("summary", "") + " The user hasn't been told this driver: tell them yourself (the watcher won't).")
        return out
    c = load_state()["deliveries"].get(out["delivery"]) or {}
    if c.get("driver_told") and c.get("driver"):
        how = "by the watcher" if c["driver_told"] in ("watcher", True) else f"by {c['driver_told']}"
        at = f" at {when_words(c['driver_told_at'])}" if c.get("driver_told_at") else ""
        out["user_told"] = f"{how}{at}"
        out["summary"] = out.get("summary", "") + f" The user already has the driver ({how}{at}): don't tell them again."
    return out


def view(c):
    """A delivery's courier as track and wait answer it."""
    keys = ("delivery", "customer", "dropoff", "status", "phase", "stage", "driver", "car", "plate", "dropoff_eta", "pickup_minutes",
            "trip", "source", "product", "total", "fare_paid", "uber_says", "flagged")
    out = {k: c.get(k) for k in keys if c.get(k) is not None and not (k in ("dropoff_eta", "pickup_minutes") and c.get("status") != "booked")}
    for k in ("picked_up_at", "delivered_at"):
        if c.get(k):
            out[k] = c[k]
            out[k.replace("_at", "")] = when_words(c[k])
    if c.get("dropoff_at") and c.get("status") == "booked":
        out["dropoff_at"] = c["dropoff_at"]
    street = (c.get("dropoff") or "").split(",")[0]
    first = (c.get("customer") or "").split(" ")[0]
    who = f" ({', '.join(x for x in (first, street) if x)})" if first or street else ""
    car = f"; {car_words(c)}" if c.get("driver") else ""
    out["summary"] = f"{c['delivery']}{who}: {c.get('stage') or c.get('status')}{car}."
    return out


def runs_itself(out):
    if out.get("status") in ("staged", "booked"):
        out["after"] = RUNS_ITSELF
    return out


def courier_of(key, trips):
    """The trip for this delivery among a survey's: the one under way, else the latest."""
    mine = [t for t in trips if t.get("delivery") == key]
    return next((t for t in mine if t["live"]), None) or max(mine, key=lambda t: t["delivered_at"] or t["picked_up_at"] or 0, default=None)


def lookup(key, past=8):
    """Reads Uber for this delivery's courier and records what it finds; answers its view, or found: false."""
    c = load_state()["deliveries"].get(key)
    if not c:
        raise CourierError(f"There's no delivery {key} staged here")
    trips = survey([c["trip"]] if c.get("trip") else [], past, only=key)
    t = courier_of(key, trips)
    if t:
        return view(apply(t)[1])
    return {**view(c), "found": False}


@app.tool(name="track", read_only=True, schema={"type": "object", "properties": {
    "delivery": {"type": "string", "description": "A delivery's key: its courier. Leave it out for every courier under way now, and those that ended in the last 6 hours."}}})
def track(delivery: str = "", ctx=None):
    """Where a delivery's Uber courier is now, read live from Uber (riders.uber.com, in the user's browser): finding a
    courier, on the way to pick up (driver, car, plate, pickup time), picked up (when, and the drop-off ETA), delivered
    (Uber's own drop-off time) or canceled. Without delivery: every courier trip under way on the account, each with the
    delivery it's for (matched by drop-off address), which car is for which box. The user hears of each driver once:
    when this answer is the first to carry one it has tell_user, and telling them is the caller's."""
    health["calls"] += 1
    try:
        by = getattr(ctx, "work", None)
        if delivery:
            return runs_itself(handed(lookup(delivery_key(delivery)), by))
        live = [c["trip"] for c in load_state()["deliveries"].values() if c.get("trip") and not c.get("ended_at")]
        trips = survey(live, past=6)
        recent = [t for t in trips if t["live"] or (t.get("ended_at") or 0) > now_ms() - 6 * 3600000]
        out = [handed(view(apply(t)[1]), by) for t in recent if t.get("delivery")]
        loose = [{"trip": t["uuid"], "dropoff": t["dropoff"], "stage": t["stage"], "driver": t["driver"], "car": t["car"], "plate": t["plate"],
                  "summary": f"Not staged here ({t.get('dropoff') or 'no address'}): {t['stage']}"}
                 for t in recent if not t.get("delivery") and t["live"]]
        lines = [c["summary"] for c in out] + [x["summary"] for x in loose]
        return {"couriers": out, "other_trips": loose,
                "summary": "\n".join(lines) if lines else "No Uber courier is under way, and none ended in the last 6 hours."}
    except Exception as e:
        health["failed"] += 1
        health["last_error"] = f"track {delivery}: {e}"[:400]
        raise


UNTIL = {"driver": lambda c: bool(c.get("driver")) or c.get("phase") in ("to_dropoff", "delivered"),
         "picked_up": lambda c: c.get("phase") in ("to_dropoff", "delivered"),
         "delivered": lambda c: c.get("phase") == "delivered"}


@app.tool(name="wait", read_only=True, schema={"type": "object", "required": ["delivery"], "properties": {
    "delivery": {"type": "string", "description": "The delivery's key."},
    "until": {"type": "string", "enum": ["driver", "picked_up", "delivered", "change"], "description":
              "What to wait for: a courier assigned (driver), the box picked up, delivered (default), or any change of where it stands."},
    "minutes": {"type": "number", "description": "The most to wait (default 30, at most 120)."}}})
def wait(delivery: str, until: str = "delivered", minutes: float = 30, ctx=None):
    """Wait on a delivery's Uber courier until it reaches something: a driver assigned, the box picked up, delivered,
    or any change. Only for a step of the caller's own: the driver's report and the surprises happen without anyone
    waiting. Reads Uber every 30 s to 2 min, says each step as it goes, and answers early when it's canceled or
    nothing is booked."""
    key = delivery_key(delivery)
    if until not in ("driver", "picked_up", "delivered", "change"):
        raise CourierError("until is driver, picked_up, delivered or change")
    start = now_ms() / 1000
    end = start + max(0.5, min(float(minutes or 30), 120)) * 60
    first, said = None, None
    while True:
        c = lookup(key)
        first = first or c
        waited = int(now_ms() / 1000 - start)
        by = getattr(ctx, "work", None)
        if c.get("found") is False and until != "change":
            return {**c, "reached": False, "until": until, "waited_s": waited}
        reached = UNTIL[until](c) if until in UNTIL else any(c.get(k) != first.get(k) for k in ("phase", "driver", "found"))
        if reached or c.get("phase") in ("canceled", "ended", "delivered"):
            return runs_itself(handed({**c, "reached": bool(reached), "until": until, "waited_s": waited}, by))
        if ctx is not None and c["summary"] != said:
            said = c["summary"]
            ctx.progress(said)
        if now_ms() / 1000 >= end:
            return runs_itself(handed({**c, "reached": False, "until": until, "waited_s": waited,
                                       "summary": c["summary"] + f" (still not {until.replace('_', ' ')} after {waited // 60} min)"}, by))
        time.sleep(max(5, min(next_read_s(c), end - now_ms() / 1000)))


def next_read_s(c, now=None):
    """How long until a courier's trip is worth reading again."""
    now = now or now_ms()
    if c.get("phase") in ("finding",) or not c.get("driver"):
        return WATCH_S
    eta = c.get("dropoff_at") if c.get("phase") == "to_dropoff" else c.get("pickup_at")
    if not eta:
        return 60
    return max(30, min(120, (eta - now) / 3000))


LATE_S = float(os.environ.get("ERRANDS_UBER_LATE_S") or 300)
"""How long past the promise a courier still on the road is a surprise."""


def flag(c, kind, headline, text, now):
    """One surprise about this courier, once per kind (no_dropoff, late), to the work that booked it; answers the courier."""
    work = c.get("booked_by") or c.get("staged_by")
    body = {"headline": headline[:80], "text": text, "severity": "medium", "part": f"{NAME}.uber"}
    if work:
        body["work"] = work
    app.emit("uber_surprise", body, about=[f"uber-courier:{c['delivery']}"])
    health["flagged"] = health.get("flagged", 0) + 1
    return update(c["delivery"], flagged={**(c.get("flagged") or {}), kind: now})


def ended_badly(c, before, now):
    """A surprise, once, for a booked courier that ended without a drop-off."""
    if c.get("status") not in ("canceled", "ended") or before.get("status") == c.get("status") or "no_dropoff" in (c.get("flagged") or {}):
        return c
    first = (c.get("customer") or "the recipient").split()[0]
    held = (f" {c['driver']} had picked it up, so the box may still be in that car." if c.get("picked_up_at") else
            f" {c['driver']} hadn't picked it up yet." if c.get("driver") else " No courier had taken it.")
    how = "canceled" if c["status"] == "canceled" else "gone from Uber's trips without a drop-off"
    return flag(c, "no_dropoff", f"{c['delivery']}'s courier ended without a drop-off",
                f"Uber shows {first}'s courier for {c['delivery']} {how} ({c.get('stage') or c['status']}).{held} "
                "Check Uber's Activity for what happened; stage another courier if it still needs to go.", now)


def overdue(c, now=None):
    """A surprise, once, for a booked courier still on the road LATE_S past its promise (not one staged already
    landing past it: the user approved that knowing)."""
    now = now or now_ms()
    if (c.get("status") != "booked" or not c.get("promised_by") or now < c["promised_by"] + LATE_S * 1000
            or "late" in (c.get("flagged") or {}) or c.get("late")):
        return c
    first = (c.get("customer") or "the recipient").split()[0]
    eta = f", drop-off about {c['dropoff_eta']}" if c.get("dropoff_eta") else ""
    return flag(c, "late", f"{c['delivery']}'s courier is past the promise",
                f"{c['delivery']}'s courier to {first} is still on the road {round((now - c['promised_by']) / 60000)} min past the promise "
                f"({when_words(c['promised_by'])}): Uber shows {c.get('stage') or 'it under way'}{eta}.", now)


def watch_once(force=False):
    """One round of the watcher: reads Uber while a courier booked here is under way (or a press's outcome is
    unknown); records each change, reports the driver once, and flags one that ends without a drop-off or runs late.
    Reads nothing (and lets its tab go) while there's nothing to watch. Never books or cancels."""
    now = now_ms()
    if not force and now < health.get("watch_next", 0):
        return
    st = load_state()["deliveries"]
    follow = {c["trip"]: c for c in st.values() if c.get("trip") and c.get("status") == "booked" and not c.get("ended_at")
              and now - (c.get("booked_at") or c.get("found_at") or c.get("updated_at") or 0) < 10 * 3600000}
    hunt = [c["delivery"] for c in st.values() if c.get("status") == "unknown" and now - (c.get("pressed_at") or 0) < 2 * 3600000]
    if not follow and not hunt:
        release_trips_tab()
        health["watch_next"] = now + 60000
        return
    try:
        trips = survey(list(follow), past=3 if hunt else 0)
    except CourierError as e:
        health["watch_error"] = str(e)[:300]
        health["watch_next"] = now + 120000
        return
    health["watch_error"] = None
    waits = [120] if hunt else []
    for t in trips:
        if not t.get("delivery") or not (t["uuid"] in follow or t["live"] or t["delivery"] in hunt):
            continue
        before, c = apply(t)
        if c.get("status") == "booked":
            waits.append(next_read_s(c, now))
            c = overdue(c, now)
        else:
            c = ended_badly(c, before, now)
        mine = claim_telling(c["delivery"], "watcher") if c.get("driver") else None
        if mine:
            title, text = driver_words(mine)
            if not notify(title, text):
                update(mine["delivery"], driver_told=False, driver_told_at=None)  # the next round tries again
                continue
            app.emit("uber_driver", {"entity": f"uber-courier:{mine['delivery']}", "summary": text, "title": title,
                                     "facts": {k: mine.get(k) for k in ("delivery", "driver", "car", "plate", "dropoff_eta", "trip")}},
                     about=[f"uber-courier:{mine['delivery']}"])
    health["watch_next"] = now + int(min(waits or [WATCH_S]) * 1000)


@app.tool(name="discard", open_world=True, schema={"type": "object", "required": ["delivery"], "properties": {
    "delivery": {"type": "string", "description": "The delivery's key whose staged courier to drop."}}})
def discard(delivery: str):
    """Drop a staged courier that wasn't booked: lets its tab go and records it as discarded. Never touches a booked
    courier: cancelling one is the user's, in Uber."""
    health["calls"] += 1
    key = delivery_key(delivery)
    c = load_state()["deliveries"].get(key)
    if not c:
        raise CourierError(f"There's no courier staged for {key}")
    if c.get("status") == "unknown":
        t = live_trip_to(key)
        if t:
            apply(t)
            raise CourierError(f"{key}'s courier went in after all (trip {t['uuid']}); cancelling it is the user's, in Uber")
    elif c.get("status") in ("booked", "delivered", "canceled", "ended"):
        raise CourierError(f"{key}'s courier was booked (trip {c.get('trip')}); cancelling it is the user's, in Uber")
    if c.get("session"):
        Tab(c["session"]).release()
    update(key, status="discarded")
    return {"delivery": key, "status": "discarded", "summary": f"Dropped the staged courier for {key}; nothing was booked."}


@app.tool(name="status", read_only=True, schema={"type": "object", "properties": {
    "check": {"type": "boolean", "description": "Also open Uber in the browser now to see whether it's signed in (a few seconds)."}}})
def status(check: bool = False):
    """How the Uber errand is: whether the browser is signed in to Uber (as last seen, or now with check), the pickup
    configured, the couriers it staged, booked or found lately and where each stands, what the watcher follows, its
    calls, failures and last error."""
    if check:
        tab = Tab(f"{NAME}-uber-check")
        try:
            tab.navigate(f"{UBER}/home")
            tab.until("return document.readyState === 'complete' && document.querySelectorAll('a').length > 2", 15)
            health["signed_in"] = {"signed_in": bool(tab.js(SIGNED_IN)), "at": now_ms()}
            if health["signed_in"]["signed_in"]:
                session_live("uber")
            tab.navigate(RIDERS)
            health["riders"] = {"signed_in": bool(tab.js("return location.host === 'riders.uber.com'")), "at": now_ms()}
        except CourierError as e:
            health["signed_in"] = {"signed_in": None, "error": str(e)[:200], "at": now_ms()}
        finally:
            tab.release()
    try:
        pickup = pickup_cfg()["label"]
    except CourierError as e:
        pickup = str(e)
    st = load_state()
    recent = sorted(st["deliveries"].values(), key=lambda c: c.get("updated_at", 0), reverse=True)[:10]
    return {"health": dict(health), "pickup": pickup,
            "couriers": [{k: c.get(k) for k in ("delivery", "status", "stage", "source", "customer", "driver", "plate", "product", "total",
                                                 "dropoff_eta", "trip", "session", "updated_at") if c.get(k) is not None} for c in recent],
            "following": [c["delivery"] for c in st["deliveries"].values() if c.get("status") == "booked" and c.get("trip") and not c.get("ended_at")]}


def heartbeat():
    error = health["last_error"]
    following = [c["delivery"] for c in load_state()["deliveries"].values() if c.get("status") == "booked" and c.get("trip") and not c.get("ended_at")]
    summary = f"Last failed: {error}" if error else "Ready" + (f"; following {', '.join(following)}" if following else "")
    app.emit("heartbeat", {"entity": f"sense:{NAME}-uber", "summary": summary[:300], "facts": dict(health)})


@app.background
def beat():
    while True:
        heartbeat()
        time.sleep(HEARTBEAT_S)


@app.background
def watch():
    while os.environ.get("ERRANDS_UBER_WATCH") != "0":
        time.sleep(10)
        try:
            watch_once()
        except Exception as e:  # a bad round never takes the server down
            health["watch_error"] = f"{type(e).__name__}: {e}"[:300]


