// Runs in the Marketplace inbox tab (facebook.com/marketplace/inbox), through the
// browser extension's browser_js. It reads, and never opens an unread chat:
// opening one marks it read for the user and shows "Seen" to the other person.
// chats.py replaces __MPW_ARGS__ with one of:
//   {op: "minimize"}                     minimize every open chat popup
//   {op: "tab", side: "BUYER"|"SELLER"}  switch the inbox's Buying/Selling tab
//   {op: "read", limit, full}            the tab's rows, and the messages of chats docked in the page
//   {op: "open", name, listing}          open a chat that's already read (refuses an unread one)
//   {op: "close", name, listing}         close that chat's popup
// Sending (chats.py's send and draft), the only ops that write anything:
//   {op: "listing"}                      a listing page: title, price, seller, place, photo, and how
//                                        the user would message it (mode: first, again or none)
//   {op: "fill_box", text}               put the words in a listing's first-message box
//   {op: "box", text}                    whether that box holds exactly the words
//   {op: "send_box", text}               press the listing's Send, if the box holds exactly the words
//   {op: "message_again"}                press a listing's Message again, which opens its chat
//   {op: "chat", listing, name?}         find the open chat for a listing (marks its composer), its messages
//   {op: "fill_chat"|"composer", text}   paste the words into that composer / whether it holds them (and focus it)
//   {op: "clear_chat"}                   take everything out of that composer
//   {op: "send_chat", text}              press Enter in that composer, if it holds exactly the words
//   {op: "sent", text, listing}          whether the chat shows the words sent by You
//   {op: "close_chat", listing}          close that chat's popup
//   {op: "open_any", name, listing}      open an inbox chat to reply in it, unread or not
// Each answer is one line, "@@MPW@@" and JSON.
(() => {
  const args = __MPW_ARGS__;
  const norm = (s) => (s || "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
  const answer = (o) => "@@MPW@@" + JSON.stringify(o);
  const main = document.querySelector('[role="main"]');
  // Held at a checkpoint ("We suspect automated behavior on your account"), every page is that one;
  // its button is the user's to press. Signed out, the inbox sends the tab to Marketplace's public
  // page (a main, no tabs): signed in is Facebook's c_user cookie, as page_search.js reads it.
  if (location.pathname.startsWith("/checkpoint/")) {
    const said = ((main || document.body).innerText.split("\n").map((l) => l.trim()).find(Boolean) || "").slice(0, 160);
    return answer({ signed_in: false, checkpoint: said || "it asks for something", url: location.href });
  }
  if (!/(?:^|;\s*)c_user=\d/.test(document.cookie)) return answer({ signed_in: false, url: location.href });

  function rowButtons() {
    return main ? [...main.querySelectorAll('[role="button"]')].filter((b) => b.querySelector("svg image")) : [];
  }

  function row(b) {
    const spans = [...b.querySelectorAll('span[dir="auto"]')];
    const title = norm(spans[0] && spans[0].innerText);
    const i = title.indexOf(" · ");
    const name = i >= 0 ? title.slice(0, i).trim() : title;
    const listing = i >= 0 ? title.slice(i + 3).trim() : "";
    const snippet = spans.length > 2 ? norm(spans[1].innerText) : "";
    const time = spans.length > 1 ? norm(spans[spans.length - 1].innerText) : "";
    // Unread: Facebook's blue dot, and a bold line.
    const dot = [...b.querySelectorAll("div,span")].some((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 4 && r.width < 16 && Math.abs(r.width - r.height) < 2 &&
        /^rgb\(\s*8,\s*102,\s*255/.test(getComputedStyle(e).backgroundColor);
    });
    const line = spans[1] && (spans[1].querySelector("span") || spans[1]);
    const bold = line ? parseInt(getComputedStyle(line).fontWeight, 10) >= 600 : false;
    const img = b.querySelector("svg image");
    const href = (img && (img.getAttribute("xlink:href") || img.getAttribute("href"))) || "";
    const photo = (href.match(/\/\d+_(\d+)_\d+_n\./) || [])[1] || null;
    return { name, listing, snippet: snippet.slice(0, 1000), time, unread: dot || bold, photo };
  }

  // A chat docked in the page, open or minimized, keeps its messages in a role=log.
  function logs() {
    return [...document.querySelectorAll('[role="log"]')]
      .map((l) => {
        const t = norm(l.getAttribute("aria-label")).match(/^Messages in conversation titled (.*)$/);
        if (!t) return null;
        const img = l.querySelector('[role="img"][aria-label]');
        const msgs = [...l.querySelectorAll('[role="button"][aria-label^="Enter, Message sent "]')]
          .map((e) => {
            const m = norm(e.getAttribute("aria-label")).match(/^Enter, Message sent (.+?) by (.+?): (.*)$/);
            return m ? { at: m[1], by: m[2], text: m[3].slice(0, 1000) } : null;
          })
          .filter(Boolean);
        return { title: t[1], person: img ? norm(img.getAttribute("aria-label")) : null, msgs: msgs.slice(-12), el: l };
      })
      .filter(Boolean);
  }

  // The log of one chat: its title ends with the listing, and its person is the row's name.
  function logOf(name, listing) {
    const ls = logs().filter((l) => l.title === listing || l.title.endsWith(" · " + listing));
    return ls.find((l) => l.person && l.person.startsWith(name)) ||
      ls.find((l) => l.msgs.some((m) => m.by === name)) ||
      (ls.length === 1 && !ls[0].person ? ls[0] : null);
  }

  function visible(e) {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Two renderings of the same words: equal once spaces are, or one a long prefix of the other
  // (an aria-label can be cut short).
  const same = (a, b) => {
    a = norm(a);
    b = norm(b);
    return a === b || (a.length >= 60 && b.startsWith(a)) || (b.length >= 60 && a.startsWith(b));
  };
  const lines = (t) => (t || "").split("\n").map(norm).filter(Boolean);
  // The popup a chat's log sits in: the nearest ancestor with its own Close chat button.
  function dockOf(el) {
    let p = el;
    for (let i = 0; i < 30 && p && !(p.querySelector && p.querySelector('[aria-label="Close chat"]')); i++) p = p.parentElement;
    return p && p.querySelector && p.querySelector('[aria-label="Close chat"]') ? p : null;
  }
  function target() {
    return document.querySelector('[data-mpw-target="1"]');
  }
  function forListing(listing) {
    return logs().filter((l) => l.title === listing || l.title.endsWith(" · " + listing));
  }

  let out = { signed_in: true, url: location.href };
  if (args.op === "minimize") {
    const bs = [...document.querySelectorAll('[aria-label="Minimize chat"]')].filter(visible);
    bs.forEach((b) => b.click());
    out.minimized = bs.length;
  } else if (args.op === "tab") {
    const label = args.side === "SELLER" ? "Selling" : "Buying";
    const t = main && [...main.querySelectorAll('[role="tab"]')].find((e) => norm(e.innerText) === label);
    // The rows before the switch, so a read can tell the new tab's rows have arrived.
    window.__mpwBefore = JSON.stringify(rowButtons().slice(0, 3).map(row).map((r) => [r.name, r.listing]));
    if (!t) out.error = "no " + label + " tab";
    else if (t.getAttribute("aria-selected") !== "true") t.click();
  } else if (args.op === "read") {
    const selected = main && [...main.querySelectorAll('[role="tab"]')].find((e) => e.getAttribute("aria-selected") === "true");
    out.tab = selected ? norm(selected.innerText) : null;
    out.rows = rowButtons().slice(0, args.limit || 15).map(row);
    if (args.after_switch && window.__mpwBefore === JSON.stringify(out.rows.slice(0, 3).map((r) => [r.name, r.listing])))
      return answer({ signed_in: true, stale: true, tab: out.tab });
    out.logs = logs().map(({ title, person, msgs }) => ({ title, person, msgs }));
    // Unchanged since this tab's last read: say only that (sessionStorage outlives the reload).
    const digest = JSON.stringify([out.tab, out.rows, out.logs]);
    const key = "mpw-digest-" + out.tab;
    let before = null;
    try {
      before = sessionStorage.getItem(key);
      sessionStorage.setItem(key, digest);
    } catch (e) {}
    if (!args.full && before === digest) out = { signed_in: true, same: true, tab: out.tab };
  } else if (args.op === "open") {
    const bs = rowButtons();
    const b = bs.find((x) => {
      const r = row(x);
      return r.name === args.name && r.listing === args.listing;
    });
    if (!b) out.error = "no such chat";
    else if (row(b).unread) out.error = "unread, left alone";
    else {
      b.click();
      out.opened = true;
    }
  } else if (args.op === "close") {
    const l = logOf(args.name, args.listing);
    let p = l && l.el;
    for (let i = 0; i < 30 && p && !(p.querySelector && p.querySelector('[aria-label="Close chat"]')); i++) p = p.parentElement;
    const c = p && p.querySelector('[aria-label="Close chat"]');
    if (c) c.click();
    out.closed = !!c;
  } else if (args.op === "listing") {
    const m = main || document.body;
    const ls = lines(m.innerText);
    const h1 = m.querySelector("h1");
    out.title = norm(h1 && h1.innerText) || null;
    const ti = out.title ? ls.indexOf(out.title) : -1;
    out.price = (ti >= 0 ? ls.slice(ti + 1, ti + 6) : ls.slice(0, 12)).find((l) => /^(\$[\d,.]+|Free)/.test(l)) || null;
    const listed = ls.find((l) => /^Listed .* in /.test(l));
    out.listed = listed || null;
    out.place = listed ? listed.replace(/^Listed .*? in /, "") : null;
    out.flags = ls.slice(0, 30).filter((l) => /^(Sold|Pending)$/i.test(l) || /no longer available/i.test(l));
    const buttons = [...m.querySelectorAll('[role="button"],button')].filter(visible);
    const send = buttons.find((b) => /^Send message to /.test(norm(b.getAttribute("aria-label"))));
    const box = [...m.querySelectorAll("textarea")].find(visible);
    const again = buttons.find((b) => norm(b.innerText) === "Message again" || norm(b.getAttribute("aria-label")) === "Message again");
    const di = ls.indexOf("Seller details");
    out.seller = send ? norm(send.getAttribute("aria-label")).replace(/^Send message to /, "") : di >= 0 && ls[di + 1] ? ls[di + 1] : null;
    out.own = buttons.some((b) => /^(Mark as sold|Mark as available|Mark as pending|Edit listing)$/i.test(norm(b.innerText)));
    out.mode = send && box ? "first" : again ? "again" : "none";
    out.prefill = box ? box.value.slice(0, 200) : null;
    const img = [...m.querySelectorAll("img")].find((i) => i.naturalWidth > 300);
    out.photo = img ? img.src : null;
  } else if (args.op === "fill_box" || args.op === "box") {
    const box = [...(main || document).querySelectorAll("textarea")].find(visible);
    if (!box) out.error = "no message box";
    else if (args.op === "fill_box") {
      // React keeps the box's value: set it as typing would, through the native setter and an input event.
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      box.focus();
      set.call(box, args.text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      out.filled = true;
    } else {
      out.matches = box.value === args.text;
      out.length = box.value.length;
    }
  } else if (args.op === "send_box") {
    const m = main || document.body;
    const box = [...m.querySelectorAll("textarea")].find(visible);
    const send = [...m.querySelectorAll('[role="button"],button')].filter(visible)
      .find((b) => /^Send message to /.test(norm(b.getAttribute("aria-label"))));
    if (!box || box.value !== args.text) out.error = "the box doesn't hold the words";
    else if (!send) out.error = "no Send button";
    else {
      send.click();
      out.pressed = true;
    }
  } else if (args.op === "message_again") {
    const m = main || document.body;
    const again = [...m.querySelectorAll('[role="button"],button')].filter(visible)
      .find((b) => norm(b.innerText) === "Message again" || norm(b.getAttribute("aria-label")) === "Message again");
    if (!again) out.error = "no Message again button";
    else {
      again.click();
      out.pressed = true;
    }
  } else if (args.op === "clear_chat") {
    const box = target();
    if (!box) out.error = "no composer";
    else {
      box.focus();
      // Lexical takes the editing commands' beforeinput events as typing would.
      document.execCommand("selectAll");
      document.execCommand("delete");
      out.empty = !norm(box.innerText);
    }
  } else if (args.op === "send_chat") {
    const box = target();
    if (!box) out.error = "no composer";
    else if (norm(box.innerText) !== norm(args.text)) out.error = "the composer doesn't hold the words";
    else {
      box.focus();
      for (const type of ["keydown", "keypress", "keyup"])
        box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      out.pressed = true;
    }
  } else if (args.op === "chat") {
    const shown = logs().filter((l) => visible(l.el));
    let l = (args.name && logOf(args.name, args.listing)) || shown.find((x) => x.title === args.listing || x.title.endsWith(" · " + args.listing));
    if (!l && shown.length === 1) l = shown[0];
    document.querySelectorAll("[data-mpw-target]").forEach((e) => e.removeAttribute("data-mpw-target"));
    const dock = l && dockOf(l.el);
    const box = dock && dock.querySelector('[contenteditable="true"][role="textbox"]');
    if (!l) out.error = "no open chat for it";
    else {
      if (box) box.setAttribute("data-mpw-target", "1");
      out.chat = { title: l.title, person: l.person, msgs: l.msgs, composer: !!box, draft: box ? norm(box.innerText).length : 0 };
    }
  } else if (args.op === "fill_chat") {
    const box = target();
    if (!box) out.error = "no composer";
    else {
      box.focus();
      if (norm(box.innerText)) out.draft = norm(box.innerText).length;
      else {
        // A paste: Lexical takes its line breaks as line breaks, and no Enter is ever pressed.
        const dt = new DataTransfer();
        dt.setData("text/plain", args.text);
        box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        out.pasted = true;
      }
    }
  } else if (args.op === "composer") {
    const box = target();
    if (!box) out.error = "no composer";
    else {
      box.focus();
      const had = box.innerText.replace(/\n+$/, "");
      const want = (args.text || "").replace(/\n+$/, "");
      out.matches = norm(had) === norm(want) && had.trim().split("\n").length === want.trim().split("\n").length;
      out.empty = !norm(had);
      out.length = had.length;
      out.focused = document.activeElement === box;
      const dock = dockOf(box);
      out.send_button = !!(dock && dock.querySelector('[aria-label="Press enter to send"]'));
    }
  } else if (args.op === "sent") {
    const mine = forListing(args.listing);
    const pool = mine.length ? mine : logs().filter((l) => visible(l.el));
    for (const l of pool) {
      const m = [...l.msgs].reverse().find((x) => x.by === "You" && same(x.text, args.text));
      if (m) {
        out.found = { at: m.at, title: l.title, person: l.person, msgs: l.msgs.slice(-6) };
        break;
      }
    }
    const said = pool.map((l) => (dockOf(l.el) || l.el).innerText || "").join("\n");
    const bad = said.match(/(Couldn.t send|Failed to send|Message not sent|Not delivered|couldn.t be sent)[^\n]{0,80}/i);
    out.failed = bad ? norm(bad[0]) : null;
    out.chats = pool.map((l) => l.title);
  } else if (args.op === "close_chat") {
    const box = target();
    const mine = forListing(args.listing);
    const dock = (box && dockOf(box)) || (mine[0] && dockOf(mine[0].el));
    const c = dock && dock.querySelector('[aria-label="Close chat"]');
    if (c) c.click();
    out.closed = !!c;
  } else if (args.op === "open_any") {
    const b = rowButtons().find((x) => {
      const r = row(x);
      return r.name === args.name && r.listing === args.listing;
    });
    if (!b) out.error = "no such chat in the inbox's latest rows";
    else {
      out.was_unread = row(b).unread;
      b.click();
      out.opened = true;
    }
  }
  return answer(out);
})()
