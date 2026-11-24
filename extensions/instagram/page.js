// Runs in an instagram.com tab, through the macOS appendage's browser js op.
// It reads the user's DMs the way the inbox page does (its own GraphQL queries),
// and never opens a chat: opening one marks it read and shows "Seen".
//
// The queries are Instagram's own, captured from the page itself: `hook` wraps
// XMLHttpRequest, the inbox and requests pages are then visited inside the app,
// and each query's request (its doc id, variables and the page's tokens) is kept
// in this origin's localStorage, where the page's own tokens already live. They
// never leave the page: answers carry messages, never tokens.
//
// main.py replaces __IGDM_ARGS__ with one of:
//   {op: "hook"}                    start capturing the DM queries
//   {op: "templates"}               which queries are captured for this account (doc ids, age)
//   {op: "go", href}                follow an in-app link, like /direct/inbox/
//   {op: "read", requests}          the inbox (and message requests) as threads
//   {op: "thread", key, count}      one thread's latest messages, by thread_key
//   {op: "compose", ids}            on /direct/t/<one of ids>/, focus the message box
// Each answer is one line, "@@IGDM@@" and JSON.
(() => {
  const args = __IGDM_ARGS__;
  const KEY = "sb-igdm-tpl";
  const answer = (o) => "@@IGDM@@" + JSON.stringify(o);
  const clip = (s, n) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
  const cookie = (k) => (document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]+)")) || [])[1];
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch (e) {
      return {};
    }
  };
  const QUERIES = {
    inbox: "PolarisDirectInboxQuery",
    requests: "PolarisDirectMessageRequestQuery",
    thread: "IGDThreadDetailQuery",
  };
  const ACCOUNT_QUERY = "IGDThreadListHeaderAccountSwitcherOffMsysQuery";

  if (!cookie("ds_user_id")) return answer({ signed_in: false, url: location.href });
  const me = { pk: cookie("ds_user_id") };
  try {
    const acct = JSON.parse(localStorage.getItem(KEY + "-account") || "{}");
    if (acct.pk === me.pk) me.username = acct.username;
  } catch (e) {}

  function replay(name, patch) {
    const t = load()[name];
    if (!t) return { missing: name };
    if (t.pk !== me.pk) return { missing: name, error: "captured for another account" };
    const p = new URLSearchParams(t.b);
    let vars = {};
    try {
      vars = JSON.parse(p.get("variables") || "{}");
    } catch (e) {}
    p.set("variables", JSON.stringify(Object.assign(vars, patch || {})));
    const x = new XMLHttpRequest();
    x.open("POST", "/api/graphql", false);
    const h = Object.assign({}, t.h, { "X-CSRFToken": cookie("csrftoken") || "" });
    for (const k in h) x.setRequestHeader(k, h[k]);
    try {
      x.send(p.toString());
    } catch (e) {
      return { failed: name, error: String(e).slice(0, 200) };
    }
    let j = null;
    try {
      j = JSON.parse(x.responseText.replace(/^for \(;;\);/, ""));
    } catch (e) {
      return { failed: name, status: x.status, error: "not JSON: " + x.responseText.slice(0, 160) };
    }
    if (!j.data) {
      const err = (j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].summary)) || j.errorSummary || j.error || "no data";
      return { failed: name, status: x.status, error: String(err).slice(0, 200), login: /login|checkpoint/i.test(JSON.stringify(j).slice(0, 2000)) };
    }
    return { data: j.data };
  }

  function thread(t, folder) {
    const users = (t.users || []).map((u) => ({ pk: u.id, fbid: u.interop_messaging_user_fbid, username: u.username, name: u.full_name }));
    const byFbid = {};
    users.forEach((u) => (byFbid[u.fbid] = u));
    const vf = (t.viewer && t.viewer.interop_messaging_user_fbid) || null;
    const edges = (t.slide_messages && t.slide_messages.edges) || [];
    const msgs = edges
      .map((e) => e && e.node)
      .filter(Boolean)
      .map((n) => {
        const mine = n.sender_fbid === vf;
        const sn = n.igd_snippet || "";
        let text = n.text_body || (n.content && n.content.text_body) || "";
        if (!text) text = mine && sn.startsWith("You: ") ? sn.slice(5) : sn;
        const by = mine ? "me" : (byFbid[n.sender_fbid] || {}).username || n.sender_fbid;
        return { id: n.id, at: +n.timestamp_ms, by, type: n.content_type, kind: n.content && n.content.__typename, text: clip(text, 2000) };
      })
      .sort((a, b) => a.at - b.at);
    const receipts = {};
    (t.slide_read_receipts || []).forEach((r) => (receipts[r.participant_fbid] = +r.watermark_timestamp_ms));
    if (t.viewer) {
      me.fbid = t.viewer.interop_messaging_user_fbid;
      me.id = t.viewer.id;
    }
    return {
      id: t.thread_id,
      fbid: t.thread_fbid || t.id,
      key: t.thread_key,
      title: t.thread_title,
      users,
      group: !!t.is_group,
      folder,
      system_folder: t.system_folder,
      subtype: t.thread_subtype,
      marked_unread: !!t.marked_as_unread,
      muted: !!t.is_muted,
      last_activity: +t.last_activity_timestamp_ms,
      my_watermark: receipts[vf] || 0,
      their_watermarks: Object.keys(receipts).filter((k) => k !== vf).map((k) => receipts[k]),
      msgs,
    };
  }

  function threadsOf(data, folder) {
    const m = data && data.get_slide_mailbox_for_iris_subscription;
    if (!m) return null;
    const nodes = [];
    for (const list of [m.pinned_threads_v2, m.threads_by_folder]) {
      for (const e of (list && list.edges) || []) {
        const t = e && e.node && e.node.as_ig_direct_thread;
        if (t && !nodes.some((x) => x.thread_id === t.thread_id)) nodes.push(t);
      }
    }
    return nodes.map((t) => thread(t, folder));
  }

  const out = { signed_in: true, url: location.href };
  if (args.op === "hook") {
    if (!window.__sbIgdmHooked) {
      window.__sbIgdmHooked = true;
      const O = XMLHttpRequest.prototype.open,
        S = XMLHttpRequest.prototype.send,
        H = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__sbU = u;
        this.__sbH = {};
        return O.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this.__sbH) this.__sbH[k] = v;
        return H.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (b) {
        const x = this;
        const name = x.__sbH && x.__sbH["X-FB-Friendly-Name"];
        const which = Object.keys(QUERIES).find((k) => QUERIES[k] === name);
        if (name === ACCOUNT_QUERY) {
          x.addEventListener("load", () => {
            try {
              const u = JSON.parse(x.responseText).data.viewer.xdt_user;
              localStorage.setItem(KEY + "-account", JSON.stringify({ pk: cookie("ds_user_id"), username: u.username }));
            } catch (e) {}
          });
        }
        if (which && String(x.__sbU).includes("graphql")) {
          x.addEventListener("load", () => {
            if (x.status !== 200 || !/^\{"data"/.test(x.responseText || "")) return;
            const h = Object.assign({}, x.__sbH);
            delete h["X-CSRFToken"];
            const all = load();
            all[which] = { b: String(b || ""), h, at: Date.now(), pk: cookie("ds_user_id") };
            localStorage.setItem(KEY, JSON.stringify(all));
          });
        }
        return S.apply(this, arguments);
      };
    }
    out.hooked = true;
  } else if (args.op === "templates") {
    const all = load();
    out.templates = {};
    for (const k in all)
      if (all[k].pk === me.pk) out.templates[k] = { doc_id: new URLSearchParams(all[k].b).get("doc_id"), age_s: Math.round((Date.now() - all[k].at) / 1000) };
    out.me = me;
  } else if (args.op === "go") {
    const a = document.querySelector('a[href="' + args.href + '"]') || document.querySelector('a[href^="' + args.href + '"]');
    if (a) a.click();
    out.clicked = !!a;
  } else if (args.op === "read") {
    const inbox = replay("inbox");
    if (!inbox.data) return answer(Object.assign(out, { need_capture: true }, inbox));
    out.threads = threadsOf(inbox.data, "primary");
    if (!out.threads) return answer(Object.assign(out, { need_capture: true, failed: "inbox", error: "no mailbox in the answer" }));
    if (args.requests) {
      const req = replay("requests", { __relay_internal__pv__IGD30DayAgoTimestampMsrelayprovider: String(Date.now() - 30 * 86400000) });
      if (req.data) out.threads = out.threads.concat(threadsOf(req.data, "requests") || []);
      else out.requests_error = req.missing ? "not captured" : req.error;
    }
    out.me = me;
  } else if (args.op === "thread") {
    const r = replay("thread", { thread_fbid: String(args.key), __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: args.count || 20 });
    if (!r.data) return answer(Object.assign(out, { need_capture: !!r.missing || !!r.failed }, r));
    const t = r.data.get_slide_thread_nullable && r.data.get_slide_thread_nullable.as_ig_direct_thread;
    out.thread = t ? thread(t, null) : null;
    out.me = me;
  } else if (args.op === "compose") {
    const box = document.querySelector('[role="textbox"][contenteditable="true"]');
    if (box) box.focus();
    out.focused = !!box && document.activeElement === box;
    const here = (location.pathname.match(/\/direct\/t\/(\d+)/) || [])[1];
    out.on_thread = !!here && (args.ids || []).includes(here);
  }
  return answer(out);
})()
