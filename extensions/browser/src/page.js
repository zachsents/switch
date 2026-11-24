// The browser extension's eyes and fingertips inside a page an agent drives.
// src/tab.ts injects this into an isolated world of the tab
// through the extension's debugger, so the page can't see or change it. It
// numbers what can be acted on, renders the page as an outline, finds the point
// that really hits an element, and reads fields back, never a password's.
//
// Ported from Switchboard. The collector is Agent Quick Browse's (MIT), grown: an element
// keeps its number for as long as it lives (and a re-rendered copy of it gets
// the number back), numbers carry on across documents from where the host says,
// and open shadow roots and same-origin frames count as part of the page.
;(() => {
  // Replaced with a hash of this script when it's injected, so a page holding an older copy takes this one.
  const VERSION = 1
  if (globalThis.__switch?.version === VERSION) return "kept"

  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[contenteditable]:not([contenteditable=false])",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    "iframe",
    ...[
      "button",
      "link",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "checkbox",
      "radio",
      "option",
      "combobox",
      "textbox",
      "searchbox",
      "switch",
      "slider",
      "spinbutton",
      "treeitem",
    ].map((role) => `[role=${role}]`),
  ].join(",")

  /** Number → the element (weakly held) and what it was, to find it again. */
  const registry = new Map()
  /** Element → its number. */
  const numbers = new WeakMap()
  let next = 1
  let lastMutation = performance.now()
  new MutationObserver(() => (lastMutation = performance.now())).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  // A navigation to another document the page has begun: a form submitted
  // (which Chrome only sends a moment later) or a navigate event (one a page
  // script takes over stays in this document: navigatesuccess). Until the
  // next document replaces this one, the page hasn't settled, though the
  // debugger may not have said a load started yet.
  let leaving = null
  document.addEventListener(
    "submit",
    (event) => {
      // Not one that closes a dialog, or goes to another tab or frame.
      const method =
        event.submitter?.getAttribute("formmethod") ?? event.target.getAttribute?.("method")
      const target =
        event.submitter?.getAttribute("formtarget") ?? event.target.getAttribute?.("target")
      if (method?.toLowerCase() !== "dialog" && (!target || target === "_self"))
        leaving = { at: performance.now(), event }
    },
    true,
  )
  globalThis.navigation?.addEventListener("navigate", (event) => {
    if (!event.destination.sameDocument && !event.downloadRequest)
      leaving = { at: performance.now(), event }
  })
  globalThis.navigation?.addEventListener("navigatesuccess", () => (leaving = null))
  globalThis.navigation?.addEventListener("navigateerror", () => (leaving = null))

  const clean = (text) => (text ? String(text).replaceAll(/\s+/g, " ").trim() : "")
  /** HTML elements, from any frame's realm (instanceof fails across frames). */
  const isHtml = (el) => el?.nodeType === 1 && "isContentEditable" in el
  const style = (el) => el.ownerDocument.defaultView.getComputedStyle(el)
  const frameDocument = (frame) => {
    try {
      return frame.contentDocument
    } catch {
      return null
    }
  }
  /** The parent, across shadow roots. */
  const parentOf = (el) => el.parentElement ?? (el.parentNode?.host ? el.parentNode.host : null)
  /** Whether `node` is `ancestor` or inside it, across shadow roots. */
  const contains = (ancestor, node) => {
    for (let n = node; n; n = n.parentNode ?? n.host) if (n === ancestor) return true
    return false
  }
  const ancestorsOf = (el) => {
    const chain = []
    for (let p = parentOf(el); p; p = parentOf(p)) chain.push(p)
    return chain
  }

  /** Where an element's frame sits in the top viewport (0, 0 at the top). */
  function offsetOf(el) {
    let x = 0
    let y = 0
    for (let win = el.ownerDocument.defaultView; win && win.frameElement; win = win.parent) {
      const frame = win.frameElement
      const r = frame.getBoundingClientRect()
      x += r.left + frame.clientLeft
      y += r.top + frame.clientTop
    }
    return { x, y }
  }

  /** An element's box in top-viewport coordinates. */
  function rectOf(el) {
    const r = el.getBoundingClientRect()
    const o = offsetOf(el)
    return {
      left: r.left + o.x,
      top: r.top + o.y,
      right: r.right + o.x,
      bottom: r.bottom + o.y,
      width: r.width,
      height: r.height,
    }
  }

  const inViewport = (r) =>
    r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth

  /**
   * The middle of the part of a box (top viewport) inside the viewport, or null when none of it
   * is: where a hit test can look, since nothing outside the viewport answers one.
   */
  function shownMiddle(r) {
    const left = Math.max(r.left, 0)
    const top = Math.max(r.top, 0)
    const right = Math.min(r.right, innerWidth)
    const bottom = Math.min(r.bottom, innerHeight)
    if (right - left < 1 || bottom - top < 1) return null
    return { x: (left + right) / 2, y: (top + bottom) / 2 }
  }

  /** Pixels between the element and the viewport (0 when visible). */
  function distance(el) {
    const r = rectOf(el)
    return r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0
  }

  /** The topmost element at a point of a document, down through open shadow roots. */
  function topmost(doc, x, y) {
    let hit = doc.elementFromPoint(x, y)
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    return hit
  }

  /**
   * Whether a click at (x, y) (top viewport) lands on the element, in its frame
   * and every frame above. Landing on an ancestor doesn't count (that's what a
   * point outside a scrolled list's box hits), unless the element lets clicks
   * through to it.
   */
  function reachable(el, x, y) {
    const lands = (target) => {
      const o = offsetOf(target)
      const hit = topmost(target.ownerDocument, x - o.x, y - o.y)
      return (
        !!hit &&
        (hit === target ||
          contains(target, hit) ||
          (contains(hit, target) && style(target).pointerEvents === "none"))
      )
    }
    if (!lands(el)) return false
    for (let win = el.ownerDocument.defaultView; win && win.frameElement; win = win.parent)
      if (!lands(win.frameElement)) return false
    return true
  }

  /** Every element in the page, through open shadow roots and same-origin frames, in document order. */
  function everything() {
    const out = []
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        out.push(el)
        if (el.shadowRoot) walk(el.shadowRoot)
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          const doc = frameDocument(el)
          if (doc?.body) walk(doc.body)
        }
      }
    }
    if (document.body) walk(document.body)
    return out
  }

  /**
   * Elements where a pointer cursor starts (its parent doesn't have one). Catches
   * click targets wired up purely in JS, like Gmail's row actions, which no role
   * or tag selector matches. Only the outermost element of each pointer region is
   * taken, or a named control inside one.
   */
  function pointerTargets(all) {
    return all.filter((el) => {
      if (!isHtml(el) || style(el).cursor !== "pointer") return false
      if (el.matches("[aria-label], [title], [data-tooltip]")) return true
      const parent = parentOf(el)
      return !(parent && isHtml(parent) && style(parent).cursor === "pointer")
    })
  }

  /** "checked" / "unchecked" for anything that acts as a toggle, else "". */
  function toggleState(el) {
    const aria = el.getAttribute("aria-checked")
    if (aria === "true" || aria === "false") return aria === "true" ? "checked" : "unchecked"
    const box =
      el.tagName === "INPUT"
        ? el
        : el.tagName === "LABEL"
          ? el.control
          : el.querySelector(
              "input[type=checkbox], input[type=radio], [role=switch], [role=checkbox]",
            )
    if (box?.tagName === "INPUT" && (box.type === "checkbox" || box.type === "radio"))
      return box.checked ? "checked" : "unchecked"
    const nested = box?.getAttribute?.("aria-checked")
    return nested === "true" ? "checked" : nested === "false" ? "unchecked" : ""
  }

  /** True when a scrolling or clipping ancestor hides the element's center. */
  function clippedByContainer(el) {
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    for (
      let parent = parentOf(el);
      parent && parent !== el.ownerDocument.body;
      parent = parentOf(parent)
    ) {
      if (!isHtml(parent) || style(parent).overflow === "visible") continue
      const p = parent.getBoundingClientRect()
      if (x < p.left || x > p.right || y < p.top || y > p.bottom) return true
    }
    return false
  }

  /** Whether an element scrolls its own content vertically. */
  const scrolls = (el) =>
    el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style(el).overflowY)

  /** "in column 2 of 2" for an element inside one of several sibling scrolling columns. */
  function scrollColumn(el) {
    for (
      let column = parentOf(el), depth = 0;
      column && depth < 4;
      column = parentOf(column), depth++
    ) {
      if (!isHtml(column) || !scrolls(column)) continue
      const columns = [...(column.parentElement?.children ?? [])].filter(
        (c) => isHtml(c) && scrolls(c),
      )
      return columns.length > 1
        ? `in column ${columns.indexOf(column) + 1} of ${columns.length}`
        : ""
    }
    return ""
  }

  /** Which list an item is in, since bare items like "12" are ambiguous when a picker has several lists. */
  function listContext(el) {
    const list = el.matches("li, option, [role=option], [role=menuitem], [role=gridcell]")
      ? el.closest("ul, ol, select, [role=listbox], [role=menu], [role=grid], [role=list]")
      : null
    const labelledBy = list?.getAttribute("aria-labelledby")
    const name =
      list?.getAttribute("aria-label") ??
      (labelledBy ? el.ownerDocument.getElementById(labelledBy)?.textContent : null) ??
      (list && /^[a-z][\w-]{2,30}$/i.test(list.id) ? list.id : null)
    return name ? `in ${clean(name)}` : scrollColumn(el)
  }

  /** "attached: a.pdf" for a file input, or an upload button or drop zone next to one. */
  function attachedFiles(el) {
    if (el.matches("input:not([type=file]), textarea, [contenteditable]")) return ""
    let input = el.matches("input[type=file]") ? el : null
    for (
      let scope = el, depth = 0;
      !input && scope && scope !== el.ownerDocument.body && depth < 3;
      scope = scope.parentElement, depth++
    )
      input = scope.querySelector("input[type=file]")
    const names = input?.files ? [...input.files].map((file) => file.name) : []
    return names.length ? `attached: ${names.join(", ")}` : ""
  }

  /** Short text of the closest small container around an element, for controls with no text. */
  function nearbyLabel(el) {
    for (
      let parent = parentOf(el), depth = 0;
      parent && depth < 5;
      parent = parentOf(parent), depth++
    ) {
      const text = clean(parent.innerText)
      if (text) return text.length <= 80 ? text : ""
    }
    return ""
  }

  /** ARIA role, falling back to the implicit role of native elements. */
  function implicitRole(el) {
    const explicit = el.getAttribute("role")
    if (explicit) return explicit.split(/\s+/)[0]
    switch (el.tagName) {
      case "A":
        return "link"
      case "SELECT":
        return "combobox"
      case "TEXTAREA":
        return "textbox"
      case "INPUT":
        return (
          {
            checkbox: "checkbox",
            radio: "radio",
            search: "searchbox",
            file: "file upload",
            button: "button",
            submit: "button",
            range: "slider",
          }[el.type] ?? "textbox"
        )
      case "BUTTON":
      case "SUMMARY":
        return "button"
      case "IFRAME":
      case "FRAME":
        return "frame"
      default:
        // A rich-text editor is a text box to whoever uses it
        return el.isContentEditable ? "textbox" : el.tagName.toLowerCase()
    }
  }

  const SECRET_AUTOCOMPLETE =
    /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/
  const SECRET_WORDS =
    /pass(word|code|phrase)|\bpin\b|card.?(number|no\b)|credit.?card|\bcvv|\bcvc|\bcsc\b|security.?code|\bssn\b|social.?security|passport|tax.?id|\bitin\b|routing.?number|account.?number|\biban\b|driver.?s?.?licen[cs]e|one.?time.?(code|password)|verification.?code|\b2fa\b|\botp\b/i

  /**
   * Why a field must never be typed into or read: "password" (passwords,
   * passcodes and one-time codes) or "payment or identity number" (card numbers,
   * security codes, SSNs, passports…), from its type, autocomplete and the words
   * that name it. "" for anything else.
   */
  function sensitive(el) {
    if (!isHtml(el)) return ""
    if (el.hasAttribute(SEALED)) return "payment or identity number"
    const fieldLike = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
    if (!fieldLike) return ""
    if (el.tagName === "INPUT" && el.type === "password") return "password"
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase()
    if (SECRET_AUTOCOMPLETE.test(auto))
      return /password|one-time/.test(auto) ? "password" : "payment or identity number"
    const words = [
      el.name,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      ...[...(el.labels ?? [])].map((l) => l.innerText),
    ].join(" ")
    const match = SECRET_WORDS.exec(words)
    if (!match) return ""
    return /pass|pin|one.?time|verification|2fa|otp/i.test(match[0])
      ? "password"
      : "payment or identity number"
  }

  const SECRET_STATE = {
    password: "password field",
    "payment or identity number": "payment or identity field",
  }

  /** The mark on a field the host filled with one of the person's secrets (`seal`): it's never read back from here on. */
  const SEALED = "data-switch-sealed"

  /** What an element is called, without its passing states: how a re-rendered copy is recognized. */
  function nameParts(el) {
    const tag = el.tagName
    const input = tag === "INPUT" || tag === "TEXTAREA" ? el : null
    const formField = input ?? (tag === "SELECT" ? el : null)
    const secret = sensitive(el)
    const labelledBy = el
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((ref) => el.ownerDocument.getElementById(ref)?.innerText)
      .join(" ")
    if (tag === "IFRAME" || tag === "FRAME") {
      let host = ""
      try {
        host = new URL(el.src, location.href).host
      } catch {}
      return [el.getAttribute("title"), el.getAttribute("name"), host && `from ${host}`]
        .map(clean)
        .filter(Boolean)
    }
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("data-tooltip"),
      labelledBy,
      ...[...(formField?.labels ?? [])].map((l) => l.innerText),
      formField?.name && `name=${formField.name}`,
      input?.placeholder,
      input &&
        !secret &&
        input.type !== "checkbox" &&
        input.type !== "radio" &&
        input.value &&
        `value="${input.value}"`,
      tag === "SELECT" && !secret && `selected="${el.selectedOptions[0]?.text ?? ""}"`,
      secret ? "" : el.innerText,
      el.getAttribute("title"),
      el.getAttribute("alt"),
    ]
      .map(clean)
      .filter(Boolean)
  }

  const fingerprint = (el) =>
    `${el.tagName}|${implicitRole(el)}|${[...new Set(nameParts(el))].join(" | ").slice(0, 120)}`

  /** Whether text can be typed into it. Read-only or disabled fields are set through the page's own pickers. */
  function editable(el) {
    if (el.matches(":disabled, [readonly], [aria-readonly=true], [aria-disabled=true]"))
      return false
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true
    return (
      el.tagName === "INPUT" &&
      ![
        "radio",
        "checkbox",
        "button",
        "submit",
        "reset",
        "image",
        "file",
        "range",
        "color",
      ].includes(el.type)
    )
  }

  /** The element's line for the model and the agent. */
  function describe(el, n, hoverOnly) {
    const parts = nameParts(el)
    const secret = sensitive(el)
    const states = [
      toggleState(el),
      el.getAttribute("aria-selected") === "true" && "selected",
      el.getAttribute("aria-pressed") === "true" && "pressed",
      el.getAttribute("aria-expanded") && `expanded=${el.getAttribute("aria-expanded")}`,
      (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") && "disabled",
      deepActive() === el && "focused",
      hoverOnly && "shows on hover",
      secret && SECRET_STATE[secret],
      (el.tagName === "IFRAME" || el.tagName === "FRAME") &&
        !frameDocument(el) &&
        "another site's frame: click into it by position",
    ].filter(Boolean)
    const r = rectOf(el)
    const screens = Math.max(1, Math.round(distance(el) / innerHeight))
    return {
      n,
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      label: [
        ...new Set(
          [
            ...parts,
            parts.length ? "" : nearbyLabel(el),
            ...states,
            listContext(el),
            attachedFiles(el),
          ].filter(Boolean),
        ),
      ]
        .join(" | ")
        .slice(0, 120),
      href: el.getAttribute("href")?.slice(0, 80) ?? null,
      editable: editable(el),
      sensitive: secret || null,
      offscreen: clippedByContainer(el)
        ? "scrolled out of view in its list/panel"
        : inViewport(r)
          ? null
          : `${r.top < 0 ? "above" : "below"}, ~${screens} screen${screens > 1 ? "s" : ""}`,
      fp: fingerprint(el),
    }
  }

  /** The focused element, down through shadow roots and same-origin frames. */
  function deepActive() {
    let active = document.activeElement
    for (;;) {
      if (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
      else if (
        (active?.tagName === "IFRAME" || active?.tagName === "FRAME") &&
        frameDocument(active)?.activeElement
      )
        active = frameDocument(active).activeElement
      else return active
    }
  }

  /**
   * What an agent can act on right now: visible interactive elements (and ones
   * shown only on hover), innermost first, nearest the viewport winning when
   * there are more than `limit`. Off-screen ones count: they're scrolled to
   * before acting.
   */
  function gather(limit) {
    const all = everything()
    const hoverOnly = new Set()
    const candidates = new Set(
      [...all.filter((el) => isHtml(el) && el.matches(SELECTOR)), ...pointerTargets(all)].filter(
        (el) => {
          if (!el.checkVisibility()) return false
          // Links and buttons inside a rich-text editor are its content; the editor itself is the target
          if (el.parentElement?.isContentEditable) return false
          // A same-origin frame's own elements are listed instead of the frame
          if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && frameDocument(el)?.body)
            return false
          const r = rectOf(el)
          if (r.width < 4 || r.height < 4) return false
          const shown = el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          // Only its part in view can be hit-tested (an element across the fold too); off screen, it's scrolled to before acting
          const middle = shownMiddle(r)
          if (!middle || clippedByContainer(el)) return shown
          // On screen but covered by something else (a modal, a sticky header)
          if (!reachable(el, middle.x, middle.y)) return false
          if (!shown) hoverOnly.add(el)
          return true
        },
      ),
    )
    // Prefer the innermost match, so a <div onclick> wrapping a <button> isn't two entries. Only visible descendants
    // count, so a row isn't dropped for its hover-only buttons; an editor root stays a target whatever it holds.
    const hasCandidateInside = new Set(
      [...candidates].filter((el) => !hoverOnly.has(el)).flatMap(ancestorsOf),
    )
    const leaves = [...candidates].filter(
      (el) => !hasCandidateInside.has(el) || el.isContentEditable,
    )
    const kept = new Set(leaves.toSorted((a, b) => distance(a) - distance(b)).slice(0, limit))
    return { targets: leaves.filter((el) => kept.has(el)), hoverOnly }
  }

  /** The element's number, given now if it has none. */
  function number(el, fp) {
    let n = numbers.get(el)
    if (n == null) {
      n = next++
      numbers.set(el, n)
    }
    registry.set(n, { ref: new WeakRef(el), fp })
    return n
  }

  /** The element a number stands for, or a re-rendered copy of it (same kind, same words). */
  function resolve(n, fp) {
    const entry = registry.get(n)
    const el = entry?.ref.deref()
    if (el?.isConnected) return el
    const wanted = fp || entry?.fp
    if (wanted) {
      const same = gather(10_000).targets.filter((candidate) => fingerprint(candidate) === wanted)
      if (same.length === 1) {
        registry.set(n, { ref: new WeakRef(same[0]), fp: wanted })
        if (!numbers.has(same[0])) numbers.set(same[0], n)
        return same[0]
      }
    }
    throw new Error(`element ${n} isn't on the page anymore; look again for fresh numbers`)
  }

  /** The page as an outline: landmarks as sections, headings as #, text with elements inline as [n] role "label". */
  function outline(elements) {
    const lineFor = new Map(
      elements.map((e) => [
        e.el,
        `[${e.n}] ${e.role} "${e.label}"${e.offscreen ? ` (${e.offscreen})` : ""}`,
      ]),
    )
    const landmarks = {
      NAV: "navigation",
      MAIN: "main",
      HEADER: "header",
      FOOTER: "footer",
      ASIDE: "sidebar",
      FORM: "form",
      DIALOG: "dialog",
    }
    const landmarkRoles = new Set([
      "navigation",
      "main",
      "banner",
      "contentinfo",
      "complementary",
      "form",
      "dialog",
      "alertdialog",
      "search",
      "menu",
      "listbox",
      "tablist",
      "grid",
      "region",
      "alert",
      "status",
    ])
    const lines = []
    const printed = new Set()
    let pending = ""
    const flush = (depth) => {
      const text = clean(pending)
      if (text) lines.push(`${"  ".repeat(depth)}${text.slice(0, 800)}`)
      pending = ""
    }
    // The flat tree: a shadow host's shadow root stands in for its children, and a slot for what's assigned to it
    const childrenOf = (node) => {
      if (node.shadowRoot) return [...node.shadowRoot.childNodes]
      if (node.tagName === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true })
        return assigned.length ? assigned : [...node.childNodes]
      }
      return [...node.childNodes]
    }
    const walk = (node, depth) => {
      for (const child of childrenOf(node)) {
        if (child.nodeType === 3) {
          pending += ` ${child.textContent}`
          continue
        }
        if (!isHtml(child) || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(child.tagName))
          continue
        const indent = "  ".repeat(depth)
        if (child.tagName === "IFRAME" || child.tagName === "FRAME") {
          const doc = frameDocument(child)
          if (doc?.body && child.checkVisibility()) {
            flush(depth)
            const title = clean(child.getAttribute("title"))
            lines.push(`${indent}<frame${title ? ` "${title}"` : ""}>`)
            walk(doc.body, depth + 1)
            flush(depth + 1)
          } else if (lineFor.has(child)) {
            printed.add(child)
            pending += ` ${lineFor.get(child)} `
          }
          continue
        }
        // Numbered elements are listed even when aria-hidden: they passed the visibility and hit tests already
        const own = lineFor.get(child)
        if (
          !own &&
          (child.getAttribute("aria-hidden") === "true" ||
            // display:contents wrappers have no box, so checkVisibility calls them hidden
            (!child.checkVisibility({ visibilityProperty: true }) &&
              style(child).display !== "contents"))
        )
          continue
        if (own) {
          // Inline with the text around it, so a row like `1. [13] link "Title" 42 points` stays together. Numbered
          // controls nested inside (a row's hover-only buttons) follow it, since its subtree is skipped.
          const nested = [...child.querySelectorAll("*")].filter((el) => lineFor.has(el))
          for (const el of [child, ...nested]) printed.add(el)
          pending += ` ${[child, ...nested].map((el) => lineFor.get(el)).join(" ")} `
          continue
        }
        const level = /^H[1-6]$/.test(child.tagName)
          ? Number(child.tagName[1])
          : child.getAttribute("role") === "heading"
            ? Number(child.getAttribute("aria-level") ?? 2)
            : 0
        if (level) {
          // Walked rather than read with innerText, so links inside headings still get their numbers
          flush(depth)
          pending = `${"#".repeat(level)} `
          walk(child, depth)
          flush(depth)
          continue
        }
        const role = child.getAttribute("role")
        const landmark = role && landmarkRoles.has(role) ? role : landmarks[child.tagName]
        if (landmark) {
          flush(depth)
          const name = clean(child.getAttribute("aria-label"))
          lines.push(`${indent}<${landmark}${name ? ` "${name}"` : ""}>`)
          walk(child, depth + 1)
          flush(depth + 1)
          continue
        }
        const block = !style(child).display.startsWith("inline")
        if (block) flush(depth)
        walk(child, depth)
        if (block) flush(depth)
      }
    }
    if (document.body) walk(document.body, 0)
    flush(0)
    // Anything the walk skipped is still listed, so the outline offers every element there is to pick
    const missed = elements.filter((e) => !printed.has(e.el))
    if (missed.length)
      lines.push("<other elements>", ...missed.map((e) => `  ${lineFor.get(e.el)}`))
    const header = `(viewport shows y=${Math.round(scrollY)}–${Math.round(scrollY + innerHeight)} of a ${document.documentElement.scrollHeight}px page)`
    const body = lines.join("\n")
    return `${header}\n${body.length > 40_000 ? `${body.slice(0, 40_000)}\n…(cut)` : body}`
  }

  const overlayId = "__switch_marks"

  /** Draws each numbered element in view as a red box with its number, for an annotated screenshot. */
  function marks(elements) {
    unmark()
    const overlay = document.createElement("div")
    overlay.id = overlayId
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
    let drawn = 0
    for (const e of elements) {
      const r = rectOf(e.el)
      if (!inViewport(r)) continue
      const box = document.createElement("div")
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px ${e.hoverOnly ? "dashed" : "solid"} #e11d48;`
      const tag = document.createElement("span")
      tag.textContent = String(e.n)
      tag.style.cssText =
        "position:absolute;right:0;top:0;background:rgba(225,29,72,.85);color:#fff;font:bold 10px/11px monospace;padding:0 2px"
      box.append(tag)
      overlay.append(box)
      drawn++
    }
    document.documentElement.append(overlay)
    return drawn
  }

  function unmark() {
    document.getElementById(overlayId)?.remove()
  }

  /** Numbers what can be acted on and describes the page. */
  function collect({ limit = 254, start = 1, outline: withOutline = true, mark = false } = {}) {
    if (next < start) next = start
    for (const [n, entry] of registry) if (!entry.ref.deref()?.isConnected) registry.delete(n)
    const { targets, hoverOnly } = gather(limit)
    const elements = targets.map((el) => {
      const described = describe(el, 0, hoverOnly.has(el))
      return { ...described, n: number(el, described.fp), el, hoverOnly: hoverOnly.has(el) }
    })
    const text = withOutline ? outline(elements) : null
    const drawn = mark ? marks(elements) : 0
    return {
      elements: elements.map(({ el, hoverOnly: _, ...e }) => e),
      outline: text,
      marked: drawn,
      next,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollY: Math.round(scrollY),
        height_px: document.documentElement.scrollHeight,
      },
    }
  }

  /** How an element reads in a result: its number and line when it has one. */
  function brief(el) {
    for (let at = el; at; at = parentOf(at)) {
      const n = numbers.get(at)
      if (n != null && registry.get(n)?.ref.deref() === at) {
        const d = describe(at, n, false)
        return `[${n}] ${d.role} "${d.label}"`
      }
    }
    const text = clean(el.innerText ?? el.textContent).slice(0, 60)
    return `${el.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`
  }

  /**
   * A point (top viewport) where a click lands on the element, scrolling it into
   * view first if it isn't. The center of a link that wraps onto two lines falls
   * between them, so each line box is tried.
   */
  function point(n, fp) {
    const el = resolve(n, fp)
    const r = rectOf(el)
    const shown =
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= innerHeight &&
      r.right <= innerWidth &&
      !clippedByContainer(el) &&
      reachable(el, r.left + r.width / 2, r.top + r.height / 2)
    if (!shown) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
    const o = offsetOf(el)
    const centers = [...el.getClientRects(), el.getBoundingClientRect()]
      .filter((q) => q.width > 0 && q.height > 0)
      .map((q) => ({ x: q.left + q.width / 2 + o.x, y: q.top + q.height / 2 + o.y }))
    const good = centers.find((c) => reachable(el, c.x, c.y))
    if (good) return { x: good.x, y: good.y, scrolled: !shown }
    const last = centers.at(-1)
    if (!last) throw new Error(`element ${n} has no size on the page right now`)
    const cover = topmost(document, last.x, last.y)
    return { x: last.x, y: last.y, scrolled: !shown, covered: cover ? brief(cover) : "something" }
  }

  /** An element's box (top viewport) with a margin, scrolled into view first: what a zoomed screenshot frames. */
  function box(n, fp) {
    const el = resolve(n, fp)
    let r = rectOf(el)
    if (
      !(r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) ||
      clippedByContainer(el)
    ) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
      r = rectOf(el)
    }
    const pad = 8
    return [
      Math.max(0, r.left - pad),
      Math.max(0, r.top - pad),
      Math.min(innerWidth, r.right + pad),
      Math.min(innerHeight, r.bottom + pad),
    ]
  }

  /** Where the page is scrolled to. */
  function position() {
    return {
      x: Math.round(scrollX),
      y: Math.round(scrollY),
      view: innerHeight,
      height: document.documentElement.scrollHeight,
    }
  }

  /** What's at a point (top viewport), for clicks by position. */
  function at(x, y) {
    let doc = document
    let lx = x
    let ly = y
    for (;;) {
      const hit = topmost(doc, lx, ly)
      if (!hit) return "nothing"
      const inner = (hit.tagName === "IFRAME" || hit.tagName === "FRAME") && frameDocument(hit)
      if (!inner) return brief(hit)
      const r = hit.getBoundingClientRect()
      lx -= r.left + hit.clientLeft
      ly -= r.top + hit.clientTop
      doc = inner
    }
  }

  /** What typing into an element (or what has focus) would do: whether it's a field, and whether it's a secret one. */
  function field(n, fp) {
    const el = n == null ? deepActive() : resolve(n, fp)
    if (!el || el === document.body)
      return { editable: false, sensitive: null, tag: null, multiline: false }
    return {
      editable: isHtml(el) && editable(el),
      foreign: (el.tagName === "IFRAME" || el.tagName === "FRAME") && !frameDocument(el),
      sensitive: sensitive(el) || null,
      tag: el.tagName.toLowerCase(),
      type: el.type ?? null,
      role: implicitRole(el),
      multiline: el.tagName === "TEXTAREA" || !!el.isContentEditable,
      line: brief(el),
    }
  }

  /**
   * The text a field holds after typing: the focused editor's (a click can land
   * in an inner editor of a wrapper), else the element's. Multi-line editors are
   * left afterwards so their suggestion popups close; single-line ones keep focus
   * for Enter or an autocomplete pick.
   */
  function readBack(n, fp) {
    const focused = deepActive()
    const fieldish = (el) =>
      el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
    const el = fieldish(focused) ? focused : resolve(n, fp)
    if (sensitive(el)) throw new Error("that's a password or payment field, which you never read")
    const value =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : (el.innerText ?? "")
    if (el.tagName !== "INPUT" && isHtml(el)) el.blur()
    return value
  }

  /** A field's whole current value: an input's, a dropdown's choice, or an editor's text. */
  function value(n, fp) {
    const el = resolve(n, fp)
    const inner = el.matches("input, textarea, select, [contenteditable]")
      ? el
      : (el.querySelector("input, textarea, select, [contenteditable]") ?? el)
    if (sensitive(inner) || sensitive(el))
      throw new Error("that's a password or payment field, which you never read")
    if (inner.tagName === "INPUT" || inner.tagName === "TEXTAREA") return inner.value
    if (inner.tagName === "SELECT") return inner.selectedOptions[0]?.text ?? ""
    return inner.innerText ?? inner.textContent ?? ""
  }

  /**
   * How many characters a field holds, never what they are, so a payment
   * field the browser's autofill filled can be checked too. Null for
   * another site's frame, which the page can't read.
   */
  function length(n, fp) {
    const el = resolve(n, fp)
    if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && !frameDocument(el)) return null
    const inner = el.matches("input, textarea, [contenteditable]")
      ? el
      : (el.querySelector("input, textarea, [contenteditable]") ?? el)
    const value =
      inner.tagName === "INPUT" || inner.tagName === "TEXTAREA"
        ? inner.value
        : (inner.innerText ?? inner.textContent ?? "")
    return value.length
  }

  /** How many characters a field holds and how many of them are digits, never what they are. */
  function held(n, fp) {
    const el = resolve(n, fp)
    const inner = el.matches("input, textarea, [contenteditable]")
      ? el
      : (el.querySelector("input, textarea, [contenteditable]") ?? el)
    const value =
      inner.tagName === "INPUT" || inner.tagName === "TEXTAREA"
        ? inner.value
        : (inner.innerText ?? inner.textContent ?? "")
    return { length: value.length, digits: (value.match(/\d/g) ?? []).length }
  }

  /**
   * Marks a field the host just filled with one of the person's secrets (and
   * the editor in it the text went into), so it counts as a payment or
   * identity field from here on, which nothing reads back, and screenshots
   * show dots where its characters are.
   */
  function seal(n, fp) {
    const el = resolve(n, fp)
    const inner = el.matches("input, textarea, select, [contenteditable]")
      ? el
      : el.querySelector("input, textarea, select, [contenteditable]")
    const focused = deepActive()
    const typedInto =
      focused &&
      (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
        ? focused
        : null
    for (const field of new Set([el, inner, typedInto].filter(Boolean))) {
      field.setAttribute(SEALED, "")
      if (field.tagName !== "SELECT")
        field.style.setProperty("-webkit-text-security", "disc", "important")
    }
    return true
  }

  /**
   * Picks the dropdown option for one of the person's secrets (a card's month
   * or year): by its value or text, or the same number ("07" for "7 - July",
   * "2031" for "31"). Fails without saying which it looked for.
   */
  function chooseSecret(n, fp, wanted) {
    const el = resolve(n, fp)
    if (el.tagName !== "SELECT") throw new Error(`element ${n} isn't a dropdown`)
    const want = String(wanted)
    const lead = (text) => {
      const m = /^\s*(\d+)/.exec(text)
      return m ? Number(m[1]) : null
    }
    const number = /^\d+$/.test(want) ? Number(want) : null
    const short = /^\d{4}$/.test(want) ? Number(want.slice(2)) : null
    const fits = (o) =>
      [o.value, clean(o.textContent)].some(
        (t) =>
          t === want ||
          (number !== null &&
            (lead(t) === number ||
              (short !== null && /^\s*\d{2}\s*$/.test(t) && lead(t) === short))),
      )
    const option = [...el.options].find(fits)
    if (!option) throw new Error(`none of element ${n}'s ${el.options.length} options fits it`)
    setNative(el, option.value)
    return true
  }

  /** The card fields of the form `cardForm` makes. */
  const CARD = ["name", "number", "month", "year", "cvc"]
  const cardField = (name) => document.querySelector(`input[name="sw-card-${name}"]`)

  /** A card form of the host's own, in place of the page's words, for the browser's autofill to fill with a card it has saved. */
  function cardForm() {
    const autocomplete = {
      name: "cc-name",
      number: "cc-number",
      month: "cc-exp-month",
      year: "cc-exp-year",
      cvc: "cc-csc",
    }
    const labels = {
      name: "Name on card",
      number: "Card number",
      month: "Expiry month",
      year: "Expiry year",
      cvc: "Security code",
    }
    const form = document.createElement("form")
    form.setAttribute("autocomplete", "on")
    for (const name of CARD) {
      const label = document.createElement("label")
      label.textContent = `${labels[name]} `
      const input = document.createElement("input")
      input.name = `sw-card-${name}`
      input.setAttribute("autocomplete", autocomplete[name])
      label.append(input)
      form.append(label, document.createElement("br"))
    }
    document.body.replaceChildren(form)
    return true
  }

  /** How many characters each field of the card form holds. */
  function cardFilled() {
    return Object.fromEntries(CARD.map((name) => [name, cardField(name)?.value.length ?? 0]))
  }

  /** The card form's values, which the host keeps in the Keychain and never returns. */
  function harvest() {
    return Object.fromEntries(CARD.map((name) => [name, cardField(name)?.value ?? ""]))
  }

  /** Empties the card form, then the page. */
  function wipe() {
    for (const name of CARD) {
      const field = cardField(name)
      if (field) field.value = ""
    }
    document.body.replaceChildren()
    return true
  }

  /** A dropdown's options, by their text. */
  function options(n, fp) {
    const el = resolve(n, fp)
    if (el.tagName !== "SELECT") throw new Error(`element ${n} is not a dropdown`)
    return [...el.options].map((o) => clean(o.textContent)).filter(Boolean)
  }

  /** Sets a value the way a person's input would, so frameworks that track the native setter notice. */
  function setNative(el, value) {
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  }

  /**
   * Sets a form control: a dropdown's option (by text or value), a date, time,
   * number, range or color input. A checkbox, radio or switch says whether it
   * needs a click instead, since only a real click toggles it the way the page
   * expects. Text fields are typed into instead.
   */
  function set(n, fp, wanted) {
    const el = resolve(n, fp)
    if (sensitive(el)) throw new Error("that's a password or payment field, which you never fill")
    if (el.tagName === "SELECT") {
      const text = String(wanted)
      const option =
        [...el.options].find((o) => clean(o.textContent) === text) ??
        [...el.options].find((o) => o.value === text) ??
        [...el.options].find((o) => clean(o.textContent).toLowerCase().includes(text.toLowerCase()))
      if (!option)
        throw new Error(
          `no option "${text}"; it has ${[...el.options].map((o) => `"${clean(o.textContent)}"`).join(", ")}`,
        )
      setNative(el, option.value)
      return { set: clean(option.textContent) }
    }
    const state = toggleState(el)
    if (state) {
      const on = wanted === true || wanted === "true" || wanted === "on" || wanted === "checked"
      return { toggle: true, click: (state === "checked") !== on, was: state }
    }
    if (
      el.tagName === "INPUT" &&
      ["date", "time", "datetime-local", "month", "week", "number", "range", "color"].includes(
        el.type,
      )
    ) {
      setNative(el, String(wanted))
      return { set: el.value }
    }
    if (editable(el)) return { type: true }
    throw new Error(
      `element ${n} (${implicitRole(el)}) isn't something set fills: click it, or type into a field`,
    )
  }

  /**
   * The <input type=file> behind an element: the input itself, the one a label
   * is for, one inside an upload button or drop zone, or the only one in a small
   * container around it. With `loose`, also the page's only file input, for when
   * pressing the element opened no picker either.
   */
  function fileInput(n, fp, loose = false) {
    const el = resolve(n, fp)
    if (el.matches("input[type=file]")) return el
    if (el.tagName === "LABEL" && el.control?.matches("input[type=file]")) return el.control
    const inside = el.querySelector("input[type=file]")
    if (inside) return inside
    for (
      let scope = el.parentElement, depth = 0;
      scope && scope !== el.ownerDocument.body && depth < 3;
      scope = scope.parentElement, depth++
    ) {
      const found = scope.querySelectorAll("input[type=file]")
      if (found.length === 1) return found[0]
      if (found.length > 1) return null
    }
    const all = el.ownerDocument.querySelectorAll("input[type=file]")
    return loose && all.length === 1 ? all[0] : null
  }

  /** Whether the page has stopped changing: its load state, how long since the DOM last changed, and how long since it began leaving for another document, if it has (a page script that stopped that, or kept it in this document, cancels it). */
  function quiet() {
    const away =
      leaving && !leaving.event.defaultPrevented && !globalThis.navigation?.transition
        ? Math.round(performance.now() - leaving.at)
        : null
    return {
      ready: document.readyState,
      idle: Math.round(performance.now() - lastMutation),
      away,
      url: location.href,
    }
  }

  /** The page's readable text, main content first: an element's, the main region's, or the whole page's. */
  function text(n, fp) {
    if (n != null) return resolve(n, fp).innerText ?? ""
    const body = document.body
    if (!body) return document.documentElement?.textContent ?? ""
    const main = document.querySelector("main, [role=main], article")
    const whole = body.innerText ?? ""
    const own = main?.innerText ?? ""
    const frames = [...document.querySelectorAll("iframe, frame")]
      .map((f) => frameDocument(f)?.body?.innerText ?? "")
      .filter((t) => t.trim())
      .map((t) => `\n\n[frame]\n${t}`)
      .join("")
    // The main region alone when it carries most of the page; everything otherwise (and nothing lost either way)
    const chosen =
      own.length > 200 && own.length > whole.length * 0.4
        ? `${own}\n\n[rest of the page]\n${whole.replace(own, "")}`
        : whole
    return (chosen + frames).replaceAll(/\n{3,}/g, "\n\n")
  }

  /** The text in view, block by block from the top, up to `max` characters: what a person sees at a glance. */
  function inView(max = 1500) {
    const blocks = []
    let length = 0
    const selector =
      "h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote,figcaption,dt,dd,label,button,a[href],[role=alert],[role=status]"
    for (const el of document.querySelectorAll(selector)) {
      if (length >= max) break
      const r = el.getBoundingClientRect()
      if (
        !(
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.top < innerHeight &&
          r.right > 0 &&
          r.left < innerWidth
        )
      )
        continue
      // Leafish blocks only: a block whose children are blocks too reads twice
      if (el.querySelector(selector) && !/^(H\d|P|LI|PRE|BLOCKQUOTE)$/.test(el.tagName)) continue
      const line = clean(el.innerText)
      if (!line) continue
      blocks.push(line.slice(0, 300))
      length += line.length
    }
    return blocks.join("\n").slice(0, max)
  }

  /** Whether something under a point (top viewport) can scroll vertically, the page itself included. */
  function canScrollAt(x, y) {
    for (let el = topmost(document, x, y); el; el = parentOf(el))
      if (isHtml(el) && scrolls(el)) return true
    const root = document.scrollingElement
    return !!root && root.scrollHeight > root.clientHeight + 1
  }

  /**
   * The focused field, for the portal's keyboard (portal.rs): its kind (a
   * password field reads as "password" whatever its type says), its
   * autocomplete and its box in the viewport. Never its value. Inside a
   * same-origin frame it's that frame's field; a cross-origin one reads as
   * "frame", which can't be seen into.
   */
  function focused() {
    let el = document.activeElement
    let dx = 0
    let dy = 0
    for (;;) {
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
      if (!el || !/^(IFRAME|FRAME)$/.test(el.tagName)) break
      let inner = null
      try {
        inner = el.contentDocument?.activeElement ?? null
      } catch {}
      if (!inner || inner === el.contentDocument.body) {
        const r = el.getBoundingClientRect()
        return { kind: "frame", rect: [r.left + dx, r.top + dy, r.width, r.height] }
      }
      const frame = el.getBoundingClientRect()
      dx += frame.left
      dy += frame.top
      el = inner
    }
    if (!el || el === document.body || el === document.documentElement) return null
    const type = el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : ""
    const editable =
      el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" &&
        !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(type))
    if (!editable) return null
    const r = el.getBoundingClientRect()
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().trim() || null
    const kind =
      sensitive(el) === "password"
        ? "password"
        : ["email", "number", "tel", "url", "search"].includes(type)
          ? type
          : "text"
    return { kind, autocomplete, rect: [r.left + dx, r.top + dy, r.width, r.height] }
  }

  const USERNAME_HINT =
    /user.?name|user.?id|e.?mail|login|sign.?in.?name|identifier|loginfmt|account.?name/i
  const CODE_HINT =
    /one.?time|\botp\b|\botc\b|totp|\bmfa\b|\b2fa\b|two.?factor|verification|authenticat|security.?code|\bpasscode\b|\bcode\b/i
  const NOT_CODE_HINT = /promo|coupon|gift|discount|referr|zip|postal|country|area.?code|captcha/i
  const NOT_USERNAME_HINT = /newsletter|subscri|promo|coupon|search|invite|referr|contact/i

  /** The words that name a field: its name, id, label, placeholder. */
  const fieldWords = (el) =>
    [
      el.name,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      ...[...(el.labels ?? [])].map((l) => l.innerText),
    ].join(" ")

  /** What a field on a sign-in page is for: "username", "password", "new password" or "code"; "" for anything else. */
  function signinKind(el) {
    if (!isHtml(el) || el.tagName !== "INPUT" || !editable(el)) return ""
    const type = (el.type || "text").toLowerCase()
    if (!["text", "email", "tel", "number", "password"].includes(type)) return ""
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase()
    const words = fieldWords(el)
    if (/\bone-time-code\b/.test(auto)) return "code"
    if (/\bnew-password\b/.test(auto)) return "new password"
    if (/\bcurrent-password\b/.test(auto)) return "password"
    if (
      CODE_HINT.test(words) &&
      !NOT_CODE_HINT.test(words) &&
      !(type === "password" && /pass(word|phrase)/i.test(words))
    )
      return "code"
    if (type === "password") return "password"
    // A newsletter's or a search's email box in the footer isn't who signs in.
    if (NOT_USERNAME_HINT.test(words) || NOT_USERNAME_HINT.test(el.form?.innerText ?? "")) return ""
    if (type === "email" || /\b(username|email)\b/.test(auto) || USERNAME_HINT.test(words))
      return "username"
    return ""
  }

  /** The boxes of a code split one character to a box, from one of them: the four or more around it. */
  function codeBoxes(el) {
    if (el.maxLength !== 1) return null
    for (let at = parentOf(el), depth = 0; at && depth < 4; at = parentOf(at), depth++) {
      const boxes = [...at.querySelectorAll("input")].filter(
        (i) => i.maxLength === 1 && editable(i) && i.checkVisibility(),
      )
      if (boxes.length >= 4) return boxes
    }
    return null
  }

  /**
   * A sign-in page's fields (username, password, new password, code), in
   * the order they come: each one's number, what it's for, and how many
   * characters it holds, never what. A code split into boxes is one field,
   * numbered by its first box.
   */
  function signin() {
    const seen = new Set()
    const fields = []
    for (const el of everything()) {
      if (seen.has(el) || el.tagName !== "INPUT") continue
      const boxes = codeBoxes(el)
      const kind = boxes ? "code" : signinKind(el)
      if (!kind || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
        continue
      const r = rectOf(el)
      if (r.width < 4 || r.height < 4) continue
      for (const box of boxes ?? [el]) seen.add(box)
      const n = number(el, fingerprint(el))
      fields.push({
        n,
        fp: fingerprint(el),
        kind,
        boxes: boxes?.length ?? 1,
        length: (boxes ?? [el]).reduce((sum, box) => sum + box.value.length, 0),
        line: `[${n}] ${implicitRole(el)} "${clean(fieldWords(el)).slice(0, 60)}"`,
      })
    }
    return fields
  }

  /**
   * What sends a field's form on: its form's submit button, else the button
   * after it that says so (Next, Sign in, Verify…). Its number, or null when
   * there's none and Enter will have to do.
   */
  function submitter(n, fp) {
    const el = resolve(n, fp)
    const shown = (b) =>
      b.checkVisibility() && rectOf(b).width >= 4 && !b.matches(":disabled, [aria-disabled=true]")
    const SAYS =
      /^(next|continue|sign ?in|log ?in|verify|submit|confirm|done|ok|send|proceed|weiter|anmelden)\b/i
    const named = (b) => clean(b.innerText || b.value || b.getAttribute("aria-label"))
    let button = el.form
      ? [...el.form.querySelectorAll("button, input[type=submit], input[type=image]")].find(
          (b) =>
            shown(b) &&
            (b.type === "submit" || b.type === "image") &&
            !/forgot|reset|back|cancel|other|create/i.test(named(b)),
        )
      : null
    if (!button) {
      const after = (b) => el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      const candidates = gather(500).targets.filter(
        (b) => implicitRole(b) === "button" && shown(b) && SAYS.test(named(b)),
      )
      button = candidates.find(after) ?? candidates[0]
    }
    return button ? number(button, fingerprint(button)) : null
  }

  /** On an account picker, the one tile for this username: its number, or null. */
  function chooser(username) {
    const wanted = username.toLowerCase()
    const tiles = gather(500).targets.filter(
      (el) =>
        el.tagName !== "INPUT" &&
        /button|link|option|listitem|menuitem|div/.test(implicitRole(el)) &&
        clean(el.innerText).toLowerCase().includes(wanted),
    )
    return tiles.length === 1 ? number(tiles[0], fingerprint(tiles[0])) : null
  }

  /**
   * What an element holds, for a stored account's vault and nothing else:
   * a field's value (a password field's too), else an otpauth link in or
   * under it, else its text. Without an element, the page's: an otpauth
   * link anywhere in it, else all its words. The host keeps it and never
   * returns it.
   */
  function reveal(n, fp) {
    const el = n == null ? document.body : resolve(n, fp)
    const inner =
      n == null ? null : el.matches("input, textarea") ? el : el.querySelector("input, textarea")
    if (inner?.value) return inner.value
    const link = [el, ...el.querySelectorAll("[href], [src], [data-value], [value]")]
      .flatMap((x) => [
        x.getAttribute("href"),
        x.getAttribute("src"),
        x.getAttribute("data-value"),
        x.getAttribute("value"),
      ])
      .find((v) => v?.startsWith("otpauth://"))
    if (link) return link
    // A page's words take in its same-origin frames, and keys shown in read-only boxes.
    const more =
      n == null
        ? everything().flatMap((x) =>
            /^I?FRAME$/.test(x.tagName)
              ? [frameDocument(x)?.body?.innerText ?? ""]
              : x.tagName === "INPUT" && x.readOnly
                ? [x.value]
                : [],
          )
        : []
    return [el.innerText ?? el.textContent ?? "", ...more].join("\n")
  }

  globalThis.__switch = {
    version: VERSION,
    focused,
    collect,
    resolve,
    point,
    box,
    position,
    at,
    field,
    readBack,
    value,
    length,
    options,
    set,
    fileInput,
    quiet,
    text,
    inView,
    marks,
    unmark,
    canScrollAt,
    signin,
    submitter,
    chooser,
    reveal,
    held,
    seal,
    chooseSecret,
    cardForm,
    cardFilled,
    harvest,
    wipe,
  }
  return "installed"
})()
