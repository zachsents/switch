// Runs in a facebook.com tab of the user's Chrome, signed in to Facebook, through the browser
// extension's browser_js. search.py replaces __MPS_ARGS__ with one of:
//   {op: "templates"}   on a real Marketplace page: the queries its server preloaded (their
//                       persisted ids and variables) and the account's saved location
//   {op: "search", search: {doc_id, variables}, queries, filters, pages, pause_ms}
//                       Marketplace's own search query, page by page, for each query
//   {op: "details", pdp: {doc_id, variables}, media?: {doc_id, variables}, ids, concurrency}
//                       each listing's own page query: description, condition, seller, where;
//                       with media, its photo viewer's query too: every photo (and video)
//   {op: "whoami"}      whether Facebook is signed in here
// It reads only: no message, offer, save or click goes out. What it makes is kept in
// window.__mpsOut, and the op answers its length, for search.py to read in slices (a
// script's answer is kept small).
(async () => {
  const args = __MPS_ARGS__;
  const user = (document.cookie.match(/(?:^|;\s*)c_user=(\d+)/) || [])[1] || null;
  const done = (o) => {
    // Plain ASCII, and every run of 12 or more digits broken by ~ every four digits (a literal
    // ~ is escaped, so search.py takes every ~ out again): browsers' tools may hide what looks
    // like a card number, and a 16-digit listing id can pass for one.
    window.__mpsOut = JSON.stringify(o)
      .replace(/[\u007f-\uffff&<>~]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
      .replace(/\d{12,}/g, (m) => m.replace(/(\d{4})(?=\d)/g, "$1~"));
    return String(window.__mpsOut.length);
  };
  if (!user || location.pathname.startsWith("/checkpoint/")) return done({ signed_in: false, url: location.href });

  async function tokens() {
    const t = window.__mpsTok;
    if (t && t.user === user && Date.now() < t.until) return t;
    const r = await fetch("/ajax/dtsg/?__a=true", { credentials: "include" });
    const text = (await r.text()).replace(/^for \(;;\);/, "");
    const token = JSON.parse(text).payload.token;
    let sum = 0;
    for (const c of token) sum += c.charCodeAt(0);
    window.__mpsTok = { user, dtsg: token, jazoest: "2" + sum, until: Date.now() + 30 * 60 * 1000 };
    return window.__mpsTok;
  }

  async function graphql(name, docId, variables) {
    const t = await tokens();
    const body = new URLSearchParams({
      av: user, __user: user, __a: "1", __comet_req: "15", fb_dtsg: t.dtsg, jazoest: t.jazoest,
      fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: name,
      variables: JSON.stringify(variables), server_timestamps: "true", doc_id: docId,
    });
    const r = await fetch("/api/graphql/", {
      method: "POST", credentials: "include", body,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": name },
    });
    const text = await r.text();
    const parts = [];
    const errors = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line.replace(/^for \(;;\);/, ""));
      } catch (e) {
        errors.push("unreadable answer: " + line.slice(0, 160));
        continue;
      }
      if (j.errors) for (const e of j.errors) errors.push(String(e.message || e.summary || JSON.stringify(e)).slice(0, 300));
      if (j.error) errors.push(String(j.errorSummary || j.errorDescription || j.error).slice(0, 300));
      parts.push(j);
    }
    return { status: r.status, parts, errors };
  }

  const num = (x) => (x == null || x === "" || isNaN(Number(x)) ? null : Number(x));
  const geo = (L) => (L && L.location && L.location.reverse_geocode) || {};

  function compact(L, rank) {
    // One search result, as search.py merges and filters them.
    const g = geo(L);
    const price = L.listing_price || {};
    const seller = L.marketplace_listing_seller || {};
    const photo = L.primary_listing_photo && L.primary_listing_photo.image && L.primary_listing_photo.image.uri;
    return {
      id: String(L.id), title: L.marketplace_listing_title || L.custom_title || "",
      price: num(price.amount), price_text: price.formatted_amount || null,
      was: num(L.strikethrough_price && L.strikethrough_price.amount),
      min_price: num(L.min_listing_price && L.min_listing_price.amount),
      city: g.city || null, state: g.state || null, city_id: (g.city_page && g.city_page.id) || null,
      created: L.creation_time || null, delivery: L.delivery_types || [],
      pending: !!L.is_pending, sold: !!L.is_sold, live: L.is_live !== false, hidden: !!L.is_hidden,
      seller: seller.name || null, seller_id: seller.id || null,
      category: L.marketplace_listing_category_id || null, photo: (args.photos && photo) || null, rank,
    };
  }

  function feedOf(parts) {
    for (const p of parts) {
      const fu = p.data && p.data.marketplace_search && p.data.marketplace_search.feed_units;
      if (fu) return fu;
    }
    return null;
  }

  function searchVars(template, q, f, cursor) {
    const v = JSON.parse(JSON.stringify(template));
    v.cursor = cursor || null;
    v.count = 24;
    v.buyLocation = { latitude: f.lat, longitude: f.lon };
    v.savedSearchQuery = q;
    v.params = v.params || {};
    v.params.bqf = Object.assign({}, v.params.bqf, { query: q });
    const b = (v.params.browse_request_params = Object.assign({}, v.params.browse_request_params));
    b.filter_location_latitude = f.lat;
    b.filter_location_longitude = f.lon;
    b.filter_radius_km = f.radius_km;
    b.filter_price_lower_bound = f.min_cents || 0;
    b.filter_price_upper_bound = f.max_cents || 214748364700;
    b.commerce_search_and_rp_condition = f.condition || null;
    b.commerce_search_and_rp_ctime_days = f.ctime_days || null;
    b.commerce_enable_local_pickup = true;
    b.commerce_enable_shipping = !!f.shipping;
    b.commerce_search_and_rp_available = true;
    if (f.sort) b.commerce_search_sort_by = f.sort;
    else delete b.commerce_search_sort_by;
    return v;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (args.op === "whoami") return done({ signed_in: true, user, url: location.href });

  if (args.op === "templates") {
    // The queries this page's server preloaded, as Facebook's own client sends them.
    const found = {};
    let sample = null; // a listing the page shows, whose own page holds the listing query
    const walk = (x, d) => {
      if (!x || typeof x !== "object" || d > 60) return;
      if (x.queryName && x.queryID && x.variables && x.preloaderID) {
        if (!found[x.queryName]) found[x.queryName] = { doc_id: String(x.queryID), variables: x.variables };
      }
      if (!sample && x.marketplace_listing_title !== undefined && x.id && x.is_live !== false) sample = String(x.id);
      for (const k in x) walk(x[k], d + 1);
    };
    let place = null;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent;
      if (t.includes("preloaderID") || (!sample && t.includes("marketplace_listing_title"))) {
        try { walk(JSON.parse(t), 0); } catch (e) {}
      }
      if (!place) {
        const m = t.match(/"location":\{"radius":(\d+(?:\.\d+)?),"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)/);
        if (m) place = { radius_km: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
      }
    }
    // Chat popups Facebook restores on load could show a reply as read: minimize them at once.
    let minimized = 0;
    for (const b of document.querySelectorAll('[aria-label="Minimize chat"]')) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { b.click(); minimized++; }
    }
    return done({
      signed_in: true, user, url: location.href, place, minimized, sample,
      search: found.CometMarketplaceSearchContentContainerQuery || null,
      pdp: found.MarketplacePDPContainerQuery || null,
      media: found.MarketplacePDPC2CMediaViewerWithImagesQuery || null,
      names: Object.keys(found).filter((n) => /Marketplace/.test(n)),
    });
  }

  if (args.op === "search") {
    // Two queries at a time, each paged through in turn.
    const f = args.filters;
    const results = args.queries.map((q) => ({ query: q, pages: 0, items: [], errors: [], has_next: false }));
    const t0 = Date.now();
    const todo = results.slice();
    const one = async (r) => {
      const q = r.query;
      let cursor = null;
      for (let page = 0; page < (args.pages || 3); page++) {
        if (page) await sleep(args.pause_ms || 400);
        const g = await graphql("CometMarketplaceSearchContentContainerQuery", args.search.doc_id, searchVars(args.search.variables, q, f, cursor));
        const fu = feedOf(g.parts);
        if (!fu) {
          r.errors.push(g.errors.length ? g.errors.join("; ") : "no results in Facebook's answer (status " + g.status + ")");
          break;
        }
        r.pages++;
        for (const e of fu.edges || []) {
          const n = e && e.node;
          if (!n || !n.listing || n.__typename === "MarketplaceFeedAdStory") continue;
          r.items.push(compact(n.listing, r.items.length + 1));
        }
        const pi = fu.page_info || {};
        r.has_next = !!pi.has_next_page;
        if (!r.has_next || !pi.end_cursor || cursor === pi.end_cursor) break;
        cursor = pi.end_cursor;
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(2, todo.length); w++) {
      workers.push((async () => {
        if (w) await sleep(200);
        while (todo.length) {
          const r = todo.shift();
          try { await one(r); } catch (e) { r.errors.push(String(e).slice(0, 300)); }
        }
      })());
    }
    await Promise.all(workers);
    return done({ signed_in: true, results, ms: Date.now() - t0 });
  }

  const NO_CAPTION = /^No photo description available\.?$/i;
  const photoOf = (p) => p && p.image && p.image.uri ? {
    uri: p.image.uri, width: num(p.image.width), height: num(p.image.height),
    caption: p.accessibility_caption && !NO_CAPTION.test(p.accessibility_caption) ? p.accessibility_caption : null,
  } : null;

  function videoOf(v) {
    // A video's playable link and its thumbnail, wherever the answer keeps them.
    let url = null, thumbnail = null;
    const walk = (x, k, d) => {
      if (x == null || d > 8) return;
      if (typeof x === "string") {
        if (!url && /^(playable_url_quality_hd|browser_native_hd_url|playable_url|browser_native_sd_url)$/.test(k) && /^https:/.test(x)) url = x;
        else if (!thumbnail && /^uri$/.test(k) && /^https:/.test(x)) thumbnail = x;
        return;
      }
      if (typeof x !== "object") return;
      for (const kk in x) walk(x[kk], kk, d + 1);
    };
    walk(v, "", 0);
    return { id: (v && v.id) || null, url, thumbnail };
  }

  async function photosOf(id) {
    // Every photo of a listing, as its photo viewer reads them (the listing query has none).
    const v = Object.assign(JSON.parse(JSON.stringify(args.media.variables || {})), { targetId: String(id) });
    const g = await graphql("MarketplacePDPC2CMediaViewerWithImagesQuery", args.media.doc_id, v);
    let T = null;
    const find = (x, d) => {
      if (!x || typeof x !== "object" || d > 30 || T) return;
      if (Array.isArray(x.listing_photos) && String(x.id) === String(id)) { T = x; return; }
      for (const k in x) find(x[k], d + 1);
    };
    g.parts.forEach((p) => find(p.data, 0));
    if (!T) return { error: g.errors.length ? g.errors.join("; ") : "no photos in Facebook's answer (status " + g.status + ")" };
    return {
      photos: T.listing_photos.map(photoOf).filter(Boolean),
      videos: (T.pre_recorded_videos || []).map(videoOf),
    };
  }

  if (args.op === "details") {
    const out = {};
    const errors = {};
    const ids = args.ids.slice();
    const one = async (id) => {
      const media = args.media ? photosOf(id).catch((e) => ({ error: String(e).slice(0, 300) })) : null;
      const v = Object.assign(JSON.parse(JSON.stringify(args.pdp.variables)), { targetId: String(id) });
      const g = await graphql("MarketplacePDPContainerQuery", args.pdp.doc_id, v);
      let T = null;
      const find = (x, d) => {
        if (!x || typeof x !== "object" || d > 30 || T) return;
        if (x.listing_price && ("redacted_description" in x || "attribute_data" in x) && String(x.id) === String(id)) { T = x; return; }
        for (const k in x) find(x[k], d + 1);
      };
      g.parts.forEach((p) => find(p.data, 0));
      if (!T) {
        if (media) await media;
        errors[id] = g.errors.length ? g.errors.join("; ") : "no listing in Facebook's answer (status " + g.status + "): it may be gone";
        return;
      }
      const s = T.marketplace_listing_seller || {};
      const stats = (s.marketplace_ratings_stats_by_role_v2 || {});
      const both = stats.seller_buyer_combined || {};
      const sold = stats.seller_stats || {};
      const attrs = (T.attribute_data || []).map((a) => ({ name: a.attribute_name, value: a.value, label: a.label }));
      const cond = attrs.find((a) => a.name === "Condition");
      const m = media ? await media : null;
      const photos = m && m.photos ? m.photos : (T.listing_photos || []).map(photoOf).filter(Boolean);
      const loc = T.location || T.item_location || {};
      out[id] = {
        id: String(id), title: T.marketplace_listing_title || T.base_marketplace_listing_title || "",
        price: num(T.listing_price && T.listing_price.amount),
        price_text: (T.listing_price && (T.listing_price.formatted_amount_zeros_stripped || T.listing_price.formatted_amount)) || null,
        was_text: (T.strikethrough_price && (T.strikethrough_price.formattedAmountWithoutDecimals || T.strikethrough_price.formatted_amount)) || null,
        description: (T.redacted_description && T.redacted_description.text) || "",
        condition: cond ? cond.label : null, condition_key: cond ? cond.value : null,
        attributes: attrs.filter((a) => a.name !== "Condition"),
        place: (T.location_text && T.location_text.text) || null,
        lat: num(loc.latitude), lon: num(loc.longitude),
        created: T.creation_time || null, delivery: T.delivery_types || [],
        shipping_offered: !!T.is_shipping_offered,
        shipping_price: (T.formatted_shipping_price && (T.formatted_shipping_price.text || T.formatted_shipping_price)) || null,
        pending: !!T.is_pending, sold: !!T.is_sold, live: T.is_live !== false, hidden: !!T.is_hidden,
        inventory: T.inventory_count == null ? null : T.inventory_count,
        messaged: !!T.has_viewer_messaged,
        seller: {
          name: s.name || null, id: s.id || null,
          rating: num(sold.five_star_ratings_average) != null ? num(sold.five_star_ratings_average) : num(both.five_star_ratings_average),
          ratings: num(sold.five_star_total_rating_count_by_role) != null ? num(sold.five_star_total_rating_count_by_role) : num(both.five_star_total_rating_count_by_role),
          join_time: s.join_time || null,
        },
        category: T.marketplace_listing_category_id || null,
        photos: photos.slice(0, 40),
        videos: (m && m.videos) || [],
        media_error: (m && m.error) || null,
      };
    };
    const n = Math.max(1, Math.min(args.concurrency || 3, 5));
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        while (ids.length) {
          const id = ids.shift();
          try { await one(id); } catch (e) { errors[id] = String(e).slice(0, 300); }
          await sleep(args.pause_ms || 250);
        }
      })());
    }
    await Promise.all(workers);
    return done({ signed_in: true, items: out, errors });
  }

  return done({ error: "unknown op " + args.op });
})()
