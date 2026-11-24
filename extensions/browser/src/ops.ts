// The `act` tool: exact control of a session's tab, one op or a list of them (`steps`), each saying
// where the tab is after it. Ported from Switchboard's ops.rs.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { isJson } from "./chrome.ts"
import { browserFills, done, hold, nowOn, num, str, whatAt } from "./common.ts"
import type { Decide, Done } from "./common.ts"
import { redact, redactUrl, refusal, secretText } from "./guard.ts"
import { fillSecret } from "./secrets.ts"
import { listAccounts, saveAccount, signIn } from "./signin.ts"
import { noteHeld } from "./session.ts"
import { describe, line, listed, modifierBits, parseKey } from "./tab.ts"
import type { Tab } from "./tab.ts"

export { type Element } from "./tab.ts"

export const OPS = [
  "look",
  "find",
  "click",
  "type",
  "set",
  "autofill",
  "sign_in",
  "fill_secret",
  "save_account",
  "accounts",
  "key",
  "hover",
  "scroll",
  "drag",
  "screenshot",
  "text",
  "value",
  "wait",
  "navigate",
  "back",
  "forward",
  "reload",
  "js",
  "upload",
  "dialog",
  "console",
  "network",
  "tabs",
  "attach",
  "show",
  "hold",
  "release",
] as const

/** Ops about the session rather than its page: they don't open a tab. */
const SESSION_OPS = new Set([
  "console",
  "network",
  "tabs",
  "attach",
  "show",
  "hold",
  "release",
  "accounts",
  "save_account",
])

/** What fits in an agent's tool result, with room to spare. */
const MAX_TEXT = 24_000

const textArg = (args: Json, name: string) => (typeof args[name] === "string" ? args[name] : null)

export const need = (args: Json, name: string, op: string) => {
  const v = textArg(args, name)
  if (v === null) {
    throw new Error(`${op} needs ${name}`)
  }
  return v
}

export const expand = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

/** Text cut to what fits a tool result. */
export const cut = (text: string) =>
  text.length <= MAX_TEXT
    ? text
    : `${text.slice(0, MAX_TEXT)}\n…(cut: find, scroll and look, or text reads the rest)`

/** Text that matches element lines: a /regex/, or words in any case. */
const matcher = (pattern: string) => {
  const inner = pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")
  try {
    return inner ? new RegExp(pattern.slice(1, -1), "u") : new RegExp(RegExp.escape(pattern), "iu")
  } catch {
    throw new Error(`${pattern} isn't a regex that parses`)
  }
}

export type Target = { readonly element: number } | { readonly x: number; readonly y: number }

export const targeted = (args: Json) =>
  num(args.element) !== null ||
  textArg(args, "match") !== null ||
  (num(args.x) !== null && num(args.y) !== null)

/** The element whose line matches, waiting a little for one to appear. */
const matching = async (tab: Tab, pattern: string, index: number, ms: number) => {
  const re = matcher(pattern)
  const deadline = Date.now() + ms
  for (;;) {
    const snapshot = await tab.snapshot(2000, false, false)
    const found = snapshot.elements.filter((e) => re.test(line(e)))[index]
    if (found) {
      return found
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `No element's line matches ${JSON.stringify(pattern)}${index > 0 ? ` ${index + 1} times` : ""} (look shows what's there)`,
      )
    }
    await Bun.sleep(400)
  }
}

/** The element (by number or match) or point an op acts on. */
export const target = async (tab: Tab, args: Json): Promise<Target> => {
  const element = num(args.element)
  if (element !== null) {
    return { element }
  }
  const pattern = textArg(args, "match")
  if (pattern !== null) {
    const ms = Math.min(Math.max(num(args.timeout) ?? 5, 0), 60) * 1000
    const found = await matching(tab, pattern, num(args.index) ?? 0, ms)
    return { element: found.n }
  }
  const x = num(args.x)
  const y = num(args.y)
  if (x !== null && y !== null) {
    return { x, y }
  }
  throw new Error(
    "Which element? Give element (a number from look or find), match (text in its line), or x and y",
  )
}

const elementOf = async (tab: Tab, args: Json, what: string) => {
  const t = await target(tab, args)
  if (!("element" in t)) {
    throw new Error(`${what} works on an element (a number or match), not a point`)
  }
  return t.element
}

const pointOf = async (tab: Tab, t: Target) => ("element" in t ? await tab.point(t.element) : t)

const autofillOp = async (tab: Tab, args: Json) => {
  const t = await target(tab, args)
  const at = await pointOf(tab, t)
  const what = await whatAt(tab, at)
  const offered = await browserFills(tab, at, textArg(args, "pick"))
  if (offered.chose === null) {
    return done(
      `For ${what}, the browser offers:\n${offered.labels.map((l) => `- ${l}`).join("\n")}\nFill one with pick: words from its line, like a card's last four digits.`,
    )
  }
  await Bun.sleep(500)
  const length =
    "element" in t
      ? num(await tab.page(`length(${t.element}, ${tab.known(t.element)})`).catch(() => null))
      : null
  let check = `The field now holds ${length} characters.`
  if (length === 0) {
    check =
      "The field still reads empty: the browser may be asking to verify it's the user (Touch ID or the Mac's password) or for the card's security code; look at a screenshot."
  } else if (length === null) {
    check =
      "It's in another site's frame, which can't be read back from here: look at a screenshot to check."
  }
  return done(
    `The browser filled ${what} with "${offered.chose}" (a card fills its other fields too). ${check}\n${await nowOn(tab)}`,
  )
}

const look = async (tab: Tab, args: Json) => {
  const url = textArg(args, "url")
  if (url !== null) {
    await tab.navigate(url)
  }
  if (textArg(args, "view") !== "screenshot") {
    const s = await tab.snapshot(400, false, true)
    return done(cut(`${s.title} — ${redactUrl(s.url)}\n${s.outline}`))
  }
  const s = await tab.snapshot(400, true, false)
  try {
    const shot = await tab.screenshot(null, 1)
    const inView = s.elements.filter((e) => e.offscreen === null).map(listed)
    return {
      text: cut(
        `${s.title} — ${redactUrl(s.url)}\nThe screenshot (${shot.width}×${shot.height}, its pixels are click coordinates) boxes and numbers these:\n${inView.join("\n")}`,
      ),
      images: [shot],
    }
  } finally {
    await tab.page("unmark()").catch(() => null)
  }
}

const find = async (tab: Tab, args: Json, decide: Decide) => {
  const wanted = textArg(args, "text") ?? textArg(args, "match")
  if (wanted === null) {
    throw new Error("find needs text")
  }
  const re = matcher(wanted)
  const s = await tab.snapshot(2000, false, false)
  const found = s.elements
    .filter((e) => re.test(line(e)) || (e.href !== null && re.test(e.href)))
    .slice(0, 30)
    .map(listed)
  if (found.length > 0) {
    return done(found.join("\n"))
  }
  // No words match: the decision model says which elements fit the description best.
  const near = await tab.snapshot(254, false, false)
  if (near.elements.length === 0) {
    return done("Nothing on the page can be acted on.")
  }
  const decided = await decide(
    {
      stable: "Which numbered element of this web page best matches the description?",
      item: JSON.stringify({ url: near.url, title: near.title, description: wanted }),
    },
    {
      element: {
        instructions: `Which numbered element of this web page best matches this description: ${wanted}?`,
        choices: near.elements.map((e) => ({ value: `e${e.n}`, description: describe(e) })),
      },
    },
  ).catch(() => null)
  const probabilities = decided?.answers.element?.probabilities
  if (!probabilities) {
    return done(`No element's words match ${JSON.stringify(wanted)}.`)
  }
  const ranked = Object.entries(probabilities)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .flatMap(([choice, p]) => {
      const e = near.elements.find((x) => `e${x.n}` === choice)
      return e ? [`${listed(e)} (${p.toFixed(2)})`] : []
    })
  return done(
    `No element's words match ${JSON.stringify(wanted)}; closest by meaning (with the decision model's probability):\n${ranked.join("\n")}`,
  )
}

const click = async (tab: Tab, args: Json) => {
  const at = await pointOf(tab, await target(tab, args))
  const what = await whatAt(tab, at)
  const button = textArg(args, "button") ?? "left"
  if (!["left", "right", "middle"].includes(button)) {
    throw new Error("button is left, right or middle")
  }
  const count = Math.min(Math.max(num(args.count) ?? 1, 1), 3)
  const held = modifierBits(textArg(args, "modifiers") ?? "")
  tab.log.chooser = null
  const since = Date.now()
  await tab.clickAt(at, button, count, held)
  await tab.settle(since)
  const how =
    button === "left"
      ? (["Clicked", "Double-clicked", "Triple-clicked"][count - 1] ?? "Clicked")
      : `${button[0]?.toUpperCase() ?? ""}${button.slice(1)}-clicked`
  return done(`${how} ${what}.\n${await nowOn(tab)}`)
}

/** Types where the focus is, unless that's a secret field. */
const typeAtFocus = async (tab: Tab, text: string, keystrokes: boolean) => {
  const field = await tab.pageJson("field(null)")
  if (typeof field.sensitive === "string") {
    throw new TypeError(refusal(field.sensitive))
  }
  await (keystrokes ? tab.keystrokes(text) : tab.insert(text))
  return `Typed ${text.length} characters where the focus is (${str(field.line) || "nothing focused"})`
}

const typeText = async (tab: Tab, args: Json) => {
  const text = need(args, "text", "type")
  const why = secretText(text)
  if (why !== null) {
    throw new Error(`That text reads as ${why}, and you never type those`)
  }
  const append = args.append === true
  const keystrokes = args.keystrokes === true
  const submit = args.submit === true
  const since = Date.now()
  let said: string
  if (targeted(args)) {
    const t = await target(tab, args)
    if ("element" in t) {
      const n = t.element
      const field = await tab.pageJson(`field(${n}, ${tab.known(n)})`)
      if (typeof field.sensitive === "string") {
        throw new TypeError(refusal(field.sensitive))
      }
      if (field.editable !== true) {
        throw new Error(
          `${str(field.line) || "That element"} isn't a text field: click it, or set it if it's a dropdown or checkbox`,
        )
      }
      await tab.fill(n, text, append, keystrokes)
      said = `Typed into ${str(field.line) || "the field"}`
    } else {
      await tab.clickAt(t)
      said = await typeAtFocus(tab, text, keystrokes)
    }
  } else {
    said = await typeAtFocus(tab, text, keystrokes)
  }
  if (submit) {
    await tab.press(parseKey("Enter"))
  }
  await tab.settle(since)
  return done(`${said}${submit ? ", then pressed Enter" : ""}.\n${await nowOn(tab)}`)
}

const set = async (tab: Tab, args: Json) => {
  const n = await elementOf(tab, args, "set")
  const { value } = args
  if (value === undefined) {
    throw new Error("set needs value")
  }
  if (typeof value === "string") {
    const why = secretText(value)
    if (why !== null) {
      throw new Error(`That value reads as ${why}, and you never type those`)
    }
  }
  const since = Date.now()
  const outcome = await tab.pageJson(`set(${n}, ${tab.known(n)}, ${JSON.stringify(value)})`)
  let said: string
  if (outcome.toggle === true) {
    const on = value === true || value === "true" || value === "on" || value === "checked"
    if (outcome.click === true) {
      await tab.clickAt(await tab.point(n))
      said = `Switched [${n}] ${on ? "on" : "off"}`
    } else {
      said = `[${n}] was already ${str(outcome.was) || (on ? "on" : "off")}`
    }
  } else if (outcome.type === true) {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    await tab.fill(n, text)
    said = `Typed "${text}" into [${n}]`
  } else {
    said = `Set [${n}] to "${str(outcome.set)}"`
  }
  await tab.settle(since)
  return done(`${said}.\n${await nowOn(tab)}`)
}

const scroll = async (tab: Tab, args: Json) => {
  const direction = textArg(args, "direction")
  const t = targeted(args) ? await target(tab, args) : null
  if (direction === null && t !== null && "element" in t) {
    await tab.point(t.element)
    return done(`Scrolled [${t.element}] into view.\n${await nowOn(tab)}`)
  }
  const { width, height } = await tab.viewport()
  const amount = Math.min(Math.max(num(args.amount) ?? 0.8, 0.05), 20)
  const moves: Record<string, readonly [number, number]> = {
    down: [0, height * amount],
    up: [0, -height * amount],
    right: [width * amount, 0],
    left: [-width * amount, 0],
  }
  const move = moves[direction ?? "down"]
  if (!move) {
    throw new Error(`No direction "${direction}"; it's down, up, left or right`)
  }
  let at: { x: number; y: number }
  if (t === null) {
    // Like a person: scroll where the mouse is when something there scrolls, else mid-page.
    const center = { x: width / 2, y: height / 2 }
    const pointer = tab.s.pointer ?? center
    const here =
      (await tab.page(`canScrollAt(${pointer.x}, ${pointer.y})`).catch(() => false)) === true
    at = here ? pointer : center
  } else {
    at = await pointOf(tab, t)
  }
  const since = Date.now()
  await tab.wheel(at, move[0], move[1])
  await tab.settle(since)
  const p = await tab.pageJson("position()")
  const y = num(p.y) ?? 0
  return done(
    `Scrolled ${direction ?? "down"} at (${Math.round(at.x)}, ${Math.round(at.y)}); the page shows y=${y}–${y + (num(p.view) ?? 0)} of ${num(p.height) ?? 0}px.\n${await nowOn(tab)}`,
  )
}

const screenshot = async (tab: Tab, args: Json) => {
  let region: [number, number, number, number] | null = null
  if (Array.isArray(args.region)) {
    const v = args.region.filter((x) => typeof x === "number")
    if (v.length !== 4) {
      throw new Error("region is [x0, y0, x1, y1]")
    }
    region = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]
  } else if (targeted(args)) {
    const n = await elementOf(tab, args, "A screenshot of an element")
    const b = await tab.page(`box(${n}, ${tab.known(n)})`)
    const v = Array.isArray(b) ? b.filter((x) => typeof x === "number") : []
    if (v.length === 4) {
      region = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]
    }
  }
  const zoom = Math.min(Math.max(num(args.scale) ?? (region === null ? 1 : 2), 0.2), 4)
  const marks = args.marks === true
  const marked = marks ? await tab.snapshot(400, true, false) : null
  let shot: Awaited<ReturnType<Tab["screenshot"]>>
  try {
    shot = await tab.screenshot(region, zoom)
  } finally {
    if (marks) {
      await tab.page("unmark()").catch(() => null)
    }
  }
  let text =
    region === null
      ? `Screenshot of the viewport, ${shot.width}×${shot.height}: its pixels are click coordinates (x, y).`
      : `Screenshot of x ${Math.round(region[0])}–${Math.round(region[2])}, y ${Math.round(region[1])}–${Math.round(region[3])} at ${zoom}×: image pixel (px, py) is page point (${Math.round(region[0])} + px/${zoom}, ${Math.round(region[1])} + py/${zoom}).`
  if (marked !== null) {
    text += `\nNumbered on it:\n${marked.elements
      .filter((e) => e.offscreen === null)
      .map(listed)
      .join("\n")}`
  }
  text += `\n${await nowOn(tab)}`
  return { text: cut(text), images: [shot] }
}

const wait = async (tab: Tab, args: Json) => {
  const wanted = textArg(args, "text") ?? textArg(args, "match")
  if (wanted === null) {
    const seconds = Math.min(Math.max(num(args.seconds) ?? 2, 0), 60)
    await Bun.sleep(seconds * 1000)
    return done(`Waited ${seconds}s.\n${await nowOn(tab)}`)
  }
  const re = matcher(wanted)
  const gone = args.gone === true
  const seconds = Math.min(Math.max(num(args.timeout) ?? num(args.seconds) ?? 10, 0.5), 120)
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const s = await tab.snapshot(400, false, true)
    const hit = s.outline.split("\n").find((l) => re.test(l))
    if (hit !== undefined && !gone) {
      return done(`It's there: ${hit.trim().slice(0, 300)}\n${await nowOn(tab)}`)
    }
    if (hit === undefined && gone) {
      return done(`It's gone.\n${await nowOn(tab)}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Waited ${seconds}s: ${gone ? "it's still there" : "nothing matched"}`)
    }
    await Bun.sleep(400)
  }
}

/**
 * Attaches files to the file input behind element `n`, without a file picker: the input itself (or
 * the one it labels or holds), else the picker pressing it opens, caught by the debugger, else the
 * page's only file input. Files already attached aren't attached again.
 */
export const attachFiles = async (tab: Tab, n: number, paths: readonly string[]) => {
  const names = paths.map((p) => p.split("/").at(-1) ?? p)
  const input = await tab.fileInput(n, false)
  if (input !== null) {
    const had = await tab.attached(input)
    if (names.every((name) => had.includes(name))) {
      return `already attached ${names.join(", ")} to [${n}].`
    }
    await tab.cdp("DOM.setFileInputFiles", { files: paths, objectId: input })
    return `attached ${names.join(", ")} to [${n}].`
  }
  tab.log.chooser = null
  await tab.clickAt(await tab.point(n))
  const deadline = Date.now() + 4000
  const chooser = () => tab.log.chooser
  while (Date.now() < deadline) {
    const opened = chooser()
    if (opened !== null) {
      tab.log.chooser = null
      if (opened.mode === "selectSingle" && paths.length > 1) {
        throw new Error("This picker takes one file")
      }
      await tab.cdp("DOM.setFileInputFiles", { files: paths, backendNodeId: opened.backendNodeId })
      return `attached ${names.join(", ")} through the picker [${n}] opens.`
    }
    await Bun.sleep(100)
  }
  const loose = await tab.fileInput(n, true)
  if (loose === null) {
    throw new Error(`There's no file input behind [${n}], and pressing it opened no file picker`)
  }
  await tab.cdp("DOM.setFileInputFiles", { files: paths, objectId: loose })
  return `attached ${names.join(", ")} to the page's file input.`
}

/** A file's real path, or why not. */
export const realFile = async (p: string) => {
  const full = path.resolve(expand(p))
  if (!(await Bun.file(full).exists())) {
    throw new Error(`No file at ${p}`)
  }
  return full
}

const upload = async (tab: Tab, args: Json) => {
  const n = await elementOf(tab, args, "upload")
  const given = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : []
  if (given.length === 0) {
    throw new Error("upload needs paths: absolute paths of files on this Mac")
  }
  const paths = await Promise.all(given.map(realFile))
  const since = Date.now()
  const said = await attachFiles(tab, n, paths)
  await tab.settle(since)
  return done(`${said}\n${await nowOn(tab)}`)
}

const network = async (tab: Tab, args: Json) => {
  const body = textArg(args, "body")
  if (body !== null) {
    await tab.ensure()
    const r = await tab.cdp("Network.getResponseBody", { requestId: body }).catch(() => {
      throw new Error("Chrome no longer has that response (only recent ones are kept)")
    })
    const text = str(r.body)
    return done(r.base64Encoded === true ? `(binary, ${text.length} bytes of base64)` : cut(text))
  }
  const pattern = textArg(args, "match") ?? textArg(args, "text")
  const re = pattern === null ? null : matcher(pattern)
  const lines = tab.log.network
    .filter((r) => re === null || re.test(r.url))
    .map((r) => {
      let status = r.status === null ? "…" : String(r.status)
      if (r.failed !== null) {
        status = `failed (${r.failed})`
      }
      return `${r.id} ${r.method} ${status} ${r.kind ?? "?"}${r.bytes === null ? "" : ` ${r.bytes}B`} ${redactUrl(r.url)}`
    })
  if (args.clear === true) {
    tab.log.network = []
  }
  const shown = lines.slice(-80).join("\n")
  return done(
    shown === ""
      ? "No requests since the tab was opened."
      : cut(`id method status type size url (network body {id} reads a response):\n${shown}`),
  )
}

const consoleOp = (tab: Tab, args: Json) => {
  const pattern = textArg(args, "text") ?? textArg(args, "match")
  const re = pattern === null ? null : matcher(pattern)
  const errors = args.errors === true
  const lines = tab.log.console
    .filter((l) => !errors || /^\[(?:error|exception|crash)\]/u.test(l))
    .filter((l) => re === null || re.test(l))
  if (args.clear === true) {
    tab.log.console = []
  }
  const shown = lines.slice(-60).join("\n")
  return done(shown === "" ? "No console messages since the tab was opened." : cut(shown))
}

/** One op. */
const one = async (tab: Tab, args: Json, decide: Decide): Promise<Done> => {
  const op = textArg(args, "op")
  if (op === null) {
    throw new Error(`Which op? One of ${OPS.join(", ")}`)
  }
  if (!SESSION_OPS.has(op)) {
    await tab.ensure()
    if (op !== "dialog" && op !== "screenshot") {
      tab.noDialog()
    }
  }
  switch (op) {
    case "look": {
      return await look(tab, args)
    }
    case "find": {
      return await find(tab, args, decide)
    }
    case "click": {
      return await click(tab, args)
    }
    case "hover": {
      const at = await pointOf(tab, await target(tab, args))
      const what = await whatAt(tab, at)
      const since = Date.now()
      await tab.glide(at)
      await tab.settle(since)
      return done(`Hovering over ${what}.\n${await nowOn(tab)}`)
    }
    case "type": {
      return await typeText(tab, args)
    }
    case "set": {
      return await set(tab, args)
    }
    case "autofill": {
      return await autofillOp(tab, args)
    }
    case "sign_in": {
      return await signIn(tab, args)
    }
    case "fill_secret": {
      return await fillSecret(tab, args, await target(tab, args))
    }
    case "save_account": {
      return await saveAccount(
        tab,
        args,
        targeted(args) ? await elementOf(tab, args, "save_account") : null,
      )
    }
    case "accounts": {
      return await listAccounts(args)
    }
    case "key": {
      const keys = need(args, "keys", "key")
      const presses = keys.split(/\s+/u).filter(Boolean).map(parseKey)
      const repeat = Math.min(Math.max(num(args.repeat) ?? 1, 1), 100)
      const since = Date.now()
      for (let i = 0; i < repeat; i += 1) {
        for (const p of presses) {
          await tab.press(p)
        }
      }
      await tab.settle(since)
      return done(`Pressed ${keys}${repeat > 1 ? ` ×${repeat}` : ""}.\n${await nowOn(tab)}`)
    }
    case "scroll": {
      return await scroll(tab, args)
    }
    case "drag": {
      const from = await pointOf(tab, await target(tab, args))
      const { to } = args
      let dest: { x: number; y: number }
      if (typeof to === "number") {
        dest = await tab.point(to)
      } else if (Array.isArray(to) && to.length === 2) {
        dest = { x: num(to[0]) ?? 0, y: num(to[1]) ?? 0 }
      } else if (typeof to === "string") {
        const found = await matching(tab, to, 0, 5000)
        dest = await tab.point(found.n)
      } else {
        throw new Error("drag needs to: an element number, a match, or [x, y]")
      }
      const what = await whatAt(tab, from)
      const since = Date.now()
      await tab.drag(from, dest)
      await tab.settle(since)
      return done(
        `Dragged ${what} to (${Math.round(dest.x)}, ${Math.round(dest.y)}).\n${await nowOn(tab)}`,
      )
    }
    case "screenshot": {
      return await screenshot(tab, args)
    }
    case "text": {
      const n = targeted(args) ? await elementOf(tab, args, "text") : null
      const words = await tab.page(`text(${n ?? "null"}, ${n === null ? '""' : tab.known(n)})`)
      const { url, title } = await tab.info()
      return done(cut(`${title} — ${redactUrl(url)}\n\n${str(words)}`))
    }
    case "value": {
      const n = await elementOf(tab, args, "value")
      const value = str(await tab.page(`value(${n}, ${tab.known(n)})`))
      const saveTo = textArg(args, "save_to")
      if (saveTo === null) {
        return done(cut(redact(value)))
      }
      const file = expand(saveTo)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, value, { mode: 0o600 })
      chmodSync(file, 0o600)
      return done(
        `Saved the ${value.length} characters of [${n}] to ${file} (readable only by its owner); they stay out of the log.`,
      )
    }
    case "wait": {
      return await wait(tab, args)
    }
    case "navigate": {
      await tab.navigate(need(args, "url", "navigate"))
      return done(await nowOn(tab))
    }
    case "back":
    case "forward": {
      await tab.history(op === "back" ? -1 : 1)
      return done(await nowOn(tab))
    }
    case "reload": {
      const since = Date.now()
      await tab.cdp("Page.reload")
      await tab.settle(since)
      return done(await nowOn(tab))
    }
    case "js": {
      const code = need(args, "code", "js")
      const ms = Math.min(Math.max(num(args.timeout) ?? 30, 1), 120) * 1000
      const since = Date.now()
      const value = await tab.script(code, ms)
      await tab.settle(since)
      if (typeof value === "string") {
        return done(cut(value))
      }
      return done(value === null ? "(no value)" : cut(JSON.stringify(value, null, 2)))
    }
    case "upload": {
      return await upload(tab, args)
    }
    case "dialog": {
      const { dialog } = tab.log
      if (dialog === null) {
        throw new Error("No dialog is open")
      }
      if (typeof args.accept !== "boolean") {
        throw new TypeError("dialog needs accept: true or false")
      }
      const params: Json = { accept: args.accept }
      const text = textArg(args, "text")
      if (text !== null) {
        const why = secretText(text)
        if (why !== null) {
          throw new Error(`That text reads as ${why}, and you never type those`)
        }
        params.promptText = text
      }
      const since = Date.now()
      await tab.cdp("Page.handleJavaScriptDialog", params)
      tab.log.dialog = null
      await tab.settle(since)
      return done(
        `${args.accept ? "Accepted" : "Dismissed"} the ${str(dialog.type) || "dialog"} "${str(dialog.message)}".\n${await nowOn(tab)}`,
      )
    }
    case "console": {
      return consoleOp(tab, args)
    }
    case "network": {
      return await network(tab, args)
    }
    case "tabs": {
      const tabs = await chrome.call("tabs", {}, 10_000)
      const lines = (Array.isArray(tabs) ? tabs : []).filter(isJson).map((t) => {
        const front = t.front === true ? " (in front)" : ""
        const group = typeof t.group === "string" ? ` [${t.group}]` : ""
        const s = typeof t.session === "string" ? ` (session ${t.session})` : ""
        return `${String(t.tabId)}${front}${group}${s} ${str(t.title)} — ${redactUrl(str(t.url))}`
      })
      return done(cut(lines.join("\n")))
    }
    case "attach": {
      const given = args.tab
      let tabId: number | "front" = "front"
      if (given !== "front") {
        tabId = typeof given === "number" ? given : Math.trunc(Number(str(given)))
      }
      if (tabId !== "front" && Number.isNaN(tabId)) {
        throw new TypeError('attach needs tab: an id from tabs, or "front" for the tab in front')
      }
      const adopted = await chrome.call("adopt", { session: tab.name, tabId }, 15_000)
      tab.s.forget()
      const a = isJson(adopted) ? adopted : {}
      return done(
        `Now driving tab ${String(a.tabId)}: ${str(a.title)} — ${redactUrl(str(a.url))}. It stays where it is; release hands it back.`,
      )
    }
    case "show": {
      const shown = await chrome.call("show", { session: tab.name }, 10_000)
      const s = isJson(shown) ? shown : {}
      return done(`The tab is in front now: ${str(s.title)} — ${redactUrl(str(s.url))}`)
    }
    case "hold": {
      const hours = Math.min(Math.max(num(args.hours) ?? 24, 0.1), 72)
      await hold(tab.name, Date.now() + hours * 3_600_000)
      return done(
        `The tab stays open for ${hours} hours (or until released), for whatever waits on it.`,
      )
    }
    case "release": {
      const keep = args.keep === true
      await chrome.call("release", { session: tab.name, keepOpen: keep }, 15_000)
      noteHeld(tab.name, 0)
      tab.s.forget()
      return done(
        keep
          ? "Released: the tab is left open for the user, out of the agents' tab group."
          : "Released: its tabs are closed, and taken-over tabs handed back.",
      )
    }
    default: {
      throw new Error(`No op "${op}"; ops are ${OPS.join(", ")}`)
    }
  }
}

/** One op, or `steps`: a list run in order, each inheriting the call's session, stopping at the first that fails. */
export const act = async (tab: Tab, args: Json, decide: Decide): Promise<Done> => {
  const { steps } = args
  if (!Array.isArray(steps)) {
    if (args.op === "steps") {
      throw new Error("op steps needs steps: a list of ops")
    }
    return await one(tab, args, decide)
  }
  // `op: "steps"` with the list, as Switchboard's browser action took it, is the list alone.
  const { steps: _, op: given, ...rest } = args
  const base: Json = given === undefined || given === "steps" ? rest : { ...rest, op: given }
  const out: Done = { text: "", images: [] }
  for (const [i, step] of steps.entries()) {
    const merged: Json = { ...base, ...(isJson(step) ? step : {}) }
    try {
      const d = await one(tab, merged, decide)
      out.text += `${i + 1}. ${d.text.trimEnd()}\n`
      out.images.push(...d.images)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const before = out.text === "" ? "" : `\nDone before it:\n${out.text.trimEnd()}`
      throw new Error(`Step ${i + 1} (${str(merged.op) || "?"}) failed: ${message}${before}`, {
        cause: error,
      })
    }
  }
  return out
}
