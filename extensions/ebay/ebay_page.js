// Runs in the eBay search page (sold or active) in the user's Chrome and reads the
// result cards back as plain text fields, nothing parsed: ebay.py makes sense of
// them, so a change to eBay's wording is fixed (and tested) in one place.
// What it read stays in the tab (window.__ebayComps, as JSON text) and comes
// back in pieces, since the browser action cuts a long answer: each answer is
// @@EC@@ then JSON {len, end, part}, and ebay.py asks for the rest from end
// (offsets in the page's own UTF-16 units; a piece never splits an emoji).
(() => {
  const text = (e) => (e ? e.innerText.replace(/\s+/g, " ").trim() : "");
  const all = (root, sel) => [...root.querySelectorAll(sel)].map(text).filter(Boolean);
  const body = document.body ? document.body.innerText.slice(0, 600) : "";
  const challenge =
    /\/splashui\/|captcha|\/challenge/i.test(location.href) ||
    /pardon our interruption|please verify yourself|checking your browser|verify you are a human/i.test(document.title + " " + body);
  const list = document.querySelector("ul.srp-results");
  const rows = list ? [...list.children] : [];
  const layout = rows.some((li) => li.matches("li.s-card")) ? "s-card" : rows.some((li) => li.matches("li.s-item")) ? "s-item" : "none";
  // eBay pads a short result with "Results matching fewer words": stop there.
  const cutAt = rows.findIndex((li) => /REWRITE_START/.test(li.className) || /^results matching fewer words/i.test(text(li)));
  const exact = cutAt >= 0 ? rows.slice(0, cutAt) : rows;
  const card = (li) => {
    const s = layout === "s-card";
    const link = li.querySelector(s ? "a.s-card__link" : "a.s-item__link");
    const priceEl = li.querySelector(s ? ".s-card__price" : ".s-item__price");
    const id = li.getAttribute("data-listingid") || ((link && link.href.match(/\/itm\/(\d+)/)) || [])[1] || "";
    return {
      id,
      title: text(li.querySelector(s ? ".s-card__title .primary" : ".s-item__title span[role=heading], .s-item__title")),
      caption: all(li, s ? ".s-card__caption" : ".s-item__caption, .s-item__title--tag, .s-item__ended-date").join(" | "),
      price: text(priceEl),
      strike: text(li.querySelector(".strikethrough, .STRIKETHROUGH, .s-item__trending-price .STRIKETHROUGH")),
      subtitles: all(li, s ? ".s-card__subtitle" : ".s-item__subtitle"),
      rows: all(li, s ? ".su-card-container__attributes__primary .s-card__attribute-row" : ".s-item__details > *").filter((r) => !/^(view similar|sell one like this|benefits charity)/i.test(r)),
    };
  };
  const cards = exact.filter((li) => li.matches("li.s-card, li.s-item")).map(card).filter((c) => c.id && c.title && !/^shop on ebay$/i.test(c.title));
  window.__ebayComps = JSON.stringify({
    url: location.href,
    title: document.title,
    challenge,
    layout,
    count: text(document.querySelector(".srp-controls__count-heading, .result-count__count-heading")),
    cut: cutAt >= 0,
    cards,
  });
  window.__ebayCompsPart = (from) => {
    const all = window.__ebayComps;
    let end = Math.min(all.length, from + 15000);
    if (end < all.length && /[\uD800-\uDBFF]/.test(all[end - 1])) end -= 1;
    return "@@EC@@" + JSON.stringify({ len: all.length, end, part: all.slice(from, end) });
  };
  return window.__ebayCompsPart(0);
})()
