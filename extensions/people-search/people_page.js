// people-lookup's page reader: run in the tab after a navigate. Reads whichever
// page is loaded (a challenge, a FastPeopleSearch or TruePeopleSearch result
// list, or a FastPeopleSearch person page) and answers one line, @@PL@@{json}.
(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const txt = (el) => clean(el && el.innerText);
  const abs = (href) => (href ? new URL(href, location.href).href : null);
  const host = location.hostname.replace(/^www\./, "");
  const site = host.includes("fastpeoplesearch") ? "fastpeoplesearch" : host.includes("truepeoplesearch") ? "truepeoplesearch" : host;
  const body = document.body ? document.body.innerText : "";
  const out = (o) => "@@PL@@" + JSON.stringify(Object.assign({ site, url: location.href, title: document.title }, o));

  // A human check: Cloudflare's interstitial or Turnstile, TPS's own captcha page, a block page.
  const challenged =
    /InternalCaptcha|\/cdn-cgi\/challenge|captcha/i.test(location.href) ||
    /^(Just a moment|Attention Required|Captcha|Access denied|Verifying)/i.test(document.title) ||
    !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running, .cf-turnstile, .g-recaptcha, .h-captcha') ||
    /Verify you are human|unusual traffic|are you a robot|Request unsuccessful/i.test(body.slice(0, 3000));
  if (challenged) return out({ page: "challenge" });
  if (!document.body || body.length < 200) return out({ page: "empty" });

  const ageCity = (s) => {
    const m = clean(s).match(/Age\s*(\d+)?\s*(?:•\s*)?(.*)$/i);
    return m ? { age: m[1] ? Number(m[1]) : null, location: clean(m[2]) || null } : { age: null, location: clean(s) || null };
  };
  const ageBorn = (s) => {
    const m = clean(s).match(/Age\s*(\d+)\s*\(?([A-Za-z]{3,9}\s+\d{4})?\)?/);
    return m ? { age: Number(m[1]), born: m[2] || null } : {};
  };

  if (site === "fastpeoplesearch") {
    // A person's page.
    if (document.getElementById("details-header")) {
      const sec = (id) => document.getElementById(id);
      const dls = (id) => (sec(id) ? [...sec(id).querySelectorAll("dl")] : []);
      const h = clean(document.getElementById("details-header").innerText);
      const name = clean(h.split(/\bin\b/)[0]);
      const prof = body.match(/Age\s+(\d+),\s*Born\s+([A-Za-z]+\s+\d{4})/);
      const lives = body.match(/Lives in ([^\n]+)/);
      const cur = sec("current_address_section");
      const curA = cur && cur.querySelector("h3 a");
      const sinceM = cur && txt(cur.querySelector("h2")).match(/Since ([^)]+)/);
      const addr = (a) => clean((a.innerText || "").replace(/\n/g, ", "));
      const phones = dls("phone_number_section").map((dl) => {
        const dd = [...dl.querySelectorAll("dd")].map(txt);
        return {
          number: txt(dl.querySelector("dt")),
          type: dd[0] || null,
          carrier: dd[1] || null,
          first_reported: (dd.find((d) => /First reported/i.test(d)) || "").replace(/First reported\s*/i, "") || null,
          primary: !!dl.querySelector("dt strong"),
        };
      });
      const listH3 = (id) => (sec(id) ? [...sec(id).querySelectorAll("h3")].map(txt).filter(Boolean) : []);
      const people = (id) =>
        dls(id).map((dl) => {
          const a = dl.querySelector("dt a");
          const dd = [...dl.querySelectorAll("dd")].map(txt);
          return Object.assign({ name: txt(dl.querySelector("dt")), url: a ? abs(a.getAttribute("href")) : null }, ageBorn(dd[0] || ""), dd[1] ? { relation: dd[1] } : {});
        });
      const prev = dls("previous-addresses").map((dl) => {
        const a = dl.querySelector("dt a") || dl.querySelector("dt");
        const rec = [...dl.querySelectorAll("dd")].map(txt).find((d) => /Recorded/i.test(d));
        return { address: a ? addr(a) : null, recorded: rec ? rec.replace(/Recorded\s*/i, "") : null };
      });
      const biz = dls("business_section").map((dl) => {
        const dd = [...dl.querySelectorAll("dd")].map(txt);
        return { name: txt(dl.querySelector("dt")), address: dd[0] || null, role: dd[2] || null, since: (dd.find((d) => /^Since/i.test(d)) || "").replace(/^Since:?\s*/i, "") || null };
      });
      const jobs = dls("current_employment_section").map((dl) => {
        const dd = [...dl.querySelectorAll("dd")].map(txt);
        return { employer: txt(dl.querySelector("dt")), location: dd[0] || null, title: (dd.find((d) => /^Title/i.test(d)) || "").replace(/^Title:?\s*/i, "") || null, since: (dd.find((d) => /^Since/i.test(d)) || "").replace(/^Since:?\s*/i, "") || null };
      });
      const marital = sec("marital_status_section");
      const fullName = document.querySelector("#full_name_section .fullname");
      return out({
        page: "person",
        person: {
          name,
          full_name: fullName ? txt(fullName) : null,
          age: prof ? Number(prof[1]) : null,
          born: prof ? prof[2] : null,
          location: lives ? clean(lives[1]) : null,
          current_address: curA ? addr(curA) : null,
          current_since: sinceM ? sinceM[1] : null,
          phones,
          emails: listH3("email_section"),
          aka: listH3("aka-links"),
          past_addresses: prev,
          relatives: people("relative-links"),
          associates: people("associate-links"),
          marital: marital ? clean(marital.innerText.replace(/^[^\n]*\?/, "")) || null : null,
          businesses: biz,
          employment: jobs,
        },
      });
    }
    // A result list (phone, name or address search).
    const cards = [...document.querySelectorAll(".card[data-link], .card[id^='G']")].filter((c) => c.querySelector(".card-title"));
    const owner = body.match(/current owner of the phone number [\d-]+ is ([^.]+)\./i);
    const results = cards.map((c) => {
      const a = c.querySelector(".card-title a");
      const sec = (label) => {
        const h = [...c.querySelectorAll("h4")].find((h) => txt(h).toLowerCase().startsWith(label));
        if (!h) return [];
        const box = h.parentElement;
        const links = [...box.querySelectorAll("a")].map(txt).filter(Boolean);
        if (links.length) return links;
        return clean(box.innerText.replace(txt(h), "")).split("•").map(clean).filter(Boolean);
      };
      return Object.assign(
        { name: txt(c.querySelector(".card-title .larger")) || txt(a), url: abs(c.getAttribute("data-link") || (a && a.getAttribute("href"))) },
        ageCity(txt(c.querySelector(".card-title .grey"))),
        { past_locations: [...new Set(sec("past addresses"))], relatives: sec("relatives"), aka: sec("aka") }
      );
    });
    const none = /No results found|could not find any results|Invalid area code/i.test(body);
    return out({ page: "results", results, current_owner: owner ? clean(owner[1]) : null, none: none && !results.length, note: /Invalid area code/i.test(body) ? "invalid area code" : null });
  }

  if (site === "truepeoplesearch" && document.getElementById("personDetails")) {
    // A person's page: read section by section from its text.
    const d = document.getElementById("personDetails");
    const lines = d.innerText.split("\n").map(clean).filter(Boolean);
    const heads = ["Also Seen As", "Current Address", "Phone Numbers", "Email Addresses", "Previous Addresses", "Possible Relatives", "Possible Associates", "Business Connections"];
    const stop = /^(Full Background Report|Sponsored Link|Criminal Records Report|View All|View Full|View Criminal)/i;
    const secs = {};
    let cur = null;
    for (const l of lines) {
      const h = heads.find((x) => l === x);
      if (h) { cur = h; secs[h] = []; continue; }
      if (stop.test(l)) { cur = null; continue; }
      if (cur && !/^(Includes|This is|May include|All previously)/i.test(l)) secs[cur].push(l);
    }
    const prof = d.innerText.match(/Age\s+(\d+),\s*Born\s+([A-Za-z]+\s+\d{4})/);
    const lives = d.innerText.match(/Lives in ([^\n]+)/);
    const addrs = (ls) => {
      const outA = [];
      let a = [];
      for (const l of ls || []) {
        if (/^\(.*\)$/.test(l)) { if (a.length) outA.push({ address: a.filter((x) => !/County$/.test(x)).join(", "), recorded: l.slice(1, -1) }); a = []; }
        else a.push(l);
      }
      if (a.length) outA.push({ address: a.filter((x) => !/County$/.test(x)).join(", "), recorded: null });
      return outA;
    };
    const people = (ls) => {
      const o = [];
      for (const l of ls || []) {
        const m = l.match(/^Age (\d+)/);
        if (m && o.length) o[o.length - 1].age = Number(m[1]);
        else if (!m) o.push({ name: l, age: null });
      }
      return o;
    };
    const phones = [];
    for (const l of secs["Phone Numbers"] || []) {
      const m = l.match(/^(\(\d{3}\) \d{3}-\d{4})(?: - (\w+))?/);
      if (m) phones.push({ number: m[1], type: m[2] || null, carrier: null, last_reported: null, primary: false });
      else if (phones.length) {
        const p = phones[phones.length - 1];
        if (/Primary/i.test(l)) p.primary = true;
        else if (/^Last reported/i.test(l)) p.last_reported = l.replace(/^Last reported\s*/i, "");
        else if (!p.carrier) p.carrier = l;
      }
    }
    const curA = addrs(secs["Current Address"])[0] || {};
    const biz = [];
    for (const l of secs["Business Connections"] || []) {
      if (/^Since /i.test(l) && biz.length) biz[biz.length - 1].since = l.replace(/^Since\s*/i, "");
      else if (biz.length && !biz[biz.length - 1].address) biz[biz.length - 1].address = l;
      else biz.push({ name: l, address: null, since: null });
    }
    return out({
      page: "person",
      person: {
        name: txt(d.querySelector("h1")),
        full_name: null,
        age: prof ? Number(prof[1]) : null,
        born: prof ? prof[2] : null,
        location: lives ? clean(lives[1]) : null,
        current_address: curA.address || null,
        current_since: curA.recorded || null,
        phones,
        emails: (secs["Email Addresses"] || []).filter((l) => l.includes("@")),
        aka: (secs["Also Seen As"] || []).join(", ").split(/,\s*/).filter(Boolean),
        past_addresses: addrs(secs["Previous Addresses"]),
        relatives: people(secs["Possible Relatives"]),
        associates: people(secs["Possible Associates"]),
        businesses: biz,
      },
    });
  }

  if (site === "truepeoplesearch") {
    const cards = [...document.querySelectorAll(".card-summary")];
    if (cards.length || /could not find any records/i.test(body)) {
      const results = cards.map((c) => {
        const field = (label) => {
          const l = [...c.querySelectorAll(".content-label")].find((s) => txt(s).toLowerCase().startsWith(label));
          const v = l && l.nextElementSibling;
          return v ? txt(v).replace(/\.\.\.$/, "").split(/,\s*(?=[A-Z])/).map(clean).filter(Boolean) : [];
        };
        const vals = [...c.querySelectorAll(":scope .col-md-8 > div:nth-child(2) .content-value")].map(txt);
        return {
          name: txt(c.querySelector(".content-header")),
          url: abs(c.getAttribute("data-detail-link")),
          age: vals[0] && /^\d+$/.test(vals[0]) ? Number(vals[0]) : null,
          location: vals[1] || null,
          past_locations: field("used to live"),
          relatives: field("related to"),
          aka: field("also seen as"),
        };
      });
      return out({ page: "results", results, none: !results.length });
    }
    return out({ page: "unknown", snippet: clean(body).slice(0, 300) });
  }
  return out({ page: "unknown", snippet: clean(body).slice(0, 300) });
})();
