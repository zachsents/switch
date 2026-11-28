"""amazon: the user's Amazon, through their own browser (signed in as them): buys again what they've bought before,
fills their cart with anything (bought before or never), and builds checkouts that stop before Place your order.

amazon_reorder takes an item (words from its title, its ASIN or link) or a past order, finds the purchase in the
order history, opens that exact variant's page (the ASIN bought, so a size or color can't drift), checks it's in
stock with Buy Now, presses Buy Now (a checkout of that item alone, so the rest of the cart stays out of it), sets
the address and card (config: address words and the card's last four), and checks the checkout line by line: one
item, that title, that quantity, no Subscribe & Save, the address, the card, and the total under a ceiling. Then it
either stops there, holding the checkout in its tab and handing back an approval (amazon_place presses Place your
order on it later), or, when asked to place, presses Place your order once and confirms the order on Your Orders.

For anything else, the cart: search finds products by words, specs reads up to a dozen products' own pages side
by side (brand, stars, seller and ships from, every variant with its ASIN, the bullets and every row of the spec
tables, lining up the specs asked for: an OD, a wall thickness, an rpm, a collet), offers lists who sells one,
cart_add puts any number of items in the cart in one call (the featured offer or a chosen seller's, through
Amazon's own add-to-cart form, each checked in the cart afterwards and tried again once), cart reads the cart, and
cart_remove takes off what it added. checkout builds a checkout of exactly the items asked (adding what's missing,
setting quantities, ticking only those lines in the cart and remembering how the rest were ticked), past Amazon's
"Need anything else?" page, with the address, card and delivery speed set, then reads every item's price, seller and
arrival date, checks it all, holds the tab and hands back an approval whose Approve runs amazon_place. place,
discard and an expiry put the cart's other lines back as they were ticked; discard also takes off what the checkout
itself added.

Each order is emitted as amazon-order:<number> (amazon_order), each checkout as amazon-checkout:<id>
(amazon_checkout), the cart as amazon-cart (amazon_cart).

How: the user's browser, through switch-ext-browser's tools (browser.py), one tab per checkout. Reading (order search,
order details, the cart, offers, search) fetches Amazon's own pages in that tab and reads them; the product page
and checkout are driven as a person would, Buy Now, Proceed to checkout and Place your order. Amazon's "I am human"
box (a checkbox and Continue) is ticked when config's tick_human_box allows it; any other human check, a sign-in or
a code is never worked around: the tab is left as it is and the answer hands back the ask to put up.
"""

import json
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

try:
    from zoneinfo import ZoneInfo
    PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:  # no tz database: Pacific standard time is close enough to say which day it is
    PACIFIC = timezone(timedelta(hours=-8))

import server
from server import BrowserError, app

PART = "amazon"
NAME = "amazon"
BASE = "https://www.amazon.com"
STREAM = "commerce/amazon"
READ_SESSION = f"{server.NAME}-amazon"
"""The tab find, order and item read in; each reorder gets a tab of its own (amazon-amazon-<id>)."""
BROWSER = "the user's browser"
PLACE_WAIT_S = 75
ORDERS_DECRYPT_S = 15
"""How long after Place your order it waits for the thank-you page before looking in Your Orders."""
CART_ENTITY = "amazon-cart"
EXPIRE_S = 1800

DEFAULTS = {
    "address": "",
    "card": "",
    "card_name": "",
    "ceiling_factor": 1.35,
    "tax_allowance": 1.11,
    "hold_hours": 24,
    "again_hours": 12,
    "tick_human_box": False,
}
"""What a reorder uses unless the home's config.json "amazon" key says otherwise. address is words that pick one
of Amazon's saved addresses; card the last four digits of the saved card (card_name what to call it). Without
max_total the most a reorder may come to is what the same items cost last time times ceiling_factor, times
tax_allowance for tax. A held checkout lasts hold_hours. again_hours is how long after an attempt of its own that
may have gone through it refuses the same item again unless again is true (an order of it Amazon shows from today
refuses too). tick_human_box: tick Amazon's "I am human" checkbox itself (only if the user allows it)."""

app.event("amazon_order", "An Amazon order this placed, and how it stands", stream=STREAM, kind="observation")
app.event("amazon_checkout", "An Amazon checkout it built and how it stands (waiting for the user, placed, discarded)",
          stream=STREAM, kind="observation")
app.event("amazon_cart", "The user's Amazon cart as it last read it (the lines, which are ticked for checkout)",
          stream=STREAM, kind="observation")

health = {"started_at": int(time.time() * 1000), "calls": 0, "failed": 0, "orders": 0, "checkouts": 0, "added": 0,
          "human_boxes": 0, "product_pages": 0, "last_error": None, "last_order": None, "last_blocked": None, "failing": None}
"""last_error is any call's (an item out of stock, too); failing only Amazon out of reach (Unreadable), until a read works."""


def failed(e):
    health["failed"] += 1
    health["last_error"] = f"{type(e).__name__}: {e}"[:400]
    if isinstance(e, Unreadable) and health["failing"] != health["last_error"]:
        health["failing"] = health["last_error"]
        heartbeat()


def reached():
    """A read of Amazon's pages worked: whatever had it out of reach is over."""
    if health["failing"]:
        health["failing"] = None
        heartbeat()
_busy = threading.Lock()
"""One checkout is driven at a time."""
_reading = threading.Lock()
"""The reading tab is shared by find, order and item."""
_state_lock = threading.Lock()


class ReorderError(Exception):
    """Something that stops a reorder, in words to pass on as they are."""


class Unreadable(ReorderError):
    """The browser couldn't be reached, or what Amazon's pages gave back couldn't be read: Amazon is out of reach, not a
    reorder refused (out of stock, over the price). It's the heartbeat's failing until a read works again."""


class Blocked(Exception):
    """Amazon put something only the user can do in the way: its human check, a sign-in, a code."""

    def __init__(self, kind, url="", words=""):
        super().__init__(kind)
        self.kind, self.url, self.words = kind, url, words


# ---------------------------------------------------------------------------------------------
# The world outside: the user's browser and time.


def browser(args, timeout=60):
    """One op in the user's browser (browser.py over switch-ext-browser). Answers its output; a script's answer as JSON
    text, as the readers parse it."""
    try:
        out = server.browser(PART).op(args, timeout)
    except BrowserError as e:
        raise Unreadable(f"The browser ({args.get('op')}): {str(e)[:300]}") from None
    if args.get("op") == "js" and isinstance(out, (dict, list, bool, int, float)):
        return json.dumps(out)
    return out


def pause(seconds):
    time.sleep(seconds)


def now_ms():
    return int(time.time() * 1000)


def today_pacific():
    return datetime.fromtimestamp(time.time(), PACIFIC).date()


# ---------------------------------------------------------------------------------------------
# What it keeps: config (overrides of DEFAULTS) and state (checkouts, orders, attempts).


def config():
    cfg = dict(DEFAULTS)
    cfg.update(server.config(PART))
    return cfg


def mine_or_set(cfg, address, card):
    """The address words and card's last four to use: the call's, else config's; refused when neither says."""
    address = address or cfg["address"]
    last4 = str(card or cfg["card"]).strip()[-4:]
    if not address or not last4:
        raise ReorderError("No address or card: give them, or set amazon.address and amazon.card in config.json")
    return address, last4


def load_state():
    st = server.load(PART)
    for key, empty in (("checkouts", {}), ("orders", []), ("attempts", []), ("blocked", []), ("added", []), ("human_boxes", [])):
        st.setdefault(key, empty)
    return st


def update_state(fn):
    with _state_lock:
        st = load_state()
        out = fn(st)
        st["orders"] = st["orders"][-100:]
        st["attempts"] = st["attempts"][-100:]
        st["blocked"] = st["blocked"][-20:]
        st["added"] = st["added"][-300:]
        st["human_boxes"] = st["human_boxes"][-30:]
        if len(st["checkouts"]) > 60:
            for key in sorted(st["checkouts"], key=lambda k: st["checkouts"][k].get("at", 0))[:-60]:
                del st["checkouts"][key]
        server.save(PART, st)
        return out


def progress(ctx, words):
    if ctx is not None:
        ctx.progress(words)


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def words_in(words, text):
    t = norm(text)
    return all(w in t for w in norm(words).split())


def money(s):
    m = re.search(r"-?\$\s*([\d,]+\.\d\d)", s or "")
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return -v if m.group(0).lstrip().startswith("-") else v


ASIN_RE = re.compile(r"(?:/dp/|/gp/product/|/gp/aw/d/|asin=)([A-Z0-9]{10})(?![A-Z0-9])")


def asin_of(item):
    """An ASIN from an ASIN, a product link, or None for words."""
    s = (item or "").strip()
    m = ASIN_RE.search(s)
    if m:
        return m.group(1)
    if re.fullmatch(r"B0[A-Z0-9]{8}|\d{9}[\dX]", s):
        return s
    return None


ORDER_RE = re.compile(r"\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b")


def amazon_date(s):
    try:
        return datetime.strptime(s.strip(), "%B %d, %Y").date()
    except (AttributeError, ValueError):
        return None


# ---------------------------------------------------------------------------------------------
# Reading Amazon's pages: each reader is a function of a page's document, run in the tab on the live
# page or on one fetched from Amazon in it. Every page is checked first for what only the user can do.

PAGE_HELPERS_JS = r"""
  const txt = (e) => e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const leaves = (e) => {
    if (!e) return [];
    const out = [], walk = e.ownerDocument.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const s = n.textContent.replace(/\s+/g, ' ').trim(); if (s) out.push(s); }
    return out;
  };
  const blocked = (d, url) => {
    const body = txt(d.body).slice(0, 30000);
    if (/\/checkpoint\/|validatecaptcha|\/errors\/validate/i.test(url) || d.querySelector('#captchacharacters, form[action*="validateCaptcha"]') ||
        /noticing unusual browser activity|Check the box to confirm you.re human|Enter the characters you see below|Type the characters you see in this image|solve this puzzle to protect your account/i.test(body))
      return (d.querySelector('form[action*="/checkpoint/validate"] input#continueCheck') && !d.querySelector('#captchacharacters, form[action*="validateCaptcha"]')) ? 'human_box' : 'human_check';
    if (/\/ap\/(signin|mfa|cvf|challenge|accountfixup)|\/ax\/claim/i.test(url) || d.querySelector('form[name="signIn"], #ap_password, #auth-mfa-otpcode, #cvf-input-code, input[name="otpCode"]')) return 'sign_in';
    if (/Hello, sign in/i.test(txt(d.querySelector('#nav-link-accountList-nav-line-1, #nav-link-accountList')))) return 'signed_out';
    return null;
  };
"""
"""What every reader's script starts with: txt and leaves (a node's words), and blocked (what only the user can do
on a page: Amazon's human check, a sign-in, signed out). No % in it: the scripts it opens are %-formatted."""

READ_JS = r"""/*amz:%(tag)s*/(() => { try {""" + PAGE_HELPERS_JS + r"""
  const X = %(reader)s;
  const path = %(path)s;
  let d, url, raw;
  if (path) {
    const x = new XMLHttpRequest(); x.open('GET', path, false); x.send();
    url = x.responseURL || path; raw = x.responseText || '';
    if (x.status >= 500 || x.status === 403) return JSON.stringify({error: 'Amazon answered ' + x.status + ' for ' + path});
    d = new DOMParser().parseFromString(raw, 'text/html');
  } else { url = location.href; raw = document.documentElement.outerHTML; d = document.cloneNode(true); }
  d.querySelectorAll('script, style, noscript, template').forEach(e => e.remove());
  const b = blocked(d, url);
  if (b) return JSON.stringify({blocked: b === 'human_box' ? 'human_check' : b, box: b === 'human_box', url, words: txt(d.body).slice(0, 300)});
  return JSON.stringify(Object.assign({url}, X(d, url, raw, txt, leaves)));
} catch (e) { return JSON.stringify({error: 'reading the page failed: ' + String(e && e.message || e)}); } })()"""

MANY_JS = r"""/*amz:%(tag)s*/await (async () => { try {""" + PAGE_HELPERS_JS + r"""
  const X = %(reader)s;
  const paths = %(paths)s;
  const one = async (path) => {
    const r = await fetch(path, {credentials: 'include'});
    const url = r.url || path, raw = await r.text();
    if (r.status >= 500 || r.status === 403) return {path, error: 'Amazon answered ' + r.status + ' for ' + path};
    const d = new DOMParser().parseFromString(raw, 'text/html');
    d.querySelectorAll('script, style, noscript, template').forEach(e => e.remove());
    const b = blocked(d, url);
    if (b) return {path, blocked: b === 'human_box' ? 'human_check' : b, box: b === 'human_box', url, words: txt(d.body).slice(0, 300)};
    return Object.assign({path, url, status: r.status}, X(d, url, raw, txt, leaves));
  };
  const out = new Array(paths.length);
  let next = 0;
  const worker = async () => { while (next < paths.length) { const i = next++; try { out[i] = await one(paths[i]); } catch (e) { out[i] = {path: paths[i], error: String(e && e.message || e)}; } } };
  await Promise.all(Array.from({length: Math.min(%(at_once)d, paths.length)}, worker));
  return JSON.stringify({pages: out});
} catch (e) { return JSON.stringify({error: 'reading the pages failed: ' + String(e && e.message || e)}); } })()"""
"""A reader run on several of Amazon's pages at once, fetched in the tab a few at a time (at_once): its answer for
each, in paths' order, or {error} for one that failed, or {blocked} for one Amazon put a human step in front of."""

SEARCH_READER = r"""(d, url, raw, txt) => {
  const out = [], seen = new Set();
  for (const a of d.querySelectorAll('a[href*="order-details?orderID="], a[href*="order-details?orderId="]')) {
    const order = (a.getAttribute('href').match(/orderI[dD]=([\w-]+)/) || [])[1];
    let card = a;
    for (let i = 0; i < 10 && card && !(card.querySelector('img') && card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]')); i++) card = card.parentElement;
    if (!card) continue;
    const date = (txt(card).match(/Ordered on ([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1] || null;
    const image = card.querySelector('img') ? card.querySelector('img').getAttribute('src') : null;
    for (const l of card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
      const asin = (l.getAttribute('href').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];
      const title = txt(l) || l.getAttribute('title') || '';
      if (!asin || !title || seen.has(order + asin)) continue;
      seen.add(order + asin);
      out.push({order, date, asin, title, image});
    }
  }
  const nextA = [...d.querySelectorAll('.a-pagination a, a')].find(x => /^\s*Next/.test(txt(x)) && /startIndex=/.test(x.getAttribute('href') || ''));
  return {count: +((txt(d.body).match(/(\d+) orders? matching/) || [])[1] || out.length), purchases: out, next: nextA ? nextA.getAttribute('href') : null};
}"""

ORDERS_READER = r"""(d, url, raw, txt) => {
  const all = [...d.querySelectorAll('.order-card')];
  const cards = all.filter(c => /Order #/i.test(txt(c)));
  const orders = cards.map(c => {
    const t = txt(c);
    const items = [], seen = new Set();
    for (const l of c.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
      const asin = (l.getAttribute('href').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];
      const title = txt(l);
      if (asin && title && !seen.has(asin)) { seen.add(asin); items.push({asin, title}); }
    }
    return {order: (t.match(/Order #\s*([A-Z0-9]{3}-\d{7}-\d{7})/i) || [])[1] || null,
            date: (t.match(/Order placed\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i) || [])[1] || null,
            total: (t.match(/Total\s+(\$[\d,]+\.\d\d)/i) || [])[1] || null,
            status: txt(c.querySelector('.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, h3')) || null, items};
  });
  const nextA = [...d.querySelectorAll('.a-pagination a')].find(x => /^\s*Next/.test(txt(x)));
  return {orders, pending: all.length - cards.length, next: nextA ? nextA.getAttribute('href') : null};
}"""
"""Your Orders as it stands in the live page. Amazon serves its order cards encrypted and the page's own scripts
decrypt them, so read from fetched HTML every card is empty: pending counts the cards not decrypted yet."""

ORDER_READER = r"""(d, url, raw, txt, leaves) => {
  const C = (n, root) => (root || d).querySelector('[data-component="' + n + '"]');
  if (!C('orderId') && !C('purchasedItems')) return {missing: true, title: txt(d.querySelector('title'))};
  const rows = [...d.querySelectorAll('[data-component="itemTitle"]')].map(t => {
    let row = t;
    while (row.parentElement && row.parentElement !== d.body && row.parentElement.querySelectorAll('[data-component="itemTitle"]').length === 1) row = row.parentElement;
    return row;
  });
  const items = rows.map(p => {
    const a = C('itemTitle', p) ? C('itemTitle', p).querySelector('a') : null;
    const href = a ? a.getAttribute('href') || '' : '';
    const ship = C('itemTitle', p).closest('[data-component="shipments"]');
    const q = txt(C('quantity', p));
    return {asin: (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || null, title: txt(a),
            seller: txt(C('orderedMerchant', p)).replace(/^Sold by:\s*/i, '') || null,
            quantity: +((q.match(/\d+/) || ['1'])[0]), price: (txt(C('unitPrice', p)).match(/\$[\d,]+\.\d\d/) || [null])[0],
            variant: txt(C('purchasedVariationDetails', p)) || null, condition: txt(C('itemCondition', p)) || null,
            image: (C('itemImage', p) || p).querySelector('img') ? (C('itemImage', p) || p).querySelector('img').getAttribute('src') : null,
            status: ship ? txt(ship.querySelector('[data-component="shipmentStatus"] h4')) || txt(ship.querySelector('[data-component="shipmentStatus"]')).slice(0, 120) || null : null};
  });
  const pay = [C('viewPaymentPlanSummaryWidget'), C('aapiPaymentMethods'), C('paymentMethod'), C('orderSummary')].map(txt).find(t => /\u2022{2,}\s*\d{4}/.test(t)) || '';
  const card = pay.match(/([A-Za-z][\w®&.' -]*?)\s*•+\s*(\d{4})/);
  const charges = {};
  for (const m of txt(C('chargeSummary')).matchAll(/([A-Za-z][A-Za-z &'()-]*?):\s*(-?\$[\d,]+\.\d\d)/g)) charges[m[1].replace(/^Order Summary\s*/i, '').trim()] = m[2];
  return {order: txt(C('orderId')) || null, date: txt(C('orderDate')) || null,
          ship_to: leaves(C('shippingAddress')).filter(s => !/^Ship to$/i.test(s)),
          card: card ? card[1].replace(/^Payment methods?\s*/i, '').trim() + ' ' + card[2] : null, card_last4: card ? card[2] : null,
          charges, total: charges['Grand Total'] || null, cancelled: !!txt(C('cancelled')), items};
}"""

PRODUCT_READER = r"""(d, url, raw, txt) => {
  const q = (s) => d.querySelector(s);
  const j = (re) => { const m = raw.match(re); if (!m) return null; try { return JSON.parse(m[1]); } catch (e) { return null; } };
  const asin = (q('input#ASIN') || q('input[name="ASIN"]') || {}).value || (url.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || null;
  const labels = j(/"variationDisplayLabels"\s*:\s*(\{[^{}]*\})/) || {};
  const dims = j(/"dimensions"\s*:\s*(\[[^\]]*\])/) || [];
  const values = j(/"dimensionValuesDisplayData"\s*:\s*(\{[^{}]*\})/) || {};
  const variant = {};
  dims.forEach((k, i) => { if (values[asin] && values[asin][i] != null) variant[labels[k] || k] = values[asin][i]; });
  if (!Object.keys(variant).length) for (const row of d.querySelectorAll('[id^="variation_"]')) {
    const label = txt(row.querySelector('.a-form-label')).replace(/:$/, ''), sel = txt(row.querySelector('.selection'));
    if (label && sel) variant[label] = sel;
  }
  const price = ['#corePrice_feature_div .a-offscreen', '#corePriceDisplay_desktop_feature_div .a-offscreen', '.priceToPay .a-offscreen',
                 '#apex_desktop .a-offscreen', '#price_inside_buybox', '#newBuyBoxPrice'].map(s => txt(q(s))).find(Boolean) || null;
  const merchant = txt(q('#merchantInfoFeature_feature_div')) || txt(q('#tabular-buybox')) || txt(q('#merchant-info'));
  const seller = txt(q('#sellerProfileTriggerId')) || txt(q('#merchantInfoFeature_feature_div .offer-display-feature-text-message')) ||
                 (merchant.match(/(?:Sold by|Seller)\s+(.+?)(?:\s+(?:Returns|Payment|Gift options|Ships from|Packaging)\b|$)/) || [])[1] || null;
  const avail = txt(q('#availability')) || txt(q('#outOfStock'));
  const select = q('select#quantity') || q('select[name="quantity"]');
  const clean = (s) => String(s || '').replace(/[\u200e\u200f\u202a-\u202e\u2060]/g, '').replace(/\s+/g, ' ').trim();
  const specs = {};
  const put = (k, v) => { k = clean(k).replace(/\s*:\s*$/, ''); v = clean(v); if (k && v && k.length <= 80 && !(k in specs)) specs[k] = v.slice(0, 240); };
  for (const tr of d.querySelectorAll('#productOverview_feature_div tr, #poExpander tr')) { const td = tr.querySelectorAll('td'); if (td.length >= 2) put(txt(td[0]), txt(td[1])); }
  for (const tr of d.querySelectorAll('#prodDetails tr, [id^="productDetails_"] tr, .prodDetTable tr, [id^="technicalSpecifications_section"] tr')) {
    const th = tr.querySelector('th'), td = tr.querySelector('td');
    if (th && td) put(txt(th), txt(td));
  }
  for (const li of d.querySelectorAll('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li')) {
    const m = clean(txt(li)).match(/^([^:]{2,80}?)\s*:\s*(.+)$/);
    if (m) put(m[1], m[2]);
  }
  const rank = specs['Best Sellers Rank'] || null;
  for (const k of ['Customer Reviews', 'Best Sellers Rank', 'ASIN']) delete specs[k];
  const about = [...new Set([...d.querySelectorAll('#feature-bullets li, #productFactsDesktopExpander ul li')].map(li => clean(txt(li)))
                 .filter(s => s && !/^Make sure this fits/i.test(s)))].slice(0, 10).map(s => s.slice(0, 300));
  const by = clean(txt(q('#bylineInfo')));
  const acr = q('#acrPopover');
  const stars = acr ? (acr.getAttribute('title') || '') + ' ' + txt(acr) : '';
  const shipsFrom = txt(q('#fulfillerInfoFeature_feature_div .offer-display-feature-text-message')) ||
                    (/Shipper \/ Seller/i.test(merchant) ? seller : null) || (merchant.match(/Ships from\s+(.+?)(?:\s+Sold by\b|$)/) || [])[1] || null;
  const title = txt(q('#productTitle')) || null;
  const gone = !title && /Page Not Found|couldn.t find that page|Looking for something\?|dogs of Amazon/i.test(txt(q('title')) + ' ' + txt(d.body).slice(0, 4000));
  return {asin, parent: (raw.match(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/) || [])[1] || null, title,
          gone, page_title: title ? null : (txt(q('title')) || null),
          brand: by.replace(/^Brand:\s*/i, '').replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '') || specs['Brand'] || specs['Brand Name'] || null,
          rating: (stars.match(/[\d.]+ out of 5/) || [null])[0], ratings: (txt(q('#acrCustomerReviewText')).match(/[\d,]+/) || [null])[0],
          ships_from: shipsFrom, specs, about, rank: rank ? rank.slice(0, 200) : null,
          description: clean(txt(q('#productDescription'))).slice(0, 500) || null,
          variant, dimensions: dims.map(k => labels[k] || k), siblings: values, price, seller, merchant: merchant.slice(0, 160) || null,
          availability: avail.slice(0, 160) || null, unavailable: /currently unavailable|out of stock|no featured offers/i.test(avail + ' ' + txt(q('#buybox'))),
          buy_now: !!q('#buy-now-button'), add_to_cart: !!q('#add-to-cart-button'), max_quantity: select ? select.options.length : null,
          subscribe_offered: /Subscribe & Save/i.test(txt(q('#buybox')) || txt(q('#buyBoxAccordion'))),
          bought: txt(q('#iou-poi-purchase-frequency')) || null, last_purchased: txt(q('#iou-poi-purchase-date')) || null,
          delivery: txt(q('#mir-layout-DELIVERY_BLOCK')) || txt(q('#deliveryBlockMessage')) || null,
          image: q('#landingImage') ? (q('#landingImage').getAttribute('data-old-hires') || q('#landingImage').getAttribute('src')) : null};
}"""

CART_READER = r"""(d, url, raw, txt, leaves) => {
  const root = d.querySelector('#sc-active-cart') || d.querySelector('#activeCartViewForm') || d;
  const rows = [...root.querySelectorAll('[data-asin][data-itemid], [id^="sc-item-"][data-asin]')]
    .filter(e => !e.closest('#sc-saved-cart') && e.getAttribute('data-asin') && (e.getAttribute('data-itemtype') || 'active') === 'active');
  const deliv = (e) => {
    const h = e.getAttribute('data-unifieddeliverymessage');
    if (h) { try { return leaves(new DOMParser().parseFromString(h, 'text/html').body).join(' ').slice(0, 140) || null; } catch (x) {} }
    return leaves(e.querySelector('[data-cy="delivery-block"]')).join(' ').slice(0, 140) || null;
  };
  const items = [], seen = new Set();
  for (const e of rows) {
    const id = e.getAttribute('data-itemid') || e.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = e.getAttribute('data-price');
    items.push({asin: e.getAttribute('data-asin'), quantity: +(e.getAttribute('data-quantity') || 1), id,
                title: (e.getAttribute('data-producttitle') || txt(e.querySelector('.sc-product-title, .a-truncate-full, .sc-grid-item-product-title'))).slice(0, 100),
                price: p && !isNaN(+p) ? '$' + (+p).toFixed(2) : null,
                selected: e.hasAttribute('data-isselected') ? e.getAttribute('data-isselected') === '1' : null,
                out_of_stock: e.getAttribute('data-outofstock') === '1', delivery: deliv(e),
                image_id: [...e.querySelectorAll('img')].map(i => ((i.getAttribute('src') || '').match(/\/images\/I\/([^./]+)\./) || [])[1]).find(Boolean) || null});
  }
  return {items, subtotal: txt(d.querySelector('#sc-subtotal-amount-buybox, #sc-subtotal-amount-activecart')) || null,
          subtotal_label: txt(d.querySelector('#sc-subtotal-label-buybox, #sc-subtotal-label-activecart')) || null,
          saved_for_later: d.querySelectorAll('#sc-saved-cart [data-asin][data-itemid]').length,
          proceed: !!d.querySelector('input[name="proceedToRetailCheckout"]')};
}"""

OFFERS_READER = r"""(d, url, raw, txt) => {
  const offers = [], seen = new Set();
  for (const o of d.querySelectorAll('#aod-pinned-offer, #aod-offer')) {
    const f = o.querySelector('form[action*="add-to-cart"]');
    const fields = f ? [...f.querySelectorAll('input')].filter(i => i.name).map(i => [i.name, i.value || '']) : [];
    const olid = (fields.find(x => /offerListingId/i.test(x[0])) || [])[1] || null;
    if (olid && seen.has(olid)) continue;
    if (olid) seen.add(olid);
    const pt = txt(o.querySelector('.apex-pricetopay-accessibility-label')) || txt(o.querySelector('#aod-offer-price .a-price:not(.a-text-price)')) ||
               txt(o.querySelector('.a-price:not(.a-text-price)')) || txt(o.querySelector('#aod-offer-price'));
    const sb = o.querySelector('#aod-offer-soldBy');
    const named = sb && (sb.querySelector('a') || sb.querySelector('.a-col-right .a-size-small'));
    const seller = (txt(named) || txt(sb).replace(/^Sold by\s*/i, '').split(/\s+(?:Seller rating|New Seller|\(\d|Customer ?service)/i)[0]).trim();
    const rating = txt(o.querySelector('#aod-offer-seller-rating'));
    offers.push({featured: o.id === 'aod-pinned-offer', condition: txt(o.querySelector('#aod-offer-heading')).replace(/\s*(Added|Updated|Not added).*$/, '') || null,
                 price: (pt.match(/\$[\d,]+\.\d\d/) || [null])[0], seller: seller || null,
                 ships_from: txt(o.querySelector('#aod-offer-shipsFrom')).replace(/^Ships from\s*/i, '').trim() || null,
                 seller_rating: (rating.match(/\d+% positive[^.]*?months|\(\d[\d,]* ratings?\)|New Seller/gi) || []).join(' ') || (/New Seller/i.test(txt(sb)) ? 'New Seller' : null),
                 delivery: txt(o.querySelector('#mir-layout-DELIVERY_BLOCK')).replace(/\s*(Details|\.\.\. More).*$/, '').slice(0, 140) || null,
                 max_quantity: o.querySelectorAll('[id^="aod-offer-qty-option-"]').length || null,
                 form: f ? {action: f.getAttribute('action'), fields} : null});
  }
  const count = d.querySelector('#aod-total-offer-count');
  return {title: txt(d.querySelector('#aod-asin-title h5, #aod-asin-title')) || null, total: count ? +count.value || null : null, offers};
}"""

PRODUCTS_READER = r"""(d, url, raw, txt, leaves) => {
  const rs = [...d.querySelectorAll('[data-component-type="s-search-result"][data-asin]')].filter(e => e.getAttribute('data-asin')).slice(0, 30);
  return {results: rs.map(e => {
    const t = txt(e);
    const h2 = e.querySelector('h2');
    const aria = h2 ? h2.getAttribute('aria-label') || '' : '';
    const img = e.querySelector('img.s-image');
    return {asin: e.getAttribute('data-asin'), title: (aria.replace(/^Sponsored Ad\s*-\s*/i, '') || txt(h2)).slice(0, 160),
            price: txt(e.querySelector('.a-price:not(.a-text-price) .a-offscreen')) || null,
            list_price: txt(e.querySelector('.a-price.a-text-price[data-a-strike="true"] .a-offscreen')) || null,
            rating: (txt(e.querySelector('.a-icon-alt')).match(/[\d.]+ out of 5/) || [null])[0],
            ratings: ((rb) => (rb.match(/\(([\d.,]+K?)\)/) || rb.match(/stars\s+([\d.,]+K?)\b/) || [null, null])[1])(txt(e.querySelector('[data-cy="reviews-block"], [data-cy="reviews-ratings-slot"]'))),
            bought: (t.match(/[\d.,]+K?\+ bought in past month/) || [null])[0], delivery: leaves(e.querySelector('[data-cy="delivery-recipe"]')).join(' ').slice(0, 120) || null,
            sponsored: /^Sponsored Ad\b/i.test(aria) || !!e.querySelector('a[href*="/sspa/click"], .puis-sponsored-label-text, .s-sponsored-label-text, [aria-label="View Sponsored information or leave ad feedback"]'),
            image: img ? (img.getAttribute('src') || '').replace(/\._[^/]*_\.(jpg|png)$/, '._AC_UL320_.$1') : null};
  })};
}"""

CHECKOUT_READER = r"""(d, url, raw, txt) => {
  const q = (s) => d.querySelector(s);
  const blocks = [...d.querySelectorAll('[id^="checkout-item-block-"]')].filter(e => /^checkout-item-block-\d+$/.test(e.id));
  const items = [], groups = [];
  const STOP = '(?=\\s+(?:Sold by|WARNING\\b|Change quantity|Add gift|Subscribe & Save|Only \\d|In [Ss]tock|& FREE Returns|FREE Returns|Eligible for|Gift options|Arrives)|$)';
  blocks.forEach((b, bi) => {
    const head = [...b.querySelectorAll('.address-promise-text, h2, h3')].map(txt).find(s => /^Arriving\b/.test(s) && s.length < 90) || null;
    const options = [...b.querySelectorAll('input[type="radio"]')].map(r => ({label: txt(r.closest('label') || r.parentElement).slice(0, 110), checked: !!(r.checked || r.hasAttribute('checked'))}));
    groups.push({arriving: head, options});
    // A big checkout (past Amazon's simplification threshold, about 10 lines) draws each item simplified: a short
    // title in .lineitem-title-text, no title id, inside its line's item-block-expand-content-<key>.
    let titles = [...b.querySelectorAll('[id^="checkout-item-block-item-primary-title"]')];
    const simplified = !titles.length;
    if (simplified) titles = [...b.querySelectorAll('.lineitem-title-text')];
    titles.forEach((t) => {
      const wrap = simplified ? t.closest('[id^="item-block-expand-content-"]') : null;
      const key = simplified ? (wrap ? wrap.id.replace(/^item-block-expand-content-/, '') : '') : t.id.replace(/^checkout-item-block-item-primary-title-?/, '');
      let box = simplified ? wrap : (key ? d.getElementById(key) : null);
      if (!box || !box.contains(t)) {
        box = t;
        while (box.parentElement && box.parentElement !== b && box.parentElement.querySelectorAll('[id^="checkout-item-block-item-primary-title"]').length === 1) box = box.parentElement;
      }
      const bt = txt(box);
      const step = box.querySelector('[id^="lineItemQuantity_"]') || (key && d.getElementById('lineItemQuantity_' + key));
      const one = (re) => (bt.match(new RegExp(re + STOP)) || [])[1] || null;
      const asinEl = box.querySelector('[data-asin]');
      const img = box.querySelector('img') || (simplified ? (t.closest('.simplified-item-block-row') || box).querySelector('img') : null);
      items.push({title: simplified ? txt(t.querySelector('.a-truncate-full') || t) : txt(t), short_title: simplified,
                  image_id: img ? ((img.getAttribute('src') || '').match(/\/images\/I\/([^./]+)\./) || [])[1] || null : null,
                  quantity: step ? +(step.getAttribute('data-steppervalue') || 0) : null,
                  price: (txt(box.querySelector('.a-price:not(.a-text-price)')).match(/\$[\d,]+\.\d\d/) || bt.match(/\$[\d,]+\.\d\d/) || [null])[0],
                  seller: one('Ships from and sold by\\s+(.+?)') || one('Sold by\\s+(.+?)'),
                  ships_from: one('Ships from and sold by\\s+(.+?)') || one('Ships from\\s+(.+?)'),
                  asin: asinEl ? asinEl.getAttribute('data-asin') : null, arriving: head, group: bi,
                  image: img ? img.getAttribute('src') : null});
    });
    if (!titles.length) items.push({title: null, quantity: null, text: txt(b).slice(0, 200), group: bi});
  });
  const lines = {};
  for (const m of txt(q('#subtotals-marketplace-table')).matchAll(/([A-Za-z][A-Za-z0-9 &'()-]*?):\s*(-?\$[\d,]+\.\d\d)/g)) lines[m[1].replace(/\s*\(\d+\)$/, '').trim()] = m[2];
  const sns = [...d.querySelectorAll('input[id^="sns-item-v2-checkbox"]')].map(c => c.checked || c.hasAttribute('checked'));
  const radios = [...d.querySelectorAll('input[type="radio"]')].filter(r => r.checked || r.hasAttribute('checked'));
  const delivery = radios.map(r => txt(r.closest('label') || r.parentElement)).filter(s => /\b(FREE|\$\d)/.test(s))
    .map(s => (s.match(/^.*?(?:\bFREE\b|\$[\d,]+\.\d\d)/) || [s])[0]);
  const promise = blocks[0] && [...blocks[0].querySelectorAll('.address-promise-text, h2, h3')].map(txt).find(s => /^Arriving\b/.test(s) && s.length < 90);
  const alerts = [...d.querySelectorAll('.a-alert-error .a-alert-content, .a-alert-warning .a-alert-content, .a-box-alert-error, [role="alert"]')].map(txt).filter(Boolean);
  const byg = d.querySelector('a[name="checkout-byg-ptc-button"]');
  return {checkout: /\/checkout\/|\/gp\/buy\//.test(url), spc: /\/spc|\/gp\/buy\/spc/.test(url), picking: (url.match(/\/checkout\/p\/[\w-]+\/(address|pay)\b/) || [])[1] || null,
          byg: /\/checkout\/byg\b/.test(url) || !!byg, byg_continue: byg ? byg.getAttribute('href') : null, groups,
          pipeline: (url.match(/\/checkout\/p\/p-([\d-]+)/) || [])[1] || null,
          recipient: txt(q('#deliver-to-customer-text')).replace(/^Delivering to\s*/i, '') || null, address: txt(q('#deliver-to-address-text')) || null,
          payment: txt(q('#payment-option-text-default')).replace(/^Paying with\s*/i, '') || txt(q('#checkout-paymentOptionPanel')).slice(0, 120) || null,
          items, lines, total: lines['Order total'] || null, subscribe: sns.some(Boolean), delivery: delivery.slice(0, 3),
          arriving: promise || (txt(blocks[0]).match(/Arriving (?:[Tt]oday|[Tt]omorrow|[A-Z][a-z]+,? [A-Z][a-z]+\.? \d{1,2}|[A-Z][a-z]{2,8}\.? \d{1,2})(?:,? \d{4})?(?: \d{1,2}(?::\d\d)? ?[AP]M ?[-–] ?\d{1,2}(?::\d\d)? ?[AP]M)?/) || [null])[0],
          place_button: !!q('input#placeOrder, input[name="placeYourOrder1"]'),
          card_check: /re-?enter your card|verify your card|confirm your card number/i.test(txt(d.body).slice(0, 20000)),
          thanks: /\/thankyou\b|\/thank-you\b/i.test(url) || /Order placed, thank(s| you)|Thank you, your order has been placed/i.test(txt(d.body).slice(0, 4000)),
          order_numbers: [...new Set([...[...d.querySelectorAll('a[href*="orderID="], a[href*="orderId="]')].map(a => (a.getAttribute('href').match(/orderI[dD]=(\d{3}-\d{7}-\d{7})\b/) || [])[1]),
                                       ...[...txt(d.body).slice(0, 20000).matchAll(/\bOrder (?:#|number:?|ID:?)\s*(\d{3}-\d{7}-\d{7})\b/gi)].map(m => m[1])].filter(Boolean))], purchase: (url.match(/purchaseId=([\d-]+)/) || [])[1] || null, alerts: alerts.slice(0, 5)};
}"""

# What it does in the live page.

# What every pick may call: whether an element is shown and pressable.
VIS_JS = "const vis = (e) => e && e.getClientRects().length && !e.disabled;"

RECT_JS = r"""/*amz:rect*/(() => {
  %(vis)s
  const pick = %(pick)s;
  const e = pick();
  if (!e) return JSON.stringify({error: 'not there'});
  e.scrollIntoView({block: 'center'});
  const r = e.getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height)});
})()"""

BUY_NOW_PICK = r"""() => {
  const acc = document.querySelector('#buyBoxAccordion');
  return [...document.querySelectorAll('#buy-now-button, input[name="submit.buy-now"]')].find(b => vis(b) && (!acc || !acc.contains(b) || b.closest('.a-accordion-active')));
}"""

PLACE_PICK = r"""() => [...document.querySelectorAll('input#placeOrder, input[name="placeYourOrder1"], #submitOrderButtonId input, #bottomSubmitOrderButtonId input')].find(vis)"""

PREPARE_JS = r"""/*amz:prepare*/(() => { try {
  const txt = (e) => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const want = %(quantity)d;
  const acc = document.querySelector('#buyBoxAccordion');
  const oneTime = (r) => !!r && !/^sns/i.test(r.id) && (/^newAccordionRow/.test(r.id) || /^\s*One-time purchase/i.test(txt(r).slice(0, 40)));
  let onetime = 'no choice';
  if (acc) {
    const active = acc.querySelector('.a-accordion-active');
    if (!oneTime(active)) {
      const rows = [...acc.querySelectorAll('[id*="ccordionRow"], .a-box')];
      const row = rows.find(oneTime);
      const head = row && (row.querySelector('[data-action="a-accordion"], .a-accordion-row, a, i.a-icon-radio') || row);
      if (!head) return JSON.stringify({error: 'The buy box has Subscribe & Save chosen and no one-time purchase to switch to'});
      head.click();
      onetime = 'switched';
    } else onetime = 'one-time';
  }
  if (acc && !oneTime(acc.querySelector('.a-accordion-active'))) return JSON.stringify({error: "The buy box didn't switch to one-time purchase"});
  const scope = acc ? acc.querySelector('.a-accordion-active') : document;
  const selects = [...scope.querySelectorAll('select#quantity, select[name="quantity"]')];
  const sel = selects.find(s => s.getClientRects().length || s.closest('.a-dropdown-container, .a-native-dropdown')) || selects[0];
  let quantity = sel ? +sel.value : 1;
  if (want !== quantity) {
    if (!sel) return JSON.stringify({error: 'This page has no quantity to choose, so it can only be bought one at a time'});
    const opt = [...sel.options].find(o => +o.value === want);
    if (!opt) return JSON.stringify({error: 'Amazon lets this be bought at most ' + sel.options.length + ' at a time'});
    sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles: true}));
    const prompt = sel.closest('.a-dropdown-container') && sel.closest('.a-dropdown-container').querySelector('.a-dropdown-prompt');
    if (prompt) prompt.textContent = opt.textContent.trim();
    quantity = +sel.value;
  }
  return JSON.stringify({onetime, quantity, active: acc ? txt(acc.querySelector('.a-accordion-active')).slice(0, 80) : null});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

OPEN_PICKER_JS = r"""/*amz:open-%(which)s*/(() => {
  const panel = document.querySelector(%(panel)s);
  const a = panel && ([...panel.querySelectorAll('a')].find(a => /^\s*Change\s*$/.test(a.textContent)) || [...panel.querySelectorAll('a')].find(a => %(href)s.test(a.getAttribute('href') || '')));
  if (!a) return 'no change link';
  a.click(); return 'opened';
})()"""

ADDRESS_PICK_JS = r"""/*amz:address*/(() => { try {
  const txt = (e) => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(%(words)s).split(' ');
  const more = [...document.querySelectorAll('a, span[role="button"], button')].find(a => /Show more addresses/i.test(txt(a)));
  if (more) more.click();
  const radios = [...document.querySelectorAll('input[type="radio"][name="destinationSubmissionUrl"]')];
  if (!radios.length) return JSON.stringify({error: 'no addresses to pick from'});
  const label = (r) => txt(r.closest('label') || r.parentElement);
  const hits = radios.filter(r => { const t = ' ' + norm(label(r)) + ' '; return want.every(w => t.includes(' ' + w + ' ')); });
  if (hits.length !== 1) return JSON.stringify({error: hits.length ? 'several addresses match' : 'no address matches', choices: radios.map(r => label(r).replace(/\s*Phone number:.*$/, '').replace(/\s*Edit address.*$/, '')).slice(0, 20)});
  hits[0].click();
  const go = document.querySelector('input[aria-labelledby="checkout-primary-continue-button-id-announce"]') ||
             [...document.querySelectorAll('input.a-button-input, button')].find(b => /Deliver to this address|Use this address/i.test(txt(b.closest('.a-button') || b)));
  if (!go) return JSON.stringify({error: 'no Deliver to this address button'});
  go.click();
  return JSON.stringify({picked: label(hits[0]).slice(0, 160)});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

CARD_PICK_JS = r"""/*amz:card*/(() => { try {
  const txt = (e) => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const last4 = %(last4)s;
  const cards = [...document.querySelectorAll('button, [role="button"], [role="radio"]')].filter(b => /•{2,}\s*\d{4}/.test(b.textContent) && b.textContent.length < 120);
  const hits = cards.filter(b => new RegExp('•{2,}\\s*' + last4 + '\\b').test(b.textContent));
  if (hits.length < 1) return JSON.stringify({error: 'no saved card ending ' + last4, choices: cards.map(txt).slice(0, 15)});
  const b = hits[0];
  if (b.getAttribute('aria-expanded') !== 'true' && b.getAttribute('aria-checked') !== 'true') b.click();
  return JSON.stringify({picked: txt(b), expanded: b.getAttribute('aria-expanded')});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

CARD_USE_JS = r"""/*amz:card-use*/(() => { try {
  const txt = (e) => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const last4 = %(last4)s;
  const b = [...document.querySelectorAll('button, [role="button"], [role="radio"]')].find(b => new RegExp('•{2,}\\s*' + last4 + '\\b').test(b.textContent) && b.textContent.length < 120);
  if (!b || (b.getAttribute('aria-expanded') !== 'true' && b.getAttribute('aria-checked') !== 'true')) return JSON.stringify({error: 'the card ending ' + last4 + " didn't stay chosen"});
  const points = [...document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')].filter(c => /rewards points|use .*points/i.test(txt(c.closest('label') || c.parentElement)));
  let unticked = 0;
  for (const c of points) if (c.getAttribute('aria-checked') === 'true' || c.checked) { c.click(); unticked++; }
  const go = document.querySelector('input[aria-labelledby="checkout-primary-continue-button-id-announce"]') ||
             [...document.querySelectorAll('input.a-button-input, button')].find(x => /Use this payment method/i.test(txt(x.closest('.a-button') || x)));
  if (!go) return JSON.stringify({error: 'no Use this payment method button'});
  go.click();
  return JSON.stringify({used: txt(b), points_unticked: unticked});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

CART_DELETE_JS = r"""/*amz:cart-delete*/(() => {
  const asin = %(asin)s;
  const root = document.querySelector('#sc-active-cart') || document.querySelector('#activeCartViewForm') || document;
  const item = [...root.querySelectorAll('[data-asin]')].find(e => e.getAttribute('data-asin') === asin && !e.closest('#sc-saved-cart') && e.querySelector('input, button, [role="button"]'));
  if (!item) return 'not in the cart';
  const del = [...item.querySelectorAll('input, button, [role="button"], a')].find(b => /^Delete\b/i.test((b.getAttribute('aria-label') || b.value || b.textContent || '').trim()) || b.getAttribute('data-action') === 'delete');
  if (!del) return 'no delete control';
  del.click(); return 'deleted';
})()"""


ADD_JS = r"""/*amz:add*/(() => { try {
  const form = %(form)s;
  const p = new URLSearchParams();
  for (const [k, v] of form.fields) p.append(k, v);
  for (const k of [...new Set(p.keys())]) if (/\[quantity\]$|^quantity(\.1)?$/i.test(k)) p.set(k, String(%(quantity)d));
  const x = new XMLHttpRequest();
  x.open('POST', form.action, false);
  x.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
  x.send(p.toString());
  const doc = new DOMParser().parseFromString((x.responseText || '').slice(0, 600000), 'text/html');
  const words = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
  return JSON.stringify({status: x.status, url: x.responseURL || form.action,
    blocked: /\/checkpoint\/|validatecaptcha|\/ap\/(signin|mfa|cvf)/i.test(x.responseURL || '') || !!doc.querySelector('form[action*="/checkpoint/validate"], #captchacharacters, form[name="signIn"]'),
    says: (words.match(/(?:Added to [Cc]art|could not be added|cannot be added|limited to \d+[^.]{0,80}|is not available)[^.]{0,100}/) || [null])[0]});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

CART_OPS_JS = r"""/*amz:cart-ops*/await (async () => { try {
  const ops = %(ops)s;
  const sleep = (ms) => new Promise(z => setTimeout(z, ms));
  const row = (id) => [...document.querySelectorAll('#sc-active-cart [data-itemid]')].find(e => e.getAttribute('data-itemid') === id && e.getAttribute('data-asin'));
  const until = async (test, ms) => { for (let t = 0; t < ms; t += 250) { if (test()) return true; await sleep(250); } return test(); };
  const done = [];
  for (const op of ops) {
    let r = row(op.id);
    if (!r) { done.push({id: op.id, error: 'not in the cart'}); continue; }
    if (op.remove) {
      const del = [...r.querySelectorAll('input, button')].find(b => b.getAttribute('data-action') === 'delete-active' || /^submit\.delete/.test(b.getAttribute('name') || ''));
      if (!del) { done.push({id: op.id, error: 'no Delete on it'}); continue; }
      del.click();
      await until(() => !row(op.id) || !row(op.id).querySelector('input[type="checkbox"]'), 8000);
      await sleep(500);
      done.push({id: op.id, removed: true});
      continue;
    }
    if (op.quantity) {
      for (let n = 0; n < 40; n++) {
        r = row(op.id);
        const q = r ? +r.getAttribute('data-quantity') : null;
        if (!r || q === op.quantity || (q > op.quantity && q <= 1)) break;
        const btn = r.querySelector(q < op.quantity ? 'button[data-action="a-stepper-increment"]' : 'button[data-action="a-stepper-decrement"]');
        if (!btn) { done.push({id: op.id, error: 'no quantity stepper'}); break; }
        btn.click();
        await until(() => row(op.id) && +row(op.id).getAttribute('data-quantity') !== q, 6000);
        await sleep(300);
      }
    }
    if (op.select === true || op.select === false) {
      r = row(op.id);
      if (r && (r.getAttribute('data-isselected') === '1') !== op.select) {
        const box = r.querySelector('input[type="checkbox"]');
        if (!box) { done.push({id: op.id, error: 'no checkbox'}); continue; }
        box.click();
        await until(() => row(op.id) && (row(op.id).getAttribute('data-isselected') === '1') === op.select, 6000);
        await sleep(300);
      }
    }
    r = row(op.id);
    done.push({id: op.id, quantity: r ? +r.getAttribute('data-quantity') : null, selected: r ? r.getAttribute('data-isselected') === '1' : null});
  }
  return JSON.stringify({done});
} catch (e) { return JSON.stringify({error: String(e && e.message || e)}); } })()"""

PROCEED_PICK = r"""() => [...document.querySelectorAll('input[name="proceedToRetailCheckout"]')].find(vis)"""

HUMAN_BOX_PICK = r"""() => document.querySelector('form[action*="/checkpoint/validate"] input#continueCheck')"""

HUMAN_GO_PICK = r"""() => { const f = document.querySelector('form[action*="/checkpoint/validate"]'); return f && [...f.querySelectorAll('button, input[type="submit"]')].find(vis); }"""


def delivery_pick(group, index):
    """What to click for a delivery group's option: its label (the radio itself is drawn over)."""
    return ("() => { const b = document.getElementById(%s); const r = b && b.querySelectorAll('input[type=\"radio\"]')[%d]; "
            "return r && (r.closest('label') || r.parentElement); }" % (json.dumps(f"checkout-item-block-{int(group)}"), int(index)))


ANSWER_CHARS = 20000
"""The browser extension cuts what a script answers at 24,000 characters: a reader's answer longer than this stays in the
tab and comes back a page at a time (paged_js), so a big one is whole, never cut into JSON that doesn't parse."""

PAGED_JS = r"""/*amz:%(tag)s*/await (async () => {
  const v = await (%(code)s);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined || s.length <= %(limit)d) return s === undefined ? null : s;
  (window.__amzPaged = window.__amzPaged || {})[%(key)s] = s;
  return JSON.stringify({__paged: %(key)s, length: s.length});
})()"""


def paged_js(session, code, tag, timeout):
    """A reader's script run in the session's tab: its whole answer, as text, however long."""
    key = json.dumps(secrets.token_hex(6))
    raw = browser({"op": "js", "session": session, "timeout": timeout,
                   "code": PAGED_JS % {"tag": tag, "code": code, "limit": ANSWER_CHARS, "key": key}}, timeout + 15)
    try:
        head = json.loads(raw or "null")
    except (TypeError, ValueError):
        return raw
    if not (isinstance(head, dict) and "__paged" in head):
        return raw
    size, at = int(head.get("length") or 0), f"(window.__amzPaged || {{}})[{key}]"
    try:
        # Each page is sent as a JSON string, which the browser's parsing turns back into exactly its characters.
        parts = [browser({"op": "js", "session": session, "timeout": 20,
                          "code": f"/*amz:{tag}-page*/JSON.stringify({at}.slice({i}, {i + ANSWER_CHARS}))"}, 35)
                 for i in range(0, size, ANSWER_CHARS)]
        if not all(isinstance(part, str) for part in parts):
            raise ValueError("a page came back as something other than text")
        text = "".join(parts)
    except ValueError as e:
        raise Unreadable(f"Couldn't read Amazon's answer back from the tab ({size} characters): {e}") from None
    finally:
        try:
            browser({"op": "js", "session": session, "timeout": 10, "code": f"/*amz:{tag}-done*/(delete {at}, 'ok')"}, 25)
        except ReorderError:
            pass
    if len(text) != size:
        raise Unreadable(f"Read {len(text)} of {size} characters of Amazon's answer back from the tab")
    return text


def read(session, reader, path=None, tag="read", timeout=45):
    """A reader run in the session's tab, on the live page or on path fetched from Amazon there."""
    code = READ_JS % {"tag": tag, "reader": reader, "path": json.dumps(path)}
    for attempt in (1, 2):
        raw = paged_js(session, code, tag, timeout)
        try:
            got = json.loads(raw or "{}")
        except ValueError:
            raise Unreadable(f"Couldn't read Amazon's page: {str(raw)[:200]}")
        if got.get("blocked"):
            if attempt == 1 and got.get("box") and pass_human_box(session, got.get("url") or "", live=path is None):
                continue
            raise Blocked(got["blocked"], got.get("url") or "", got.get("words") or "")
        if got.get("error"):
            raise ReorderError(got["error"])
        reached()
        return got


def read_many(session, paths, reader, tag="many", at_once=4, timeout=100):
    """A reader run on each of paths, fetched from Amazon in the session's tab a few at a time: its answers in paths'
    order, each the reader's or {error} for a page that failed. A human check on any of them stops it (Blocked), as
    read does, after ticking the "I am human" box once when that's all it is."""
    if not paths:
        return []
    code = MANY_JS % {"tag": tag, "reader": reader, "paths": json.dumps(list(paths)), "at_once": max(1, int(at_once))}
    for attempt in (1, 2):
        raw = paged_js(session, code, tag, timeout)
        try:
            got = json.loads(raw or "{}")
        except ValueError:
            raise Unreadable(f"Couldn't read Amazon's pages: {str(raw)[:200]}")
        if got.get("error"):
            raise ReorderError(got["error"])
        reached()
        pages = [p if isinstance(p, dict) else {"error": "nothing came back"} for p in (got.get("pages") or [])]
        b = next((p for p in pages if p.get("blocked")), None)
        if b:
            if attempt == 1 and b.get("box") and pass_human_box(session, b.get("url") or "", live=False):
                continue
            raise Blocked(b["blocked"], b.get("url") or "", b.get("words") or "")
        return pages + [{"error": "nothing came back"}] * (len(paths) - len(pages))


def where(session):
    """The tab's address now."""
    return str(browser({"op": "js", "session": session, "code": "/*amz:where*/location.href", "timeout": 10}, 25) or "")


def pass_human_box(session, url, live=True):
    """Ticks Amazon's "I am human" box and presses Continue, with real clicks, when config allows it.
    Only the checkbox kind: any other human check is their. For a page read by fetching, the tab goes to the check and
    back to where it was. True once the tab is past it."""
    if not config().get("tick_human_box"):
        return False
    try:
        back = None
        if not live:
            back = where(session)
            go(session, url)
        real_click(session, HUMAN_BOX_PICK, "\"I am human\" box")
        pause(1)
        real_click(session, HUMAN_GO_PICK, "Continue under the \"I am human\" box")
        deadline = time.time() + 20
        while "/checkpoint/" in where(session):
            if time.time() > deadline:
                return False
            pause(1)
        if back and "/checkpoint/" not in back:
            go(session, back)
    except ReorderError:
        return False
    health["human_boxes"] += 1
    update_state(lambda st: st["human_boxes"].append({"at": now_ms(), "session": session}))
    return True


def act(session, code, timeout=30):
    """A script that does something in the live page; its answer parsed when it's JSON."""
    raw = browser({"op": "js", "session": session, "code": code, "timeout": timeout}, timeout + 15)
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return raw


def go(session, url, timeout=60):
    browser({"op": "navigate", "session": session, "url": url}, timeout)


def real_click(session, pick, what):
    """A click on what pick finds (scrolled into view; switch-ext-browser clicks by element, so this is the page's own
    click on it)."""
    r = act(session, RECT_JS % {"pick": pick, "vis": VIS_JS})
    if not isinstance(r, dict) or r.get("error") or not r.get("w"):
        raise ReorderError(f"There's no {what} to press on the page")
    got = act(session, "/*amz:click*/(() => { %s const e = (%s)(); if (!e) return false; e.scrollIntoView({block: 'center'}); "
                       "e.click(); return true; })()" % (VIS_JS, pick))
    if got is not True:
        raise ReorderError(f"There's no {what} to press on the page")


def wait_for(session, test, seconds, what, reader=CHECKOUT_READER):
    """The page once test(page) holds, read every couple of seconds; ReorderError past seconds."""
    deadline = time.time() + seconds
    last = None
    while True:
        try:
            last = read(session, reader, tag="wait")
        except ReorderError:
            last = None
        if last and test(last):
            return last
        if time.time() > deadline:
            seen = f" (the page: {last.get('url')}{'; it says: ' + '; '.join(last.get('alerts') or []) if last.get('alerts') else ''})" if last else ""
            raise ReorderError(f"Waited {seconds} s for {what}{seen}")
        pause(2)


def release(session):
    try:
        browser({"op": "release", "session": session}, 30)
    except ReorderError:
        pass


def hold(session, hours):
    browser({"op": "hold", "session": session, "hours": hours}, 30)


# ---------------------------------------------------------------------------------------------
# Order history.


def search_history(session, words, limit=30):
    """Amazon's own search of every order, newest first: [{order, date, asin, title, image}]."""
    path = "/your-orders/search?search=" + re.sub(r"\s+", "+", "".join(c if c.isalnum() or c in " -" else " " for c in words).strip())
    found, count = [], 0
    for _ in range(4):
        page = read(session, SEARCH_READER, path, "search")
        found += page["purchases"]
        count = max(count, page.get("count") or 0)
        if len(found) >= limit or not page.get("next"):
            break
        path = page["next"]
    return found[:limit], count


def orders_page(session, url):
    """One page of Your Orders, opened in session's tab and read once the page has decrypted its cards."""
    go(session, url)
    deadline = time.time() + ORDERS_DECRYPT_S
    while True:
        page = read(session, ORDERS_READER, tag="orders")
        if not page.get("pending"):
            return page
        if time.time() > deadline:
            raise ReorderError(f"Your Orders still had {page['pending']} order card(s) unreadable after {ORDERS_DECRYPT_S} s "
                               f"({len(page['orders'])} read), so I can't say which orders are there")
        pause(1)


def recent_orders(session, pages=1):
    """The newest orders on Your Orders (ten a page): [{order, date, total, status, items}], read in session's tab,
    which it leaves on Your Orders. Never an empty list for a page whose cards couldn't be read: that's an error."""
    out, url = [], BASE + "/your-orders/orders?timeFilter=months-3"
    for _ in range(pages):
        page = orders_page(session, url)
        out += page["orders"]
        if not page.get("next"):
            break
        url = urljoin(BASE, page["next"])
    return out


def orders_beside(session, asins):
    """The recent orders holding any of asins, read in a tab of their own beside session's (whose page, a checkout,
    stays as it is): {order: {order, items, ...}}, or None when Your Orders can't be read."""
    tab = f"{session}-orders"
    try:
        return {o["order"]: o for o in recent_orders(tab) if o.get("order") and any(i["asin"] in asins for i in o["items"])}
    except (ReorderError, Blocked):
        return None
    finally:
        release(tab)


def order_details(session, order):
    o = read(session, ORDER_READER, f"/your-orders/order-details?orderID={order}", "order")
    if o.get("missing"):
        raise ReorderError(f"Amazon has no order {order} in this account ({o.get('title') or 'no order details'})")
    o["link"] = f"{BASE}/your-orders/order-details?orderID={order}"
    return o


def cart_lines(session):
    return read(session, CART_READER, "/gp/cart/view.html", "cart")["items"]


# ---------------------------------------------------------------------------------------------
# Working out what to reorder.


def pick_item(items, item, asin, where):
    if asin:
        hits = [i for i in items if i.get("asin") == asin]
    elif item:
        hits = [i for i in items if words_in(item, i.get("title"))]
    else:
        hits = items
    distinct = {i.get("asin"): i for i in hits}
    if len(distinct) == 1:
        return hits[0]
    listing = "; ".join(f"{(i.get('title') or '')[:70]} ({i.get('asin')}{', ordered ' + i['date'] if i.get('date') else ''})"
                        for i in (list(distinct.values()) or items)[:8])
    if not hits:
        raise ReorderError(f"Nothing in {where} matches \"{item or asin}\". It has: {listing}")
    raise ReorderError(f"{where} has several items{' matching ' + repr(item) if item else ''}: {listing}. Say which (its ASIN, or more words).")


def find_past(session, item=None, order=None, ctx=None):
    """The past purchase to reorder: {order, date, asin, title, price, quantity, seller, variant, ship_to,
    card, image}. None when an ASIN was given that was never bought here (it can still be ordered)."""
    asin = asin_of(item)
    if order:
        order = ORDER_RE.search(order).group(1) if ORDER_RE.search(order) else order.strip().lstrip("#")
        progress(ctx, f"Reading order {order}")
        o = order_details(session, order)
        it = pick_item(o["items"], None if asin else item, asin, f"Order {order}")
        return {**it, "order": order, "date": o.get("date"), "ship_to": o.get("ship_to"), "card": o.get("card"),
                "order_total": o.get("total"), "history": []}
    if asin:
        return {"asin": asin, "order": None, "history": []}
    if not item or not norm(item):
        raise ReorderError("Say what to reorder: words from the item's title, its ASIN or link, or an order number")
    progress(ctx, f"Searching your order history for \"{item}\"")
    found, _ = search_history(session, item)
    if not found:
        raise ReorderError(f"No past Amazon order matches \"{item}\". Try other words from the item's title, or its ASIN.")
    matching = [f for f in found if words_in(item, f["title"])] or found
    it = pick_item(matching, None, None, f"Your orders for \"{item}\"")
    history = [f for f in found if f["asin"] == it["asin"]]
    progress(ctx, f"Found it in order {it['order']} ({it['date']}); reading that order")
    o = order_details(session, it["order"])
    line = next((i for i in o["items"] if i.get("asin") == it["asin"]), None) or {}
    return {**it, **{k: v for k, v in line.items() if v}, "order": it["order"], "date": o.get("date") or it.get("date"),
            "ship_to": o.get("ship_to"), "card": o.get("card"), "order_total": o.get("total"), "history": history}


def sibling(product, wanted):
    """The ASIN of the product's variant with wanted's values (like {"Size": "X-Large"}) and its own
    for the rest."""
    dims = product.get("dimensions") or []
    siblings = product.get("siblings") or {}
    if not dims or not siblings:
        raise ReorderError(f"{product.get('title')} comes in no sizes or colors to choose from")
    current = [product["variant"].get(d) for d in dims]
    target = list(current)
    for key, value in (wanted or {}).items():
        idx = next((i for i, d in enumerate(dims) if norm(d) == norm(key) or norm(key) in norm(d)), None)
        if idx is None:
            raise ReorderError(f"{product.get('title')} has no \"{key}\" to choose; it has {', '.join(dims)}")
        target[idx] = value
    def fits(vals):
        return all(norm(v) == norm(t) for v, t in zip(vals, target))
    hits = [a for a, vals in siblings.items() if fits(vals)]
    if not hits:
        loose = [a for a, vals in siblings.items() if all(norm(t) in norm(v) for v, t in zip(vals, target))]
        hits = loose if len(loose) == 1 else []
    if len(hits) != 1:
        changed = [i for i, (c, t) in enumerate(zip(current, target)) if c != t]
        i = changed[0] if changed else 0
        offered = sorted({vals[i] for vals in siblings.values() if all(norm(v) == norm(t) for j, (v, t) in enumerate(zip(vals, target)) if j != i)})
        raise ReorderError(f"{product.get('title')} isn't offered as {' / '.join(str(t) for t in target)}. "
                           f"With the rest as asked, its {dims[i]} can be: {', '.join(offered) or 'nothing'}")
    return hits[0]


def ceiling_for(past, quantity, max_total, cfg):
    if max_total:
        return round(float(max_total), 2), "max_total"
    unit = money(past.get("price") or "") if past else None
    if not unit:
        return None, None
    return round(unit * quantity * float(cfg["ceiling_factor"]) * float(cfg["tax_allowance"]), 2), \
        f"what it cost last time (${unit:.2f}) × {quantity} × {cfg['ceiling_factor']} plus tax"


def recently_ordered(asin, past, cfg):
    """An order of this item that may already be in: one of Amazon's from today (Pacific), or an attempt
    of this tool's within again_hours whose outcome isn't known to have failed."""
    today = today_pacific()
    for h in (past or {}).get("history") or []:
        if h.get("asin") == asin and amazon_date(h.get("date")) == today:
            return f"Amazon shows order {h['order']} of it placed today"
    if (past or {}).get("order") and past.get("asin") == asin and amazon_date(past.get("date")) == today:
        return f"Amazon shows order {past['order']} of it placed today"
    since = now_ms() - float(cfg["again_hours"]) * 3600000
    for a in load_state()["attempts"]:
        if asin in (a.get("asins") or [a.get("asin")]) and a.get("at", 0) >= since and a.get("outcome") in ("placing", "placed", "unknown", "human_check", "sign_in"):
            mins = int((now_ms() - a["at"]) / 60000)
            return f"I {'placed' if a['outcome'] == 'placed' else 'tried to place'} an order of it {mins} min ago ({a['outcome']}{', #' + a['order'] if a.get('order') else ''})"
    return None


# ---------------------------------------------------------------------------------------------
# The checkout.


def checkout_now(session):
    return read(session, CHECKOUT_READER, tag="checkout")


def same_address(page_address, want):
    return words_in(want, page_address or "")


def same_card(payment, last4):
    return bool(re.search(r"\b" + re.escape(str(last4)) + r"\b", payment or ""))


def open_picker(session, which):
    """Opens the checkout's address list (which "address") or its payment methods ("pay")."""
    panel, href = (("#checkout-delivery-address-panel", r"/\/address\?/") if which == "address"
                   else ("#checkout-paymentOptionPanel", r"/\/pay\?/"))
    if act(session, OPEN_PICKER_JS % {"which": which, "panel": json.dumps(panel), "href": href}) != "opened":
        raise ReorderError(f"The checkout has no way to change the {'address' if which == 'address' else 'card'}")
    page = wait_for(session, lambda p: p.get("picking") == which, 20, f"Amazon's {'addresses' if which == 'address' else 'payment methods'}")
    pause(1.5)
    return page


def pick_address(session, words):
    r = act(session, ADDRESS_PICK_JS % {"words": json.dumps(words)})
    if not isinstance(r, dict) or r.get("error"):
        choices = "; ".join(r.get("choices") or []) if isinstance(r, dict) else ""
        raise ReorderError(f"Couldn't pick the address \"{words}\": {r.get('error') if isinstance(r, dict) else r}"
                           + (f". Amazon's saved addresses: {choices}" if choices else ""))
    return wait_for(session, lambda p: p.get("checkout") and p.get("picking") != "address" and (p.get("items") or p.get("picking")),
                    30, "the checkout after the address")


def pick_card(session, last4):
    r = act(session, CARD_PICK_JS % {"last4": json.dumps(str(last4))})
    if not isinstance(r, dict) or r.get("error"):
        choices = "; ".join(r.get("choices") or []) if isinstance(r, dict) else ""
        raise ReorderError(f"Couldn't pick the card ending {last4}: {r.get('error') if isinstance(r, dict) else r}"
                           + (f". Saved cards: {choices}" if choices else ""))
    pause(1.5)
    r = act(session, CARD_USE_JS % {"last4": json.dumps(str(last4))})
    if not isinstance(r, dict) or r.get("error"):
        raise ReorderError(f"Couldn't use the card ending {last4}: {r.get('error') if isinstance(r, dict) else r}")
    return wait_for(session, lambda p: p.get("checkout") and p.get("picking") != "pay" and (p.get("items") or p.get("picking")),
                    30, "the checkout after the card")


def settle_checkout(session, address, last4, ctx, page=None):
    """The checkout after Buy Now (or Proceed to checkout), with the address and card set as asked (Amazon may ask
    for either first)."""
    page = page or wait_for(session, lambda p: p.get("checkout") and (p.get("items") or p.get("picking")), 30, "the checkout after Buy Now")
    for _ in range(6):
        if page.get("picking") == "address":
            progress(ctx, f"Choosing the address {address}")
            page = pick_address(session, address)
        elif page.get("picking") == "pay":
            progress(ctx, f"Choosing the card ending {last4}")
            page = pick_card(session, last4)
        elif not same_address(page.get("address"), address):
            page = open_picker(session, "address")
        elif not same_card(page.get("payment"), last4):
            page = open_picker(session, "pay")
        else:
            return checkout_now(session)
    raise ReorderError(f"The checkout kept going back to its address or card pages (now on {page.get('url')})")


def verify(page, product, quantity, address, last4, ceiling):
    """What the checkout says, checked against what was asked: a list of problems (empty when it's right)."""
    problems = []
    items = page.get("items") or []
    if len(items) != 1:
        problems.append(f"it holds {len(items)} items, not just this one: " + "; ".join((i.get("title") or i.get("text") or "")[:60] for i in items))
    else:
        it = items[0]
        want, got = norm(product.get("title")), norm(it.get("title"))
        if not got or not (got.startswith(want[:40]) or want.startswith(got[:40])):
            problems.append(f"its item is \"{(it.get('title') or '')[:80]}\", not \"{(product.get('title') or '')[:80]}\"")
        if it.get("quantity") not in (None, quantity):
            problems.append(f"its quantity is {it.get('quantity')}, not {quantity}")
    return problems + shared_checks(page, address, last4, ceiling)


def shared_checks(page, address, last4, ceiling):
    """What every checkout must be: no Subscribe & Save, the address, the card, the total under the ceiling."""
    problems = []
    if page.get("subscribe"):
        problems.append("Subscribe & Save is ticked")
    if not same_address(page.get("address"), address):
        problems.append(f"it ships to {page.get('address')}, not {address}")
    if not same_card(page.get("payment"), last4):
        problems.append(f"it pays with {page.get('payment')}, not the card ending {last4}")
    total = money(page.get("total"))
    if total is None:
        problems.append("its order total can't be read")
    elif ceiling is not None and total > ceiling + 0.004:
        problems.append(f"it comes to ${total:.2f}, over the ${ceiling:.2f} ceiling")
    if page.get("card_check"):
        problems.append("Amazon wants the card number entered again")
    return problems


def screenshot(session):
    """A picture of the checkout for the approval: switch-ext-browser's look answers no image to keep, so none."""
    return None


def clean_cart(session, asin, before):
    """Takes off the cart a line of asin that Buy Now left there, when the cart didn't have it before."""
    if before is None:
        return "not checked (the cart couldn't be read before)"
    try:
        now = cart_lines(session)
    except (ReorderError, Blocked):
        return "not checked"
    had = sum(i["quantity"] for i in before if i["asin"] == asin)
    has = sum(i["quantity"] for i in now if i["asin"] == asin)
    if has <= had:
        return "untouched"
    if had:
        return f"it already had this item; it has {has} now (left as it is)"
    go(session, f"{BASE}/gp/cart/view.html")
    said = act(session, CART_DELETE_JS % {"asin": json.dumps(asin)})
    pause(2)
    try:
        left = sum(i["quantity"] for i in cart_lines(session) if i["asin"] == asin)
    except (ReorderError, Blocked):
        left = None
    return "took off the line Buy Now added" if left == 0 else f"tried to take it off ({said}); the cart still shows {left}"


# ---------------------------------------------------------------------------------------------
# The cart: anything in it, bought before or never.

AOD = "/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin={asin}&pc=dp&experienceId=aodAjaxMain"
"""Amazon's own "Other sellers" panel for a product: every offer, each with its add-to-cart form."""


def cart_page(session):
    """The cart as Amazon has it now: {items: [{asin, id, title, quantity, price, selected, out_of_stock,
    delivery}], subtotal, subtotal_label, saved_for_later}."""
    return read(session, CART_READER, "/gp/cart/view.html", "cart")


def wanted_items(items):
    """What to put in the cart or check out, from a list of ASINs, links or {item, quantity, seller, condition}."""
    out = []
    for x in items or []:
        if isinstance(x, str):
            x = {"item": x}
        if not isinstance(x, dict):
            raise ReorderError(f"{x!r} is no item: give an ASIN, an Amazon link, or {{item, quantity, seller}}")
        words = x.get("item") or x.get("asin") or x.get("link") or ""
        asin = asin_of(words)
        if not asin:
            raise ReorderError(f"\"{words}\" isn't an ASIN or an Amazon link; search finds one from words")
        q = x.get("quantity")
        if q is not None and (int(q) < 1 or int(q) > 30):
            raise ReorderError(f"{q} is no quantity for {asin}")
        out.append({"asin": asin, "quantity": int(q) if q else None, "seller": x.get("seller") or None,
                    "condition": x.get("condition") or None})
    return out


def offers_for(session, asin, pages=1):
    """Every offer Amazon has for asin (the featured one first), up to pages of its panel."""
    path = AOD.format(asin=asin)
    got = read(session, OFFERS_READER, path, "offers")
    seen = {offer_key(o) for o in got["offers"]}
    for n in range(2, pages + 1):
        if not got.get("total") or len(got["offers"]) >= got["total"]:
            break
        more = [o for o in read(session, OFFERS_READER, path + f"&pageno={n}&isonlyrenderofferlist=true", "offers")["offers"]
                if offer_key(o) not in seen]
        if not more:
            break
        seen |= {offer_key(o) for o in more}
        got["offers"] += more
    return got


def offer_key(o):
    fields = dict((o.get("form") or {}).get("fields") or [])
    return next((v for k, v in fields.items() if "offerlistingid" in k.lower()), None) or \
        (o.get("seller"), o.get("price"), o.get("condition"), o.get("ships_from"))


def is_new(o):
    return not o.get("condition") or norm(o["condition"]).startswith("new")


def seller_is(words, o):
    """Whether an offer's seller is the one asked: words of its name, or "amazon" for Amazon itself."""
    if norm(words) in ("amazon", "amazon com"):
        return norm(o.get("seller")) == "amazon com"
    return words_in(words, o.get("seller"))


def pick_offer(offers, seller=None, condition=None):
    """The offer to add: the seller's (its cheapest) or the featured one; new unless condition says otherwise."""
    def fits(o):
        if not o.get("form"):
            return False
        if not condition:
            return is_new(o)
        return norm(condition) in ("any", "all") or words_in(condition, o.get("condition"))
    listing = "; ".join(f"{o.get('seller')} {o.get('price')} ({o.get('condition')}, ships from {o.get('ships_from')})" for o in offers[:10])
    if seller:
        hits = [o for o in offers if fits(o) and seller_is(seller, o)]
        if not hits:
            raise ReorderError(f"No {condition or 'new'} offer from \"{seller}\". The offers: {listing}")
        return sorted(hits, key=lambda o: (not o.get("featured"), money(o.get("price")) or 1e9))[0]
    featured = [o for o in offers if o.get("featured")]
    if featured and fits(featured[0]):
        return featured[0]
    if featured:
        raise ReorderError(f"The featured offer is {featured[0].get('condition')} from {featured[0].get('seller')}; "
                           f"give condition (\"used\", \"any\") or a seller. The offers: {listing}")
    raise ReorderError(f"Amazon features no offer for it; give a seller. The offers: {listing}")


def lines_of(page, asin):
    return [l for l in page["items"] if l["asin"] == asin]


def add_one(session, asin, quantity=1, seller=None, condition=None, by="cart_add", ctx=None):
    """Puts quantity of asin in the cart (the featured offer or seller's), through the offer's own add-to-cart form,
    and checks the cart has them; once more with a fresh form when it didn't take. Answers what went in."""
    progress(ctx, f"Reading who sells {asin}")
    got = offers_for(session, asin, pages=3 if seller else 1)
    if not got["offers"]:
        raise ReorderError(f"Amazon has no offer for {asin} now (it's unavailable, or the parent of variants: give the "
                           f"variant's ASIN, which item shows)")
    offer = pick_offer(got["offers"], seller, condition)
    if offer.get("max_quantity") and quantity > offer["max_quantity"]:
        raise ReorderError(f"{offer.get('seller')} sells {asin} at most {offer['max_quantity']} at a time")
    before = cart_page(session)
    had = {l["id"]: l["quantity"] for l in lines_of(before, asin)}
    said = None
    for attempt in (1, 2):
        progress(ctx, f"Adding {quantity}× {(got.get('title') or asin)[:50]} from {offer.get('seller')} at {offer.get('price')}")
        r = act(session, ADD_JS % {"form": json.dumps(offer["form"]), "quantity": int(quantity)}, timeout=45)
        if not isinstance(r, dict) or r.get("error"):
            raise ReorderError(f"Amazon's add to cart failed: {r.get('error') if isinstance(r, dict) else r}")
        said = r.get("says")
        if r.get("blocked") and not pass_human_box(session, r.get("url") or "", live=False):
            raise Blocked("human_check", r.get("url") or "", "Amazon's check came up while adding to the cart")
        page = cart_page(session)
        now = {l["id"]: l["quantity"] for l in lines_of(page, asin)}
        grew = sum(now.values()) - sum(had.values())
        if grew > 0:
            break
        if attempt == 1:
            pause(2)
            fresh = offers_for(session, asin, pages=3 if seller else 1)
            offer = pick_offer(fresh["offers"], seller, condition) if fresh["offers"] else offer
    if grew <= 0:
        raise ReorderError(f"{asin} didn't go in the cart after two tries{': Amazon said ' + said if said else ''}")
    line = next((l for l in lines_of(page, asin) if l["id"] not in had), None) or \
        max(lines_of(page, asin), key=lambda l: l["quantity"] - had.get(l["id"], 0))
    out = {"asin": asin, "title": got.get("title") or line.get("title"), "quantity": grew, "seller": offer.get("seller"),
           "ships_from": offer.get("ships_from"), "condition": offer.get("condition"), "price": offer.get("price"),
           "delivery": offer.get("delivery") or line.get("delivery"), "line": line["id"], "new_line": line["id"] not in had,
           "selected": line.get("selected"), "link": f"{BASE}/dp/{asin}"}
    if grew != quantity:
        out["warning"] = f"asked for {quantity}, the cart took {grew}{': Amazon said ' + said if said else ''}"
    health["added"] += 1
    update_state(lambda st: st["added"].append({"at": now_ms(), "asin": asin, "line": line["id"], "quantity": grew,
                                                "seller": offer.get("seller"), "price": offer.get("price"), "by": by}))
    return out


def cart_ops(session, ops, ctx=None):
    """Changes lines in the live cart page, one at a time as a person would (each waits for Amazon to take it):
    [{id, select?: bool, quantity?: n, remove?: true}]. Answers the cart as Amazon has it after."""
    if not ops:
        return cart_page(session)
    progress(ctx, f"Changing {len(ops)} line{'s' if len(ops) != 1 else ''} of the cart")
    go(session, f"{BASE}/gp/cart/view.html")
    read(session, CART_READER, tag="cart-live")
    r = act(session, CART_OPS_JS % {"ops": json.dumps(ops)}, timeout=30 + 10 * len(ops))
    if not isinstance(r, dict) or r.get("error"):
        raise ReorderError(f"Changing the cart failed: {r.get('error') if isinstance(r, dict) else r}")
    pause(1)
    return cart_page(session)


def mine(st=None):
    """The cart lines (ids) and ASINs this put in their cart in the last 60 days."""
    since = now_ms() - 60 * 86400000
    added = [a for a in (st or load_state())["added"] if a.get("at", 0) >= since]
    return {a["line"] for a in added}, {a["asin"] for a in added}


def restore_cart(session, before, added=(), keep=()):
    """Puts the cart back as before had it: the lines added taken off, the others' quantities and ticks as they were.
    Lines in keep (bought, or someone's since) are left alone. Answers how it went, in words."""
    page = cart_page(session)
    prev = {b["id"]: b for b in before or []}
    ops = []
    for l in page["items"]:
        if l["id"] in keep:
            continue
        if l["id"] in added and l["id"] not in prev:
            ops.append({"id": l["id"], "remove": True})
            continue
        b = prev.get(l["id"])
        if not b:
            continue
        op = {"id": l["id"]}
        if b.get("quantity") and b["quantity"] != l["quantity"]:
            op["quantity"] = b["quantity"]
        if b.get("selected") is not None and b["selected"] != l.get("selected"):
            op["select"] = b["selected"]
        if len(op) > 1:
            ops.append(op)
    if not ops:
        note_cart(page)
        return "as it was"
    after = cart_ops(session, ops)
    note_cart(after)
    now = {l["id"]: l for l in after["items"]}
    off = []
    for op in ops:
        l = now.get(op["id"])
        if op.get("remove"):
            if l:
                off.append(f"{(l.get('title') or l['asin'])[:40]} is still in it")
        elif l and ((op.get("quantity") and l["quantity"] != op["quantity"]) or ("select" in op and l.get("selected") != op["select"])):
            off.append(f"{(l.get('title') or l['asin'])[:40]} didn't go back")
    taken = sum(1 for op in ops if op.get("remove"))
    words = f"put back as it was ({taken} line{'s' if taken != 1 else ''} I added taken off, {len(ops) - taken} put back)"
    return words if not off else words + "; but " + "; ".join(off)


_last_cart = {"key": None}


def note_cart(page):
    """Records the cart as amazon-cart when it's changed since it was last recorded."""
    lines = [{"asin": l["asin"], "title": (l.get("title") or "")[:70], "quantity": l["quantity"], "price": l.get("price"),
              "selected": l.get("selected")} for l in page.get("items") or []]
    key = json.dumps(lines, sort_keys=True)
    if key == _last_cart["key"]:
        return
    _last_cart["key"] = key
    ticked = [l for l in lines if l["selected"]]
    app.emit("amazon_cart", {"entity": CART_ENTITY, "name": "Amazon cart",
                      "summary": f"{len(lines)} line{'s' if len(lines) != 1 else ''} in the cart, {len(ticked)} ticked"
                                 + (f" ({page.get('subtotal')})" if ticked and page.get("subtotal") else ""),
                      "facts": {"lines": lines, "ticked": len(ticked), "subtotal": page.get("subtotal") if ticked else None,
                                "saved_for_later": page.get("saved_for_later"), "read_at": now_ms()}}, importance=0.2)


# ---------------------------------------------------------------------------------------------
# When it's the user's turn: the ask to put up, the tab held for it.

BLOCKER_WORDS = {
    "human_check": "Amazon put its \"I am human\" check in front of {what}: tick it in the browser's Amazon tab, then try again.",
    "sign_in": "Amazon wants signing in again before {what}: sign in to Amazon in the browser, then try again.",
    "signed_out": "The browser is signed out of Amazon, so {what} can't go on: sign in to Amazon there, then try again.",
}


def needs_person(e, session, what, cfg, ctx, after_place=False):
    """Leaves the tab as it is and answers what's left for the user, with the ask to put up."""
    health["last_blocked"] = {"kind": e.kind, "at": now_ms(), "url": e.url}
    update_state(lambda st: st["blocked"].append({"session": session, "kind": e.kind, "at": now_ms()}))
    then = "Once their ask closes, call the same tool again with the same arguments; it starts over in a fresh tab."
    if after_place:
        then = ("This came up after I pressed Place your order, so the order may go in by itself once the user is past it: "
                "don't place it again; once their ask closes, look in Your Orders (amazon_find) for it.")
    elif e.kind in ("sign_in", "signed_out"):
        then = ("Try signing in yourself first in this tab (the browser's sign_in with its saved password, and the code "
                "Amazon texts the user, which their texts have): put the ask up only for what's left. " + then)
    return {"needs_person": True, "blocker": e.kind, "placed": False, "session": session,
            "page": e.url, "says": e.words[:200],
            "ask": {"type": "task", "text": BLOCKER_WORDS[e.kind].format(what=what), "session": session},
            "then": then}


def let_go_of_blocked():
    """Releases the tabs held for a human step once a new call starts afresh."""
    def take(st):
        old, st["blocked"] = st["blocked"], []
        return old
    for b in update_state(take):
        release(b["session"])


# ---------------------------------------------------------------------------------------------
# Recording.


def record_checkout(c):
    facts = {k: c.get(k) for k in ("state", "kind", "asin", "title", "variant", "quantity", "total", "ceiling", "ship_to", "card",
                                   "arriving", "session", "browser", "held_until", "order", "orders", "reorder_of", "screenshot", "cart_after")}
    if c.get("items"):
        facts["items"] = [{k: l.get(k) for k in ("asin", "title", "quantity", "price", "seller", "arriving")} for l in c["items"]]
    app.emit("amazon_checkout", {"entity": f"amazon-checkout:{c['id']}", "name": f"Amazon checkout {c['id']}",
                          "summary": f"{c.get('state')}: {c.get('quantity')}× {(c.get('title') or '')[:60]}, {c.get('total')}",
                          "facts": facts})


def record_order(o):
    facts = {k: o.get(k) for k in ("order", "placed_at", "asin", "title", "variant", "quantity", "total", "ship_to", "card",
                                   "arriving", "status", "reorder_of", "checkout", "link", "items", "orders")}
    what = f"Ordered {(o.get('title') or '')[:70]}" if o.get("items") else f"Reordered {o.get('quantity')}× {(o.get('title') or '')[:60]}"
    app.emit("amazon_order", {"entity": f"amazon-order:{o['order']}", "name": f"Amazon order #{o['order']}",
                       "summary": f"{what}: {o.get('total')}, {o.get('arriving') or 'placed'}",
                       "facts": facts})


# ---------------------------------------------------------------------------------------------
# Reordering.


def reorder_item(item=None, order=None, quantity=1, variant=None, address=None, card=None, max_total=None,
                 place=False, again=False, tell=True, ctx=None):
    health["calls"] += 1
    cfg = config()
    address, last4 = mine_or_set(cfg, address, card)
    quantity = int(quantity or 1)
    if quantity < 1 or quantity > 30:
        raise ReorderError(f"{quantity} is no quantity to reorder")
    if not _busy.acquire(timeout=5):
        raise ReorderError("Another Amazon checkout is being built right now; wait for it")
    session = f"{READ_SESSION}-{secrets.token_hex(3)}"
    what = f"reordering {item or order}"
    stage = "start"
    cart_before = None
    product = {}
    try:
        let_go_of_blocked()
        progress(ctx, "Opening Your Orders in the user's browser")
        go(session, f"{BASE}/your-orders/orders")
        read(session, ORDERS_READER, tag="signed-in")
        server.session_live("amazon")
        past = find_past(session, item, order, ctx)
        asin = past["asin"]
        progress(ctx, f"Opening the item ({asin})")
        go(session, f"{BASE}/dp/{asin}?th=1&psc=1")
        product = read(session, PRODUCT_READER, tag="product")
        if variant:
            target = sibling(product, variant)
            if target != asin:
                progress(ctx, f"Switching to {', '.join(f'{k} {v}' for k, v in variant.items())} ({target})")
                asin = target
                go(session, f"{BASE}/dp/{asin}?th=1&psc=1")
                product = read(session, PRODUCT_READER, tag="product")
        what = f"reordering {product.get('title') or item}"
        if product.get("asin") != asin:
            raise ReorderError(f"Amazon opened {product.get('asin')} instead of {asin} ({product.get('title')}), so nothing was ordered")
        if product.get("unavailable"):
            raise ReorderError(f"{product.get('title')} isn't available now: {product.get('availability')}")
        if not product.get("buy_now"):
            raise ReorderError(f"{product.get('title')} has no Buy Now (it can only go through the cart), so I stopped before touching the cart")
        if past.get("order") is None:
            found, _ = search_history(session, " ".join((product.get("title") or "").split()[:6]))
            hits = [f for f in found if f["asin"] == asin]
            if hits:
                o = order_details(session, hits[0]["order"])
                line = next((i for i in o["items"] if i.get("asin") == asin), {})
                past.update({**{k: v for k, v in line.items() if v}, "order": hits[0]["order"], "date": o.get("date"),
                             "ship_to": o.get("ship_to"), "card": o.get("card"), "history": hits})
        if not again:
            dup = recently_ordered(asin, past, cfg)
            if dup:
                raise ReorderError(f"{dup}, so I didn't order it again. Pass again: true to order another anyway.")
        ceiling, ceiling_why = ceiling_for(past, quantity, max_total, cfg)
        if place and ceiling is None:
            raise ReorderError(f"There's no past price for {product.get('title')} to set a ceiling from, so give max_total "
                               f"(it's {product.get('price')} each now) to place it")
        if ctx is not None and ctx.cancelled.is_set():
            raise ReorderError("Stopped before Buy Now: the asker gave up")
        try:
            cart_before = cart_lines(session)
        except ReorderError:
            cart_before = None
        prep = act(session, PREPARE_JS % {"quantity": quantity})
        if not isinstance(prep, dict) or prep.get("error"):
            raise ReorderError(f"Couldn't set up the buy box: {prep.get('error') if isinstance(prep, dict) else prep}")
        if prep.get("quantity") != quantity:
            raise ReorderError(f"The quantity came out {prep.get('quantity')}, not {quantity}, so nothing was ordered")
        progress(ctx, f"Buy Now: {quantity}× {(product.get('title') or '')[:60]} at {product.get('price')}")
        stage = "buy_now"
        real_click(session, BUY_NOW_PICK, "Buy Now button")
        page = settle_checkout(session, address, last4, ctx)
        hard = ceiling if (place or max_total) else None
        problems = verify(page, product, quantity, address, last4, hard)
        if problems:
            raise ReorderError("The checkout isn't right, so nothing was ordered: " + "; ".join(problems))
        warnings = []
        total_now = money(page.get("total"))
        if hard is None and ceiling is not None and total_now is not None and total_now > ceiling + 0.004:
            warnings.append(f"It comes to ${total_now:.2f}, more than the ${ceiling:.2f} I'd place without asking ({ceiling_why})")
        charges, savings, shipping = other_lines(page.get("lines"))
        if charges:
            warnings.append("The checkout adds " + ", ".join(f"{k} {v}" for k, v in charges))
        went = ", ".join((past.get("ship_to") or [])[:2])
        if went and not words_in(address, " ".join(past.get("ship_to") or [])):
            warnings.append(f"Last time it went to {went}; this one goes to {short_address(page.get('address'))}")
        if shipping > 0.004:
            warnings.append(f"Shipping costs ${shipping:.2f}")
        shot = screenshot(session)
        cid = session.rsplit("-", 1)[1]
        checkout = {
            "id": cid, "session": session, "browser": BROWSER, "at": now_ms(), "state": "waiting",
            "url": page.get("url"), "pipeline": page.get("pipeline"),
            "asin": asin, "title": product.get("title"), "variant": product.get("variant"), "link": f"{BASE}/dp/{asin}",
            "image": product.get("image"), "seller": product.get("seller"), "quantity": quantity,
            "price_now": product.get("price"), "ship_to": f"{page.get('recipient')}, {page.get('address')}",
            "address_words": address, "card": page.get("payment"), "card_last4": last4, "lines": page.get("lines"),
            "total": page.get("total"), "ceiling": ceiling, "ceiling_why": ceiling_why, "arriving": page.get("arriving"),
            "delivery": (page.get("delivery") or [None])[0], "screenshot": shot, "cart_before": cart_before,
            "reorder_of": {k: past.get(k) for k in ("order", "date", "price", "quantity", "ship_to", "card", "seller", "variant")} if past.get("order") else None,
            "bought": product.get("bought"), "last_purchased": product.get("last_purchased"), "warnings": warnings,
            "savings": [f"{k} {v}" for k, v in savings],
        }
        health["checkouts"] += 1
        if not place:
            hours = float(cfg["hold_hours"])
            hold(session, hours)
            checkout["held_until"] = now_ms() + int(hours * 3600000)
            update_state(lambda st: st["checkouts"].__setitem__(cid, checkout))
            record_checkout(checkout)
            stage = "held"
            return summary(checkout, waiting=True)
        update_state(lambda st: st["checkouts"].__setitem__(cid, checkout))
        stage = "placing"
        return place_checkout(checkout, ceiling, tell, ctx)
    except Blocked as e:
        stage = "blocked"
        return needs_person(e, session, what, cfg, ctx)
    except AfterPlace as e:
        stage = "blocked"
        return needs_person(e.blocked, session, what, cfg, ctx, after_place=True)
    except Exception as e:
        failed(e)
        if stage == "buy_now" and product.get("asin"):
            note = clean_cart(session, product["asin"], cart_before)
            if note not in ("untouched",):
                e.args = (f"{e} (the cart: {note})",)
        raise
    finally:
        if stage not in ("held", "blocked", "placing"):
            release(session)
        _busy.release()


ORDINARY_LINES = {"items", "shipping & handling", "estimated tax to be collected", "order total", "total before tax"}


def other_lines(lines):
    """A checkout's summary lines beyond the ordinary: (charges, savings, net shipping). Free Shipping and
    other savings lines come off shipping first, so shipping that's cancelled out costs nothing."""
    charges, savings = [], []
    shipping = money((lines or {}).get("Shipping & handling")) or 0.0
    for k, v in (lines or {}).items():
        if k.strip().lower() in ORDINARY_LINES:
            continue
        amount = money(v)
        if amount is None:
            continue
        if amount < 0:
            if re.search(r"shipping|delivery", k, re.I):
                shipping += amount
            else:
                savings.append((k, v))
        elif amount > 0:
            charges.append((k, v))
    return charges, savings, round(max(shipping, 0.0), 2)


def short_title(t, words=7):
    """A product's title cut to its first few words, for a card's line."""
    head = re.split(r"\s+", re.split(r"[|,(\[]", t or "")[0].strip())
    return " ".join(head[:words]) + ("…" if len(head) > words else "")


def short_address(s):
    return re.sub(r",?\s*United States$", "", (s or "").strip())


def summary(c, waiting):
    then = c.get("reorder_of") or {}
    out = {"placed": False, "checkout": c["id"], "state": c.get("state"),
           "item": {"title": c.get("title"), "asin": c.get("asin"), "variant": c.get("variant"), "link": c.get("link"),
                    "image": c.get("image"), "seller": c.get("seller")},
           "quantity": c.get("quantity"), "price_now": c.get("price_now"), "ship_to": short_address(c.get("ship_to")), "card": c.get("card"),
           "lines": c.get("lines"), "total": c.get("total"), "arriving": c.get("arriving"), "delivery": c.get("delivery"),
           "ceiling": c.get("ceiling"), "ceiling_why": c.get("ceiling_why"), "last_time": then or None,
           "amazon_says": " · ".join(x for x in (c.get("bought"), c.get("last_purchased")) if x) or None,
           "warnings": c.get("warnings") or [], "savings": c.get("savings") or [], "screenshot": c.get("screenshot"), "browser": c.get("browser"), "session": c.get("session"),
           "held_until": datetime.fromtimestamp(c["held_until"] / 1000, timezone.utc).strftime("%Y-%m-%d %H:%MZ") if c.get("held_until") else None}
    if waiting:
        variant = ", ".join(f"{v}" for v in (c.get("variant") or {}).values())
        last = (f" Same item as order #{then['order']} on {then.get('date')} ({then.get('price')} then, {c.get('price_now')} now)."
                if then.get("order") else f" {c.get('price_now')} each now.")
        text = (f"**Reorder {(c.get('title') or '')[:80]}{' (' + variant + ')' if variant else ''} ×{c.get('quantity')} for {c.get('total')}?**"
                f"{last} Ships to {short_address(c.get('ship_to'))}{', arriving ' + c['arriving'].replace('Arriving ', '') if c.get('arriving') else ''}; "
                f"paid with {c.get('card')}. The checkout is ready in the user's browser; Approve places it."
                + "".join(f" **{w}.**" for w in c.get("warnings") or []))
        out["approval"] = approval_for(c, f"Reorder {short_title(c.get('title'))}: {c.get('total')}", text)
        out["then"] = (f"Put approval up as it is. Its Approve runs amazon_place {{checkout: \"{c['id']}\"}} "
                       f"itself, and the answer's ran says so: don't place it again. When the user declines, discard it. The tab stays "
                       f"held until {out['held_until']}.")
    return out


class AfterPlace(Exception):
    """Amazon wanted a human step after Place your order was pressed."""

    def __init__(self, blocked):
        super().__init__(blocked.kind)
        self.blocked = blocked


def place_checkout(c, ceiling, tell, ctx):
    """Presses Place your order once on a checkout that's been checked, and confirms the order. A refusal
    before or after the press drops the checkout (its cart put back, its tab let go)."""
    try:
        return press_place(c, ceiling, tell, ctx)
    except (Blocked, AfterPlace):
        raise
    except ReorderError as e:
        if not str(e).startswith("unknown"):
            c["state"] = "failed"
            c["error"] = str(e)[:300]
            update_state(lambda st: st["checkouts"].__setitem__(c["id"], c))
            record_checkout(c)
            try:
                note = put_cart_back(c)
            except (ReorderError, Blocked) as x:
                note = f"not checked ({x})"[:200]
            release(c["session"])
            if note not in ("untouched", "as it was"):
                e.args = (f"{e} (the cart: {note})",)
        raise


def put_cart_back(c, bought=False):
    """What a checkout did to the cart, undone: Buy Now's stray line taken off; for a cart checkout, the other
    lines ticked as they were and (unless it was bought) what it added taken off."""
    if c.get("kind") != "cart":
        return clean_cart(c["session"], c["asin"], c.get("cart_before"))
    others = held_lines(but=c["id"])
    if bought:
        return restore_cart(c["session"], [b for b in c.get("cart_before") or [] if b["id"] not in set(c.get("want_ids") or [])],
                            keep=set(c.get("want_ids") or []) | others)
    return restore_cart(c["session"], c.get("cart_before"), c.get("added") or [], keep=others)


def confirmed_numbers(session, candidates, asins):
    """Of the order numbers a thank-you page shows, those whose Order Details hold one of asins: a number the page
    merely carries (a session id has the same shape) is never taken for the order."""
    out = []
    for n in candidates[:5]:
        try:
            o = order_details(session, n)
        except (ReorderError, Blocked):
            continue
        if any(i.get("asin") in asins for i in o.get("items") or []):
            out.append(n)
    return sorted(out)


def press_place(c, ceiling, tell, ctx):
    session = c["session"]
    cart_kind = c.get("kind") == "cart"
    asins = c.get("asins") or [c["asin"]]
    if cart_kind and c.get("url"):
        go(session, c["url"])
    page = checkout_now(session)
    if cart_kind:
        expected = [{"asin": l.get("asin"), "title": l.get("title"), "quantity": l.get("quantity"),
                     "seller": l.get("wanted_seller"), "image_id": l.get("image_id")} for l in c["items"]]
        problems = verify_cart(page, expected, c["address_words"], c["card_last4"], ceiling) if page.get("spc") else ["it isn't open"]
        if problems:
            # the user's cart is shared: another checkout staged since ticks its own lines. Tick this one's again
            # and check the checkout that makes against what they approved, as before.
            want = [{"id": l["id"], "asin": l.get("asin"), "quantity": l.get("quantity"), "title": l.get("title")} for l in c["items"]]
            if not all(w["id"] for w in want):
                raise ReorderError("The checkout changed, so nothing was ordered: " + "; ".join(problems))
            progress(ctx, "The cart's ticks changed since; ticking this checkout's lines again")
            tick_lines(session, want, ctx)
            page, _ = proceed(session, c["address_words"], c["card_last4"], c.get("delivery_rule"), len(want), ctx)
            problems = verify_cart(page, expected, c["address_words"], c["card_last4"], ceiling)
    else:
        if not page.get("spc") and c.get("url"):
            go(session, c["url"])
            page = checkout_now(session)
        if not page.get("spc"):
            raise ReorderError(f"The checkout isn't open any more (the tab is on {page.get('url')}); build it again")
        problems = verify(page, {"title": c["title"]}, c["quantity"], c["address_words"], c["card_last4"], ceiling)
    if problems:
        raise ReorderError("The checkout changed, so nothing was ordered: " + "; ".join(problems))
    total = page.get("total")
    before = orders_beside(session, asins)
    if ctx is not None and ctx.cancelled.is_set():
        raise ReorderError("Stopped before Place your order: the asker gave up")
    attempt = {"at": now_ms(), "asin": asins[0], "asins": asins, "checkout": c["id"], "total": total, "outcome": "placing"}
    update_state(lambda st: st["attempts"].append(attempt))
    def outcome(name, **more):
        update_state(lambda st: [a.update(outcome=name, **more) for a in st["attempts"] if a.get("at") == attempt["at"]])
    progress(ctx, f"Placing the order ({total} on {page.get('payment')})")
    real_click(session, PLACE_PICK, "Place your order button")
    deadline = time.time() + PLACE_WAIT_S
    last = None
    while time.time() < deadline:
        pause(2)
        try:
            last = checkout_now(session)
        except Blocked as e:
            outcome(e.kind)
            c["state"] = "blocked"
            update_state(lambda st: st["checkouts"].__setitem__(c["id"], c))
            raise AfterPlace(e)
        except ReorderError:
            continue
        if last.get("thanks"):
            break
        words = " ".join(last.get("alerts") or [])
        if last.get("spc") and re.search(r"declined|problem with your payment|no longer available|unable to|couldn.t|can.t be shipped|not deliverable|quantity limit", words, re.I):
            outcome("refused", error=words[:300])
            raise ReorderError(f"Amazon didn't take the order: {words[:300]}")
    numbers, fresh = [], []
    if before is not None:
        for _ in range(3 if last and last.get("thanks") else 2):
            after = orders_beside(session, asins)
            fresh = [o for n, o in (after or {}).items() if n not in before]
            got = {i["asin"] for o in fresh for i in o["items"]}
            if fresh and (not cart_kind or set(asins) <= got):
                break
            pause(4)
        numbers = sorted(o["order"] for o in fresh)
    if not numbers and last and last.get("thanks"):
        numbers = confirmed_numbers(session, last.get("order_numbers") or [], asins)
    number = numbers[0] if numbers else None
    if not number:
        if not (last and last.get("thanks")):
            outcome("unknown")
            c["state"] = "unknown"
            update_state(lambda st: st["checkouts"].__setitem__(c["id"], c))
            record_checkout(c)
            hold(session, 12)
            raise ReorderError(f"unknown: I pressed Place your order but saw no thank-you page in {PLACE_WAIT_S} s and no new order "
                               f"of it in Your Orders, so it may or may not be in. Look at Your Orders before trying again "
                               f"(it's refused for {config()['again_hours']} h without again). The tab stays held: {session} on {BROWSER}.")
    details = {}
    if number:
        try:
            details = order_details(session, number)
        except (ReorderError, Blocked):
            details = {}
    line = next((i for i in details.get("items") or [] if i.get("asin") == c["asin"]), {})
    o = {"order": number, "placed_at": now_ms(), "asin": c["asin"], "title": c["title"],
         "variant": c.get("variant"), "quantity": c["quantity"], "total": (details.get("total") if len(numbers) <= 1 else None) or total,
         "ship_to": ", ".join(details.get("ship_to") or []) or c.get("ship_to"), "card": details.get("card") or page.get("payment"),
         "arriving": line.get("status") or c.get("arriving"), "status": line.get("status") or "placed",
         "reorder_of": (c.get("reorder_of") or {}).get("order"), "checkout": c["id"],
         "link": f"{BASE}/your-orders/order-details?orderID={number}" if number else None, "confirmed_in_your_orders": bool(numbers)}
    if not number:
        o["unconfirmed"] = ("Amazon showed its thank-you page, but I couldn't find the new order in Your Orders, so I have no "
                            "order number for it: look in Your Orders for it")
    if cart_kind:
        o["items"] = [{k: l.get(k) for k in ("asin", "title", "quantity", "price", "seller", "arriving")} for l in c["items"]]
        o["orders"] = numbers
        if len(numbers) > 1:
            o["note"] = f"Amazon split it into {len(numbers)} orders: {', '.join(numbers)}"
    outcome("placed", order=number, orders=numbers)
    c.update(state="placed", order=number, orders=numbers, placed_at=o["placed_at"])
    update_state(lambda st: (st["checkouts"].__setitem__(c["id"], c), st["orders"].append({k: v for k, v in o.items() if k != "items"})))
    health["orders"] += 1
    health["last_order"] = {"order": number, "at": o["placed_at"], "title": (c["title"] or "")[:60], "total": o["total"]}
    for n in numbers or ([number] if number else []):
        if cart_kind:
            mine_here = next((f for f in fresh if f["order"] == n), None)
            record_order({**o, "order": n, "link": f"{BASE}/your-orders/order-details?orderID={n}",
                          "items": [i for i in o["items"] if not mine_here or i["asin"] in {x["asin"] for x in mine_here["items"]}],
                          "total": (mine_here or {}).get("total") or o["total"]})
        else:
            record_order(o)
    record_checkout(c)
    try:
        o["cart"] = put_cart_back(c, bought=True)
    except (ReorderError, Blocked) as e:
        o["cart"] = f"not checked ({e})"[:200]
    release(session)
    if tell:
        title = f"Amazon order in: {o['total']}"
        what = (f"{len(c['items'])} items ({', '.join(short_title(l.get('title')) for l in c['items'][:3])}{', …' if len(c['items']) > 3 else ''})"
                if cart_kind else f"{c['quantity']}× {(c['title'] or '')[:70]}")
        words = (f"{what}, {o['total']} on {c.get('card')}, to {short_address(c.get('ship_to'))}. "
                 + (f"{(o.get('arriving') or '').rstrip('.')}. " if not cart_kind else "")
                 + (f"Orders #{', #'.join(numbers)}." if len(numbers) > 1 else f"Order #{number}." if number
                    else "Order number unconfirmed: I couldn't find it in Your Orders yet."))
        o["notified"] = server.notify(title, words, ctx.work if ctx is not None and ctx.work else "home")
    o["placed"] = True
    return o


# ---------------------------------------------------------------------------------------------
# A checkout of the cart: exactly the items asked, ticked in the cart, checked line by line.


def same_title(a, b):
    """Whether a cart line's title (cut at 80 characters) and a checkout item's are the same product's."""
    na, nb = norm(a), norm(b)
    n = min(len(na), len(nb), 60)
    return n >= 12 and na[:n] == nb[:n]


def verify_cart(page, expected, address, last4, ceiling):
    """A cart checkout checked against what was asked: every item and only those, each quantity and asked seller,
    then the address, card and total. A list of problems (empty when it's right)."""
    problems = []
    items = page.get("items") or []
    if any(not i.get("title") for i in items):
        problems.append("it has a delivery group whose item can't be read")
    left = list(expected)
    for it in [i for i in items if i.get("title")]:
        e = next((e for e in left if it.get("asin") and it.get("asin") == e.get("asin")), None) or \
            next((e for e in left if it.get("image_id") and it.get("image_id") == e.get("image_id")), None) or \
            next((e for e in left if same_title(e.get("title"), it["title"])), None)
        if not e:
            problems.append(f"it holds \"{it['title'][:70]}\", which isn't one of the items asked")
            continue
        left.remove(e)
        if it.get("quantity") not in (None, e.get("quantity")):
            problems.append(f"\"{it['title'][:50]}\" comes {it.get('quantity')}, not {e.get('quantity')}")
        if e.get("seller") and not seller_is(e["seller"], {"seller": it.get("seller")}):
            problems.append(f"\"{it['title'][:50]}\" is sold by {it.get('seller')}, not {e['seller']}")
    for e in left:
        problems.append(f"\"{(e.get('title') or e.get('asin'))[:60]}\" isn't in it")
    return problems + shared_checks(page, address, last4, ceiling)


def reach_checkout(session, ctx):
    """The checkout once Proceed to checkout was pressed: past Amazon's "Need anything else?" page (and its "I am
    human" box, which read ticks), at the page with the items or its address or card picker."""
    deadline = time.time() + 60
    hops = 0
    while True:
        page = checkout_now(session)
        if page.get("byg") and page.get("byg_continue") and hops < 3:
            hops += 1
            progress(ctx, "Past Amazon's \"Need anything else?\" page")
            href = page["byg_continue"]
            go(session, href if href.startswith("http") else BASE + href)
            continue
        if page.get("checkout") and not page.get("byg") and (page.get("items") or page.get("picking")):
            return page
        if time.time() > deadline:
            raise ReorderError(f"Proceed to checkout didn't reach the checkout (the tab is on {page.get('url')})")
        pause(2)


DELIVERY_WORDS = {"fastest": "fastest", "fastest free": "fastest_free", "free": "fastest_free", "fastest_free": "fastest_free"}


def pick_option(options, rule):
    """Which of a delivery group's options the rule picks: fastest (Amazon lists it first), fastest_free (the first
    that's FREE), or words of one (\"Amazon Day\", \"fewer boxes\"). None when none fits."""
    kind = DELIVERY_WORDS.get(rule.replace("_", " ").strip().lower(), rule)
    if kind == "fastest":
        return 0 if options else None
    if kind == "fastest_free":
        return next((i for i, o in enumerate(options) if re.search(r"\bFREE\b", o.get("label") or "")), None)
    return next((i for i, o in enumerate(options) if words_in(kind, o.get("label"))), None)


def choose_delivery(session, page, delivery, ctx):
    """Sets each delivery group's option as delivery asks, one group at a time (Amazon regroups after each).
    Answers the page and what it couldn't set."""
    rule = (delivery or "").strip()
    if not rule or norm(rule) in ("as is", "default", "amazon s choice"):
        return page, []
    missed = []
    for _ in range(10):
        todo = None
        for gi, g in enumerate(page.get("groups") or []):
            opts = g.get("options") or []
            if not opts:
                continue
            k = pick_option(opts, rule)
            if k is None:
                note = f"{g.get('arriving') or 'a delivery group'} offers no \"{rule}\" ({'; '.join(o['label'][:40] for o in opts)})"
                if note not in missed:
                    missed.append(note)
                continue
            if not opts[k].get("checked"):
                todo = (gi, k, opts[k]["label"])
                break
        if not todo:
            return page, missed
        progress(ctx, f"Choosing delivery: {todo[2][:60]}")
        real_click(session, delivery_pick(todo[0], todo[1]), f"delivery option \"{todo[2][:40]}\"")
        pause(2.5)
        page = wait_for(session, lambda p: p.get("spc") and p.get("items"), 20, "the checkout after choosing delivery")
    return page, missed + [f"the delivery options kept changing, so they may not all be \"{rule}\""]


def waiting_cart_checkouts():
    return [c for c in load_state()["checkouts"].values()
            if c.get("kind") == "cart" and c.get("state") == "waiting" and (c.get("held_until") or 0) > now_ms()]


def tick_lines(session, want, ctx=None):
    """Ticks exactly these cart lines ([{id, asin, quantity, title}]) at their quantities and unticks every other,
    checking each is still there and in stock and that Amazon took it. Answers the cart page after."""
    now = {l["id"]: l for l in cart_page(session)["items"]}
    gone = [w for w in want if w["id"] not in now]
    if gone:
        raise ReorderError("These aren't in the cart any more: " + ", ".join(w.get("title") or w["asin"] for w in gone))
    out = [now[w["id"]] for w in want if now[w["id"]].get("out_of_stock")]
    if out:
        raise ReorderError("Out of stock now: " + ", ".join((l.get("title") or l["asin"])[:60] for l in out))
    ids = {w["id"] for w in want}
    ops = []
    for l in now.values():
        if l["id"] in ids:
            w = next(w for w in want if w["id"] == l["id"])
            op = {"id": l["id"]}
            if w["quantity"] != l["quantity"]:
                op["quantity"] = w["quantity"]
            if not l.get("selected"):
                op["select"] = True
            if len(op) > 1:
                ops.append(op)
        elif l.get("selected"):
            ops.append({"id": l["id"], "select": False})
    page = cart_ops(session, ops, ctx)
    wrong = [l for l in page["items"] if bool(l.get("selected")) != (l["id"] in ids) or
             (l["id"] in ids and l["quantity"] != next(w["quantity"] for w in want if w["id"] == l["id"]))]
    if wrong:
        raise ReorderError("The cart didn't take the ticks and quantities: " + "; ".join(
            f"{(l.get('title') or l['asin'])[:40]} {'ticked' if l.get('selected') else 'unticked'} ×{l['quantity']}" for l in wrong[:6]))
    return page


def proceed(session, address, last4, delivery, n, ctx=None):
    """From the cart as ticked, Proceed to checkout: past "Need anything else?", the address and card set, the
    delivery speed chosen. Answers the checkout page and the delivery choices it couldn't make."""
    progress(ctx, f"Proceed to checkout with {n} item{'s' if n != 1 else ''}")
    go(session, f"{BASE}/gp/cart/view.html")
    read(session, CART_READER, tag="cart-live")
    real_click(session, PROCEED_PICK, "Proceed to checkout button")
    page = settle_checkout(session, address, last4, ctx, reach_checkout(session, ctx))
    page, missed = choose_delivery(session, page, delivery, ctx)
    return checkout_now(session), missed


def held_lines(but=None):
    """The cart lines checkouts waiting for the user hold (but one), which putting the cart back leaves alone."""
    return {i for c in waiting_cart_checkouts() if c["id"] != but for i in c.get("want_ids") or []}


def checkout_cart(items=None, address=None, card=None, delivery=None, max_total=None, ctx=None):
    health["calls"] += 1
    cfg = config()
    address, last4 = mine_or_set(cfg, address, card)
    wanted = wanted_items(items)
    if not _busy.acquire(timeout=5):
        raise ReorderError("Another Amazon checkout is being built right now; wait for it")
    session = f"{READ_SESSION}-{secrets.token_hex(3)}"
    cid = session.rsplit("-", 1)[1]
    stage, before, added, want = "start", None, [], []
    try:
        let_go_of_blocked()
        progress(ctx, "Opening the cart in the user's browser")
        go(session, f"{BASE}/gp/cart/view.html")
        page = read(session, CART_READER, tag="cart-live")
        put_back = restore_pending(session)
        if put_back:
            page = cart_page(session)
        before = [{k: l.get(k) for k in ("id", "asin", "quantity", "selected", "title")} for l in page["items"]]
        if not wanted:
            ticked = [l for l in page["items"] if l.get("selected")]
            if not ticked:
                raise ReorderError("Nothing in the user's cart is ticked for checkout; say which items")
            want = [{"id": l["id"], "asin": l["asin"], "quantity": l["quantity"], "seller": None, "title": l.get("title")} for l in ticked]
        else:
            stage = "cart"
            for w in wanted:
                have = [l for l in lines_of(page, w["asin"]) if l["id"] not in {x["id"] for x in want}]
                if have:
                    l = have[0]
                    want.append({"id": l["id"], "asin": w["asin"], "quantity": w["quantity"] or l["quantity"], "seller": w["seller"], "title": l.get("title")})
                    continue
                got = add_one(session, w["asin"], w["quantity"] or 1, w["seller"], w["condition"], by=f"checkout:{cid}", ctx=ctx)
                if got.get("new_line"):
                    added.append(got["line"])
                want.append({"id": got["line"], "asin": w["asin"], "quantity": w["quantity"] or 1, "seller": w["seller"], "title": got.get("title")})
                page = cart_page(session)
        ids = {w["id"] for w in want}
        stage = "cart"
        page = tick_lines(session, want, ctx)
        for w in want:
            l = next(l for l in page["items"] if l["id"] == w["id"])
            w.update(title=l.get("title") or w.get("title"), cart_price=l.get("price"), image_id=l.get("image_id"))
        if ctx is not None and ctx.cancelled.is_set():
            raise ReorderError("Stopped before Proceed to checkout: the asker gave up")
        stage = "checkout"
        page, missed = proceed(session, address, last4, delivery, len(want), ctx)
        ceiling = round(float(max_total), 2) if max_total else None
        expected = [{"asin": w["asin"], "title": w.get("title"), "quantity": w["quantity"], "seller": w.get("seller"),
                     "image_id": w.get("image_id")} for w in want]
        problems = verify_cart(page, expected, address, last4, ceiling)
        if problems:
            raise ReorderError("The checkout isn't right, so I stopped before ordering: " + "; ".join(problems))
        warnings = list(missed)
        charges, savings, shipping = other_lines(page.get("lines"))
        if charges:
            warnings.append("The checkout adds " + ", ".join(f"{k} {v}" for k, v in charges))
        if shipping > 0.004:
            warnings.append(f"Shipping costs ${shipping:.2f}")
        lines = []
        for it in [i for i in page.get("items") or [] if i.get("title")]:
            e = next((w for w in want if (it.get("asin") and it["asin"] == w["asin"])), None) or \
                next((w for w in want if it.get("image_id") and it["image_id"] == w.get("image_id")), None) or \
                next((w for w in want if same_title(w.get("title"), it["title"])), {})
            lines.append({"asin": e.get("asin") or it.get("asin"), "id": e.get("id"), "title": it["title"], "quantity": it.get("quantity"),
                          "price": it.get("price"), "seller": it.get("seller"), "ships_from": it.get("ships_from"),
                          "arriving": it.get("arriving"), "image": it.get("image"), "image_id": it.get("image_id"),
                          "wanted_seller": e.get("seller")})
            if e.get("cart_price") and it.get("price") and money(it["price"]) != money(e["cart_price"]):
                warnings.append(f"{it['title'][:40]} is {it['price']} at checkout, {e['cart_price']} in the cart")
        dates = {l.get("arriving") for l in lines if l.get("arriving")}
        if len(dates) > 1:
            warnings.append(f"It comes in {len(dates)} deliveries, arriving " + "; ".join(arrives(d) for d in sorted(dates)))
        shot = screenshot(session)
        total = page.get("total")
        names = ", ".join((l["title"] or "")[:30] for l in lines[:3]) + (f" and {len(lines) - 3} more" if len(lines) > 3 else "")
        c = {"id": cid, "kind": "cart", "session": session, "browser": BROWSER, "at": now_ms(), "state": "waiting",
             "url": page.get("url"), "pipeline": page.get("pipeline"), "items": lines, "asins": [l["asin"] for l in lines if l.get("asin")],
             "asin": lines[0]["asin"] if lines else None, "title": f"{len(lines)} item{'s' if len(lines) != 1 else ''}: {names}",
             "quantity": sum(l.get("quantity") or 0 for l in lines), "ship_to": f"{page.get('recipient')}, {page.get('address')}",
             "address_words": address, "card": page.get("payment"), "card_last4": last4, "lines": page.get("lines"), "total": total,
             "ceiling": ceiling, "ceiling_why": "max_total" if ceiling else None, "arriving": page.get("arriving"),
             "delivery": [g.get("arriving") for g in page.get("groups") or []], "delivery_rule": delivery or None,
             "screenshot": shot, "cart_before": before, "added": added, "want_ids": sorted(ids),
             "warnings": warnings, "savings": [f"{k} {v}" for k, v in savings]}
        hours = float(cfg["hold_hours"])
        hold(session, hours)
        c["held_until"] = now_ms() + int(hours * 3600000)
        update_state(lambda st: st["checkouts"].__setitem__(cid, c))
        health["checkouts"] += 1
        record_checkout(c)
        stage = "held"
        return cart_summary(c)
    except Blocked as e:
        if stage in ("cart", "checkout"):
            update_state(lambda st: st.__setitem__("restore", {"before": before, "added": added, "at": now_ms()}))
        stage = "blocked"
        out = needs_person(e, session, "building the Amazon checkout", cfg, ctx)
        if before is not None:
            out["then"] += " The cart's ticks are changed meanwhile; the next cart call puts them back first."
        return out
    except Exception as e:
        failed(e)
        if before is not None and (stage in ("cart", "checkout") or added):
            try:
                note = restore_cart(session, before, added)
            except (ReorderError, Blocked) as x:
                note = f"not put back ({x})"[:200]
                update_state(lambda st: st.__setitem__("restore", {"before": before, "added": added, "at": now_ms()}))
            if note != "as it was":
                e.args = (f"{e} (the cart: {note})",)
        raise
    finally:
        if stage not in ("held", "blocked"):
            release(session)
        _busy.release()


def restore_pending(session):
    """Puts back a cart a checkout left changed when Amazon stopped it (a sign-in, a check): once, before the next
    change. Answers how it went, or None when nothing was pending."""
    pending = load_state().get("restore")
    if not pending:
        return None
    try:
        note = restore_cart(session, pending.get("before"), pending.get("added") or [])
    except ReorderError as e:
        note = f"not put back ({e})"[:200]
    update_state(lambda st: st.pop("restore", None))
    return note


def arrives(s):
    return re.sub(r"^Arriving\s*", "", s or "").replace(", 2026", "").replace(", 2027", "") or None


def cart_summary(c):
    out = {"placed": False, "checkout": c["id"], "kind": "cart", "state": c.get("state"),
           "items": [{k: l.get(k) for k in ("asin", "title", "quantity", "price", "seller", "ships_from", "arriving")} for l in c["items"]],
           "ship_to": short_address(c.get("ship_to")), "card": c.get("card"), "lines": c.get("lines"), "total": c.get("total"),
           "deliveries": c.get("delivery"), "warnings": c.get("warnings") or [], "savings": c.get("savings") or [],
           "screenshot": c.get("screenshot"), "browser": c.get("browser"), "session": c.get("session"), "added_to_cart": len(c.get("added") or []),
           "held_until": datetime.fromtimestamp(c["held_until"] / 1000, timezone.utc).strftime("%Y-%m-%d %H:%MZ") if c.get("held_until") else None}
    lines = c.get("lines") or {}
    money_line = ", ".join(f"{k.replace('Estimated tax to be collected', 'tax').replace('Items', 'items').lower() if k.startswith(('Items', 'Estimated tax')) else k} {v}"
                           for k, v in lines.items() if k not in ("Order total", "Total before tax") and not (k == "Shipping & handling" and money(v) == 0))
    rows = "\n".join(f"- **{short_title(l['title'])}** ×{l.get('quantity')} · {l.get('price')} · sold by {(l.get('seller') or 'unknown').rstrip('.')}"
                     + (f" · arrives {arrives(l['arriving'])}" if l.get("arriving") else "") for l in c["items"])
    text = (f"**Order {len(c['items'])} item{'s' if len(c['items']) != 1 else ''} from Amazon for {c.get('total')}?** ({money_line})\n\n{rows}\n\n"
            f"Ships to {short_address(c.get('ship_to'))}; paid with {c.get('card')}. The checkout is ready in the user's browser; "
            f"Approve places it." + "".join(f" **{w}.**" for w in c.get("warnings") or []))
    out["approval"] = approval_for(c, f"Order {len(c['items'])} Amazon item{'s' if len(c['items']) != 1 else ''}: {c.get('total')}", text)
    out["then"] = (f"Put approval up as it is. Its Approve runs amazon_place {{checkout: \"{c['id']}\"}} "
                   f"itself, and the answer's ran says so: don't place it again. When the user declines, discard it; it puts the cart "
                   f"back. The tab stays held until {out['held_until']}.")
    return out


def approval_for(c, title, text):
    """The approval to put up for a held checkout: its Approve runs amazon_place (which speaks for the user); it
    closes once the checkout's placed, discarded, expired or failed."""
    return {"type": "approval", "title": title[:60], "text": text,
            "approve": {"tool": f"{server.NAME}_place", "arguments": {"checkout": c["id"]}},
            "resolved_by": f"amazon-checkout:{c['id']} in placed, discarded, expired or failed"}


# ---------------------------------------------------------------------------------------------
# Its tools.

REORDER_SCHEMA = {"type": "object", "properties": {
    "item": {"type": "string", "description": "What to reorder: words from its title as Your Orders shows it (\"adidas crew socks\", \"ELEGOO PLA white\"), its ASIN, or its Amazon link. With order, words that pick one of that order's items."},
    "order": {"type": "string", "description": "Or the past order it was in, like 111-5916054-8940234 (its item, when it had one; else item picks it)."},
    "quantity": {"type": "integer", "description": "How many (default 1)."},
    "variant": {"type": "object", "description": "A different size, color or the like than last time, like {\"Size\": \"X-Large\"}: the same product's variant with these values and the rest as before."},
    "address": {"type": "string", "description": "Words that pick one of Amazon's saved addresses (default: config's address)."},
    "card": {"type": "string", "description": "The last four digits of a saved card (default: config's card)."},
    "max_total": {"type": "number", "description": "The most it may come to, tax and all. Default: what the same items cost last time ×1.35 plus tax; needed to place an item never bought before."},
    "place": {"type": "boolean", "description": "Place the order once everything checks out (default false: stop at the checkout, hold the tab, and answer an approval to put up). Only when the user asked for this in so many words."},
    "again": {"type": "boolean", "description": "Order even though Amazon shows an order of it from today, or an attempt of mine may have gone in."},
    "notify": {"type": "boolean", "description": "Notify the user once it's ordered (default true)."},
}}


@app.tool(name="reorder", speaks_for_person=True, open_world=True, schema=REORDER_SCHEMA)
def reorder(item: str = None, order: str = None, quantity: int = 1, variant: dict = None, address: str = None, card: str = None,
            max_total: float = None, place: bool = False, again: bool = False, notify: bool = True, ctx=None):
    """Buy again something the user has bought on Amazon, in one step: finds it in their order history (words from its
    title, its ASIN or link, or the order), opens that exact variant (variant changes a size or color), checks it's in
    stock, presses Buy Now (a checkout of it alone; their cart stays out of it), sets the address and
    card (config's, unless given), and checks the checkout: one item, that title and quantity, no Subscribe & Save, the
    address, the card, the total under the ceiling. Without place it stops there, holds the tab, and answers the
    checkout (total, arrival, a screenshot) with an approval to put up as it is; place sends it later. With place:
    true it presses Place your order once, confirms the order in Your Orders, records amazon-order:<number> and
    notifies the user. Refuses an item Amazon shows ordered today unless again. Spends the user's money: place only for an
    item they asked to reorder in so many words. When Amazon puts up its human check, a
    sign-in or a code, it answers needs_person with the ask to put up (the tab held on it)."""
    return reorder_item(item, order, quantity, variant, address, card, max_total, place, again, notify, ctx)


@app.tool(name="place", speaks_for_person=True, open_world=True, schema={"type": "object", "required": ["checkout"], "properties": {
    "checkout": {"type": "string", "description": "The checkout's id, as reorder or checkout answered it."},
    "max_total": {"type": "number", "description": "The most it may come to now, if the user agreed to more than the checkout's total when it was built."},
    "notify": {"type": "boolean", "description": "Notify the user once it's ordered (default true)."}}})
def place(checkout: str, max_total: float = None, notify: bool = True, ctx=None):
    """Press Place your order on a checkout reorder or checkout built and held, once the user approved it (its approval's
    Approve runs this itself): reads it again first and refuses if anything changed (the items, quantities, address,
    card, or a total above what they saw), then confirms the order in Your Orders (every order Amazon split it into),
    records amazon-order:<number>, puts the cart's other lines back as they were ticked, notifies the user and lets the
    tab go. Spends the user's money: only with their approval of that checkout."""
    health["calls"] += 1
    cid = checkout.strip().split(":")[-1]
    c = load_state()["checkouts"].get(cid)
    if not c:
        raise ReorderError(f"There's no checkout {cid} of mine")
    if c.get("state") == "placed":
        return {"placed": True, "already": True, "order": c.get("order"), "checkout": cid}
    if c.get("state") != "waiting":
        raise ReorderError(f"Checkout {cid} is {c.get('state')}, so there's nothing to place; reorder again")
    if c.get("held_until") and now_ms() > c["held_until"]:
        raise ReorderError(f"Checkout {cid} was held only until {datetime.fromtimestamp(c['held_until'] / 1000, timezone.utc):%Y-%m-%d %H:%MZ}; reorder again")
    if not _busy.acquire(timeout=5):
        raise ReorderError("Another Amazon checkout is being built right now; wait for it")
    try:
        ceiling = max(money(c.get("total")) or 0, float(max_total or 0)) or None
        return place_checkout(c, ceiling, notify, ctx)
    except Blocked as e:
        return needs_person(e, c["session"], f"placing the order of {(c.get('title') or '')[:60]}", config(), ctx)
    except AfterPlace as e:
        return needs_person(e.blocked, c["session"], f"placing the order of {(c.get('title') or '')[:60]}", config(), ctx, after_place=True)
    except Exception as e:
        failed(e)
        raise
    finally:
        _busy.release()


@app.tool(name="discard", open_world=True, schema={"type": "object", "required": ["checkout"], "properties": {
    "checkout": {"type": "string", "description": "The checkout's id, as reorder or checkout answered it."}}})
def discard(checkout: str):
    """Drop a held checkout (the user declined, or it's moot) and put the cart back: a reorder's stray Buy Now line taken
    off; for a checkout of the cart, the lines ticked as they were and what it added taken off. Lets the tab go.
    Nothing is ordered."""
    health["calls"] += 1
    cid = checkout.strip().split(":")[-1]
    c = load_state()["checkouts"].get(cid)
    if not c:
        raise ReorderError(f"There's no checkout {cid} of mine")
    if c.get("state") == "placed":
        raise ReorderError(f"Checkout {cid} was placed already (order {c.get('order')}); nothing to drop")
    if not _busy.acquire(timeout=5):
        raise ReorderError("Another Amazon checkout is being built right now; wait for it")
    try:
        return {"discarded": cid, "cart": drop_checkout(c, "discarded")}
    finally:
        _busy.release()


def drop_checkout(c, state):
    """Lets a held checkout go without ordering: the cart put back (Buy Now's line taken off; for a cart checkout,
    the lines ticked as they were and what it added taken off), its tab released, its state set."""
    try:
        note = put_cart_back(c)
    except (ReorderError, Blocked) as e:
        note = f"not checked ({e})"[:200]
    release(c["session"])
    c["state"] = state
    c["cart_after"] = note
    update_state(lambda st: st["checkouts"].__setitem__(c["id"], c))
    record_checkout(c)
    return note


def expire_stale():
    """Checkouts held past their time, which nobody placed or discarded, are dropped as expired, so their tab and
    any cart line Buy Now left don't linger, and the approval put up for them closes itself."""
    stale = [c for c in load_state()["checkouts"].values()
             if c.get("state") == "waiting" and c.get("held_until") and now_ms() > c["held_until"]]
    if not stale or not _busy.acquire(blocking=False):
        return []
    try:
        return [(c["id"], drop_checkout(c, "expired")) for c in stale]
    finally:
        _busy.release()


# ---------------------------------------------------------------------------------------------
# What products are: their pages' spec tables and bullets, read for several at once, and lined up.

MAX_SPECS = 12
"""The most product pages specs reads in one call (search's details: 10)."""

SPEC_ALIASES = {
    "od": ["outside diameter", "outer diameter", "=diameter"], "outer diameter": ["outside diameter", "outer diameter", "=diameter"],
    "outside diameter": ["outside diameter", "outer diameter", "=diameter"],
    "id": ["inside diameter", "inner diameter"], "inner diameter": ["inside diameter", "inner diameter"],
    "inside diameter": ["inside diameter", "inner diameter"],
    "wall": ["wall thickness", "thickness"], "thickness": ["thickness"],
    "rpm": ["rotational speed", "rpm"], "max rpm": ["maximum rotational speed", "rotational speed", "rpm"],
    "watts": ["wattage", "power"], "watt": ["wattage", "power"], "power": ["wattage", "power", "horsepower"],
    "volts": ["voltage"], "volt": ["voltage"],
    "weight": ["weight"], "size": ["size", "dimensions"], "length": ["length", "dimensions"], "width": ["width", "dimensions"],
    "height": ["height", "dimensions"], "dimensions": ["dimensions"], "material": ["material"], "model": ["model number", "model name", "model"],
    "maker": ["manufacturer", "brand"], "made by": ["manufacturer", "brand"],
}
"""What to look for among a product's spec rows when asked for a spec in a word Amazon doesn't use: each in turn,
every word of it in the row's name (Amazon says Outside Diameter, Maximum Rotational Speed, Wattage); =diameter only a
row named just that, so an OD never answers with an Inside Diameter."""


def spec_words(s):
    """A spec's name as words to match on: lower case, singular-ish, punctuation gone."""
    return [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in norm(s).split()]


def spec_value(sheet, want):
    """The value of the spec asked for, in plain words, from a product's variant (its own size or length) and spec
    rows: {value, from: the row's name}; else where its title, bullets or description mention it: {value, mentioned,
    from} (value the measurement by the words, like 2.75" from 2.75" ID, or None); else {value: None}."""
    rows = list((sheet.get("variant") or {}).items()) + list((sheet.get("specs") or {}).items())
    for look in SPEC_ALIASES.get(" ".join(norm(want).split()), [want]):
        exact = look.startswith("=")
        words = spec_words(look.lstrip("="))
        hits = [(len(spec_words(k)) - len(words), i, k, v) for i, (k, v) in enumerate(rows)
                if words and (spec_words(k) == words if exact else all(w in spec_words(k) for w in words))]
        if hits:
            _, _, k, v = min(hits)
            return {"value": v, "from": k}
    words, first = spec_words(want), None
    for where_, texts in (("title", [sheet.get("title") or ""]), ("about", sheet.get("about") or []), ("description", [sheet.get("description") or ""])):
        for t in texts:
            low = norm(t)
            if words and all(re.search(r"\b" + re.escape(w), low) for w in words):
                m = re.search(r"\b" + re.escape(words[0]), t, re.I) or re.search(re.escape(want), t, re.I)
                at = m.start() if m else 0
                snippet = ("…" if at > 50 else "") + t[max(0, at - 50):at + 70].strip() + ("…" if at + 70 < len(t) else "")
                found = {"value": measure_near(t, want), "mentioned": snippet, "from": where_}
                if found["value"]:
                    return found
                first = first or found
    return first or {"value": None}


NUMBER = r"\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?(?:\s+\d+/\d+|/\d+)?"
UNIT = r"(?:\"|''|inch(?:es)?\b|in\b|mm\b|cm\b|rpm\b|watts?\b|w\b|amps?\b|volts?\b|v\b|lbs?\b|pounds?\b|oz\b|ounces?\b|kg\b|g\b|hp\b|gauge\b|ga\b)"
UNIT_WORDS = {"rpm", "amp", "amps", "volt", "volts", "watt", "watts", "hp", "gauge", "lb", "lbs", "oz", "mm", "inch", "inches"}


def measure_near(text, want):
    """The measurement a text gives the spec asked for, when it sits right by its word: 2.75" ID, 1/4" collet,
    28000 RPM, Collet Size: 1/4". None when there's no number by it."""
    word = r"\b" + r"\s+".join(re.escape(w) for w in norm(want).split()) + r"s?\b"
    m = re.search(r"(?<![\d.])(" + NUMBER + r")\s*(" + UNIT + r")?\s*-?\s*" + word, text, re.I)
    if not m:
        m = re.search(word + r"[^\d.]{0,12}?(?<![\d.])(" + NUMBER + r")\s*(" + UNIT + r")?", text, re.I)
    if not m:
        return None
    value = (m.group(1) + (m.group(2) or "")).strip()
    if not m.group(2) and norm(want) in UNIT_WORDS:
        value += " " + want.strip()
    return value


def natural(v):
    """A sort key that puts 4 inches before 10 inches."""
    return [(0, float(x), "") if re.fullmatch(r"\d+(?:\.\d+)?", x) else (1, 0.0, x.lower()) for x in re.findall(r"\d+(?:\.\d+)?|[^\d\s]+", str(v))]


SHEET_KEYS = ("asin", "title", "brand", "price", "rating", "ratings", "seller", "ships_from", "availability", "unavailable", "delivery",
              "variant", "about", "specs", "rank", "description")


def spec_sheet(page, asin, want=(), brief=False):
    """A product page as read, as specs answers it: what it is (SHEET_KEYS), its other variants with their ASINs,
    what the user bought of it, and with want the specs asked for. brief leaves out its bullets, description and the
    variants themselves (search's details). A page that's gone or failed says so."""
    link = f"{BASE}/dp/{asin}"
    page = page or {}
    if page.get("error"):
        return {"asin": asin, "error": page["error"], "link": link}
    if page.get("gone") or (page.get("status") == 404 and not page.get("title")):
        return {"asin": asin, "gone": True, "link": link,
                "says": f"Amazon has no page for {asin} any more ({page.get('page_title') or 'Page Not Found'}): the listing is gone"}
    if not page.get("title"):
        return {"asin": asin, "error": f"Amazon's page for {asin} isn't a product page ({page.get('page_title') or page.get('url')})", "link": link}
    s = {k: page.get(k) for k in SHEET_KEYS}
    s["asin"] = page.get("asin") or asin
    dims = page.get("dimensions") or []
    variants = sorted(({"asin": a, **{d: vals[i] for i, d in enumerate(dims) if i < len(vals)}} for a, vals in (page.get("siblings") or {}).items()),
                      key=lambda v: [natural(v.get(d, "")) for d in dims])
    if variants:
        s["variants_count"] = len(variants)
        if not brief:
            s["variants"] = variants[:60]
    if page.get("bought") or page.get("last_purchased"):
        s["purchased"] = " · ".join(x for x in (page.get("bought"), page.get("last_purchased")) if x)
    if want:
        s["wanted"] = {w: spec_value(s, w) for w in want}
    if brief:
        for k in ("about", "description"):
            s.pop(k, None)
    s["link"] = f"{BASE}/dp/{s['asin']}"
    return {k: v for k, v in s.items() if v not in (None, [], {}) or k in ("price", "seller")}


def product_pages(session, asins):
    """Each product's page, fetched side by side in the tab (the variant itself: th=1&psc=1), as PRODUCT_READER reads it."""
    pages = read_many(session, [f"/dp/{a}?th=1&psc=1" for a in asins], PRODUCT_READER, "products-many")
    health["product_pages"] = health.get("product_pages", 0) + len(pages)
    return pages


def wanted_list(want):
    """want as a list of plain words, from a list or one comma-separated string."""
    if isinstance(want, str):
        want = want.split(",")
    return [w.strip() for w in (want or []) if isinstance(w, str) and w.strip()][:10]


def comparison(sheets, want, title):
    """Products side by side: a markdown table and a table of objects, each row a product (price, stars,
    seller) with a column for each spec wanted (its value, or where its words mention it in quotes)."""
    keys = [(w, "s_" + "_".join(norm(w).split())[:40]) for w in want]
    rows = []
    for s in sheets:
        if s.get("gone") or s.get("error"):
            rows.append({"item": f"{s['asin']}: {'gone' if s.get('gone') else 'unread'}", "asin": s["asin"]})
            continue
        stars = (s.get("rating") or "").replace(" out of 5", "★")
        row = {"item": short_title(s.get("title"), 9), "price": money(s.get("price")), "rating": f"{stars} ({s['ratings']})" if stars and s.get("ratings") else stars or None,
               "seller": s.get("seller"), "asin": s["asin"]}
        for w, k in keys:
            v = (s.get("wanted") or {}).get(w) or spec_value(s, w)
            if v.get("value") and v.get("mentioned"):
                row[k] = f"{v['value']} ({v['from']})"
            elif v.get("value"):
                row[k] = v["value"]
            elif v.get("mentioned"):
                row[k] = "“" + (v["mentioned"] if len(v["mentioned"]) <= 72 else v["mentioned"][:70].rstrip() + "…") + "”"
            else:
                row[k] = None
        rows.append(row)
    columns = ([{"key": "item", "label": "Item"}, {"key": "price", "label": "Price", "format": "currency", "align": "end"},
                {"key": "rating", "label": "Stars"}, {"key": "seller", "label": "Sold by"}]
               + [{"key": k, "label": w} for w, k in keys] + [{"key": "asin", "label": "ASIN", "format": "mono"}])
    cell = lambda v: "—" if v in (None, "") else (f"${v:,.2f}" if isinstance(v, float) else str(v).replace("|", "/"))
    md = ["| " + " | ".join(c["label"] for c in columns) + " |", "|" + "---|" * len(columns)]
    md += ["| " + " | ".join(cell(r.get(c["key"])) for c in columns) + " |" for r in rows]
    return {"table": "\n".join(md), "object": {"title": title, "shape": "table", "spec": {"columns": columns, "rows": rows}}}


def reading(fn, start="/your-orders/orders", start_reader=None):
    """Runs a read in the shared reading tab, answering needs_person when Amazon is in the way."""
    health["calls"] += 1
    with _reading:
        held = False
        try:
            go(READ_SESSION, BASE + start)
            read(READ_SESSION, start_reader or ORDERS_READER, tag="signed-in")
            server.session_live("amazon")
            return fn(READ_SESSION)
        except Blocked as e:
            held = True
            return needs_person(e, READ_SESSION, "reading your Amazon orders", config(), None)
        except Exception as e:
            failed(e)
            raise
        finally:
            if not held:
                release(READ_SESSION)


@app.tool(name="find", read_only=True, schema={"type": "object", "properties": {
    "query": {"type": "string", "description": "Words to search every order for, as Amazon's order search does (\"socks\", \"PETG filament\"). Without it, the latest orders."},
    "limit": {"type": "integer", "description": "How many purchases at most (default 20)."}}})
def find(query: str = "", limit: int = 20):
    """the user's past Amazon purchases, newest first, read from Your Orders in the user's browser: with query, every
    order Amazon's search finds for it (each item's order, date, title, ASIN and link); without, the latest orders
    (date, total, status, items). For reorder's item or order."""
    def go_find(session):
        if query:
            found, count = search_history(session, query, limit)
            return {"query": query, "orders_matching": count, "purchases": [{**f, "link": f"{BASE}/dp/{f['asin']}"} for f in found[:limit]]}
        orders = recent_orders(session, pages=max(1, min(5, (limit + 9) // 10)))
        return {"orders": orders[:limit]}
    return reading(go_find)


@app.tool(name="order", read_only=True, schema={"type": "object", "required": ["order"], "properties": {
    "order": {"type": "string", "description": "The order number, like 111-5916054-8940234."}}})
def order(order: str):
    """One past Amazon order in full: when, where it shipped (the name and address), the card, its charges and total,
    and each item (title, ASIN, seller, quantity, price, how it stands)."""
    m = ORDER_RE.search(order or "")
    if not m:
        raise ReorderError(f"\"{order}\" isn't an Amazon order number (like 111-5916054-8940234)")
    return reading(lambda session: order_details(session, m.group(1)))


WANT_SCHEMA = {"type": "array", "items": {"type": "string"}, "description": (
    "Specs to line up, in plain words (\"outside diameter\", \"wall thickness\", \"length\", \"rpm\", \"collet\", \"weight\"): each "
    "product's value from its own variant and spec tables (OD, ID, rpm, watts and the like are understood), else where its title or "
    "bullets mention it.")}


@app.tool(name="item", read_only=True, schema={"type": "object", "required": ["item"], "properties": {
    "item": {"type": "string", "description": "Its ASIN or Amazon link."},
    "want": WANT_SCHEMA}})
def item(item: str, want: list = None):
    """An Amazon product as it is now: its title, brand, stars and ratings, the variant this ASIN is (size, color...)
    and every other one it comes in with its ASIN, price, availability, seller and where it ships from, Buy Now,
    delivery, its bullets and spec tables (dimensions, weight, material, wattage...), and how often and when the user last
    bought it; with want, the specs asked for. A listing Amazon took down says it's gone. specs reads several at once."""
    asin = asin_of(item)
    if not asin:
        raise ReorderError("Give the item's ASIN or link (find turns words into one)")
    want = wanted_list(want)
    def look(session):
        go(session, f"{BASE}/dp/{asin}?th=1&psc=1")
        p = read(session, PRODUCT_READER, tag="product")
        if p.get("gone") or not p.get("title"):
            return spec_sheet(p, asin)
        dims = p.get("dimensions") or []
        sheet = spec_sheet(p, asin, want)
        p["offered"] = {d: sorted({v[i] for v in (p.get("siblings") or {}).values() if len(v) > i}, key=natural) for i, d in enumerate(dims)}
        p.pop("siblings", None)
        p.pop("gone", None)
        p.pop("page_title", None)
        for k in ("variants", "variants_count", "wanted"):
            if k in sheet:
                p[k] = sheet[k]
        p["link"] = f"{BASE}/dp/{asin}"
        return p
    return reading(look)


@app.tool(name="search", read_only=True, schema={"type": "object", "required": ["query"], "properties": {
    "query": {"type": "string", "description": "What to look for, as you'd type it in Amazon's search box (\"PTFE sheet 1/8\", \"Bambu P1S hardened steel hotend 0.6\")."},
    "limit": {"type": "integer", "description": "How many results at most (default 12)."},
    "sponsored": {"type": "boolean", "description": "Keep sponsored results (default false: left out)."},
    "details": {"type": "integer", "description": "Also read the first this many results' own pages (at most 10, side by side; a few seconds each): who sells and ships each, its brand, availability and its spec tables, lined up as a comparison (default 0)."},
    "want": WANT_SCHEMA}})
def search(query: str, limit: int = 12, sponsored: bool = False, details: int = 0, want: list = None):
    """Amazon's product search, as the user's account sees it (their Prime delivery dates): each result's ASIN, title,
    price (and list price), stars and how many ratings, how many bought last month, delivery, and link; with details,
    the first few results' pages read too (seller, ships from, brand, availability, spec tables, the specs wanted) and
    lined up in a comparison (table, and objects). For finding an ASIN to put in the cart
    (cart_add, checkout) or to compare."""
    if not norm(query):
        raise ReorderError("Say what to search for")
    want = wanted_list(want)
    def look(session):
        got = read(session, PRODUCTS_READER, "/s?k=" + re.sub(r"\s+", "+", "".join(c if c.isalnum() or c in " -./" else " " for c in query).strip()), "products")
        rows = [r for r in got["results"] if sponsored or not r.get("sponsored")]
        seen, out = set(), []
        for r in rows:
            if r["asin"] in seen:
                continue
            seen.add(r["asin"])
            out.append({**r, "link": f"{BASE}/dp/{r['asin']}"})
        out = out[:max(1, int(limit or 12))]
        answer = {"query": query, "results": out, "sponsored_left_out": 0 if sponsored else sum(1 for r in got["results"] if r.get("sponsored"))}
        n = max(0, min(int(details or 0), 10, len(out)))
        if n:
            sheets = [spec_sheet(p, r["asin"], want, brief=True) for r, p in zip(out[:n], product_pages(session, [r["asin"] for r in out[:n]]))]
            for r, sh in zip(out, sheets):
                for k in ("seller", "ships_from", "brand", "availability", "unavailable", "variant", "variants_count", "specs", "rank",
                          "wanted", "purchased", "gone", "says", "error"):
                    if k in sh:
                        r[k] = sh[k]
                if sh.get("price") and not r.get("price"):
                    r["price"] = sh["price"]
            answer.update(comparison(sheets, want, f"Amazon: {query}"))
        return answer
    return reading(look, "/gp/cart/view.html", CART_READER)


@app.tool(name="specs", read_only=True, schema={"type": "object", "required": ["items"], "properties": {
    "items": {"type": "array", "items": {"type": "string"}, "description": f"Up to {MAX_SPECS} ASINs or Amazon links (search turns words into them)."},
    "want": WANT_SCHEMA}})
def specs(items: list, want: list = None):
    """What Amazon products are, read off their own pages, several at once (side by side in the user's browser, as
    the user's account sees them): each one's title, brand, price, stars and ratings, who sells it and where it ships from,
    availability and delivery, the variant it is and every other one with its ASIN (another length or size to buy),
    its bullets, every row of its spec tables (dimensions, weight, material, wattage, model...), its best-seller rank
    and what the user bought of it; a listing that's gone says so. want lines the specs up: each product's value, and a
    comparison (table, and objects). For choosing among search's results, or checking an
    item is the right one before cart_add."""
    asins, bad = [], []
    for x in items if isinstance(items, list) else [items]:
        a = asin_of(x if isinstance(x, str) else (x or {}).get("item", ""))
        (asins if a else bad).append(a or x)
    if bad:
        raise ReorderError(f"Not ASINs or Amazon links: {', '.join(map(str, bad))[:200]} (search turns words into them)")
    asins = list(dict.fromkeys(asins))
    if not asins:
        raise ReorderError("Give the products' ASINs or links")
    if len(asins) > MAX_SPECS:
        raise ReorderError(f"At most {MAX_SPECS} at once ({len(asins)} given)")
    want = wanted_list(want)
    def look(session):
        sheets = [spec_sheet(p, a, want) for a, p in zip(asins, product_pages(session, asins))]
        answer = {"products": sheets}
        gone = [s["asin"] for s in sheets if s.get("gone")]
        if gone:
            answer["gone"] = gone
        if len(sheets) > 1 or want:
            answer.update(comparison(sheets, want, "Amazon: " + ", ".join(short_title(s.get("title"), 4) for s in sheets if s.get("title"))[:80]))
        return answer
    return reading(look, "/gp/cart/view.html", CART_READER)


@app.tool(name="offers", read_only=True, schema={"type": "object", "required": ["item"], "properties": {
    "item": {"type": "string", "description": "Its ASIN or Amazon link."},
    "limit": {"type": "integer", "description": "How many offers at most (default 15)."}}})
def offers(item: str, limit: int = 15):
    """Who sells an Amazon product, from its "Other sellers" panel: the featured offer (the one Add to Cart takes) and
    the rest, each with its price, condition, seller and rating, where it ships from, and delivery. For choosing a
    seller for cart_add or checkout (seller: words of its name, or "amazon")."""
    asin = asin_of(item)
    if not asin:
        raise ReorderError("Give the item's ASIN or link (search turns words into one)")
    def look(session):
        got = offers_for(session, asin, pages=2)
        rows = [{k: v for k, v in o.items() if k != "form"} for o in got["offers"]]
        return {"asin": asin, "title": got.get("title"), "offers_on_amazon": got.get("total"), "offers": rows[:max(1, int(limit or 15))],
                "link": f"{BASE}/dp/{asin}"}
    return reading(look, "/gp/cart/view.html", CART_READER)


@app.tool(name="cart", read_only=True)
def cart():
    """the user's Amazon cart as it is now: each line (ASIN, title, quantity, price, whether it's ticked for checkout,
    out of stock, delivery, and whether I put it there), the subtotal of what's ticked, and how many are saved for
    later."""
    def look(session):
        page = cart_page(session)
        note_cart(page)
        ids, _ = mine()
        lines = [{**l, "added_by_me": l["id"] in ids, "link": f"{BASE}/dp/{l['asin']}"} for l in page["items"]]
        return {"lines": lines, "ticked": sum(1 for l in lines if l.get("selected")), "subtotal": page.get("subtotal"),
                "subtotal_label": page.get("subtotal_label"), "saved_for_later": page.get("saved_for_later"),
                "waiting_checkouts": [{"id": c["id"], "title": c.get("title"), "total": c.get("total")} for c in waiting_cart_checkouts()]}
    return reading(look, "/gp/cart/view.html", CART_READER)


ITEMS_SCHEMA = {"type": "array", "items": {"anyOf": [
    {"type": "string", "description": "An ASIN or Amazon link: one, from the featured offer."},
    {"type": "object", "required": ["item"], "properties": {
        "item": {"type": "string", "description": "Its ASIN or Amazon link."},
        "quantity": {"type": "integer", "description": "How many (default 1; in checkout, a line already in the cart keeps its own)."},
        "seller": {"type": "string", "description": "Whose offer: words of the seller's name as offers shows it, or \"amazon\" for Amazon itself (default: the featured offer)."},
        "condition": {"type": "string", "description": "\"used\", \"like new\" or \"any\" to allow other than new (default: new only)."}}}]}}


def changing_cart(fn):
    """Runs a change to the cart in a tab of its own, one at a time with checkouts, putting back first a cart that a
    stopped checkout left changed; needs_person when Amazon is in the way."""
    health["calls"] += 1
    if not _busy.acquire(timeout=5):
        raise ReorderError("An Amazon checkout is being built right now; wait for it")
    session = f"{READ_SESSION}-{secrets.token_hex(3)}"
    held = False
    try:
        let_go_of_blocked()
        go(session, f"{BASE}/gp/cart/view.html")
        read(session, CART_READER, tag="cart-live")
        put_back = restore_pending(session)
        out = fn(session)
        if put_back:
            out["cart_put_back_first"] = put_back
        return out
    except Blocked as e:
        held = True
        return needs_person(e, session, "changing your Amazon cart", config(), None)
    except Exception as e:
        failed(e)
        raise
    finally:
        if not held:
            release(session)
        _busy.release()


@app.tool(name="cart_add", open_world=True, schema={"type": "object", "required": ["items"], "properties": {
    "items": {**ITEMS_SCHEMA, "description": "What to put in the cart: ASINs or links, or {item, quantity, seller, condition}."},
    "untick": {"type": "boolean", "description": "Leave the new lines unticked for checkout (default: as Amazon puts them, ticked; unticked anyway while a checkout of the cart waits for the user, so it can't change)."}}})
def cart_add(items: list, untick: bool = False, ctx=None):
    """Put items in the user's Amazon cart, any number in one call, bought before or never: for each, the featured offer
    (or the seller's asked), new unless condition says otherwise, added through Amazon's own add-to-cart form and
    checked in the cart afterwards (tried once more when it didn't take). Answers what went in (title, seller, price,
    delivery), what didn't and why, and the cart after. Nothing is bought; checkout builds an order from the cart."""
    wanted = wanted_items(items)
    if not wanted:
        raise ReorderError("Say what to put in the cart")
    def add(session):
        done, failed = [], []
        for w in wanted:
            try:
                done.append(add_one(session, w["asin"], w["quantity"] or 1, w["seller"], w["condition"], ctx=ctx))
            except ReorderError as e:
                failed.append({"item": w["asin"], "error": str(e)})
        hold_back = untick or bool(waiting_cart_checkouts())
        page = cart_page(session)
        if hold_back:
            ops = [{"id": d["line"], "select": False} for d in done if d.get("new_line")]
            page = cart_ops(session, ops, ctx) if ops else page
            for d in done:
                d["selected"] = next((l.get("selected") for l in page["items"] if l["id"] == d["line"]), d.get("selected"))
        note_cart(page)
        out = {"added": done, "failed": failed, "cart": {"lines": len(page["items"]), "ticked": sum(1 for l in page["items"] if l.get("selected")),
                                                        "subtotal": page.get("subtotal"), "subtotal_label": page.get("subtotal_label")}}
        if hold_back and not untick:
            out["note"] = "A checkout of the cart is waiting for the user, so the new lines are unticked and stay out of it."
        return out
    return changing_cart(add)


@app.tool(name="cart_remove", open_world=True, schema={"type": "object", "required": ["items"], "properties": {
    "items": {"type": "array", "items": {"type": "string"}, "description": "ASINs or links of the lines to take off (every line of each)."},
    "anyway": {"type": "boolean", "description": "Also lines I didn't put there: only when the user asked for exactly that."}}})
def cart_remove(items: list, anyway: bool = False, ctx=None):
    """Take lines off the user's Amazon cart: ones I put there (cart_add or checkout), or with anyway their own when they asked.
    Refuses a line in a checkout of the cart that's waiting for them. Answers what went and the cart after."""
    asins = [asin_of(i) for i in items or []]
    if not asins or not all(asins):
        raise ReorderError("Give the ASINs or links of the lines to take off")
    def remove(session):
        page = cart_page(session)
        ids, mine_asins = mine()
        held = {i for c in waiting_cart_checkouts() for i in c.get("want_ids") or []}
        ops, refused, missing = [], [], []
        for a in asins:
            lines = lines_of(page, a)
            if not lines:
                missing.append(a)
            for l in lines:
                if l["id"] in held:
                    refused.append(f"{a}: it's in a checkout waiting for the user (discard that first)")
                elif not anyway and l["id"] not in ids and a not in mine_asins:
                    refused.append(f"{a}: the user put it there, not me (anyway: true only when they asked)")
                else:
                    ops.append({"id": l["id"], "remove": True})
        after = cart_ops(session, ops, ctx) if ops else page
        note_cart(after)
        still = {l["id"] for l in after["items"]}
        gone = [o["id"] for o in ops if o["id"] not in still]
        return {"removed": len(gone), "not_removed": [o["id"] for o in ops if o["id"] in still], "refused": refused, "not_in_cart": missing,
                "cart": {"lines": len(after["items"]), "ticked": sum(1 for l in after["items"] if l.get("selected")), "subtotal": after.get("subtotal")}}
    return changing_cart(remove)


@app.tool(name="checkout", open_world=True, schema={"type": "object", "properties": {
    "items": {**ITEMS_SCHEMA, "description": "What the order is: ASINs or links, or {item, quantity, seller, condition}. Lines already in the cart are used (quantity changes theirs); the rest are added. Leave it out to check out what's ticked in the cart now."},
    "delivery": {"type": "string", "description": "Delivery speed for each shipment: fastest (may cost), fastest_free, or words of an option (\"Amazon Day\", \"fewer boxes\"). Default: as Amazon picks."},
    "address": {"type": "string", "description": "Words that pick one of Amazon's saved addresses (default: config's address)."},
    "card": {"type": "string", "description": "The last four digits of a saved card (default: config's card)."},
    "max_total": {"type": "number", "description": "The most it may come to, tax and all; over it, it stops."}}})
def checkout(items: list = None, delivery: str = None, address: str = None, card: str = None, max_total: float = None, ctx=None):
    """Build an Amazon checkout of exactly these items from the user's cart, and stop before Place your order: adds what
    isn't in the cart yet, sets quantities, ticks only these lines (remembering how the others were ticked), presses
    Proceed to checkout, gets past "Need anything else?", sets the address and card (config's, unless given)
    and the delivery speed, then reads every item's price, seller and arrival date and checks it all: those items
    and no others, each quantity and asked seller, no Subscribe & Save, the address, the card, the total. It holds
    the tab and answers the checkout with an approval to put up as it is, whose Approve runs place (which puts the
    cart's other lines back as they were ticked); discard drops it and puts the cart back, taking off what it added.
    Nothing is ordered here."""
    return checkout_cart(items, address, card, delivery, max_total, ctx)


@app.tool(name="status", read_only=True)
def status():
    """How the Amazon errand is: the checkouts it holds for the user (and until when), the orders it placed lately, what it
    put in their cart lately, what it uses by default (address, card, ceiling), the "I am human" boxes it ticked and the
    last time Amazon wanted a human step, and its calls, failures and last error."""
    st = load_state()
    cfg = config()
    waiting = [{k: c.get(k) for k in ("id", "kind", "title", "quantity", "total", "ship_to", "card", "held_until", "session")}
               for c in st["checkouts"].values() if c.get("state") == "waiting" and (c.get("held_until") or 0) > now_ms()]
    return {"health": dict(health), "browser": BROWSER,
            "defaults": {k: cfg[k] for k in ("address", "card", "card_name", "ceiling_factor", "hold_hours", "again_hours", "tick_human_box")},
            "waiting": waiting, "orders": st["orders"][-5:], "attempts": st["attempts"][-5:], "added_lately": st["added"][-10:],
            "human_boxes_ticked": st["human_boxes"][-5:], "cart_left_changed": st.get("restore")}


def heartbeat():
    """Says how it is, in the extension's vitals."""
    failing = health["failing"]
    app.emit("heartbeat", {"entity": f"sense:{server.NAME}-{PART}", "summary": f"Can't reach Amazon: {failing}" if failing else "Ready",
                           "facts": dict(health)})


@app.background
def beat():
    while True:
        try:
            expire_stale()
        except Exception as e:
            health["last_error"] = f"expiring held checkouts: {type(e).__name__}: {e}"[:400]
        heartbeat()
        time.sleep(EXPIRE_S)
