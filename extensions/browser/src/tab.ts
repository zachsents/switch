// One session's tab, driven through the extension's debugger: the page script in an isolated world
// of its own, waiting for the page to settle, and the mouse, keyboard and screenshots as the
// browser's own input events, trusted like a person's, not scripted clicks. Ported from
// Switchboard's tab.rs.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { isJson } from "./chrome.ts"
import { redact } from "./guard.ts"
import { session } from "./session.ts"
import type { Session } from "./session.ts"

const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : null)

const SOURCE = readFileSync(path.join(import.meta.dir, "page.js"), "utf-8")
/** The page script, stamped with a hash of itself, so a page holding an older copy takes this one. */
const PAGE = SOURCE.replace(
  "const VERSION = 1;",
  `const VERSION = "${createHash("sha256").update(SOURCE).digest("hex").slice(0, 16)}";`,
)

/** A page counts as settled once its DOM has been still this long (ms)… */
const QUIET_MS = 400
/** …but never sooner than this after an action, so the page can react… */
const AT_LEAST = 120
/** …nor later than this, unless a page is still loading… */
const AT_MOST = 5000
/** …and never longer than this. */
const LOAD_AT_MOST = 15_000
/** A debugger command's longest wait. */
const CDP_MS = 30_000

/** An element the page script numbered. */
export interface Element {
  readonly n: number
  readonly tag: string
  readonly role: string
  label: string
  readonly editable: boolean
  readonly href: string | null
  readonly sensitive: string | null
  readonly offscreen: string | null
  readonly fp: string
}

const toElement = (v: unknown): Element | null => {
  if (!isJson(v) || typeof v.n !== "number") {
    return null
  }
  return {
    n: v.n,
    tag: str(v.tag),
    role: str(v.role),
    label: str(v.label),
    editable: v.editable === true,
    href: typeof v.href === "string" ? v.href : null,
    sensitive: typeof v.sensitive === "string" ? v.sensitive : null,
    offscreen: typeof v.offscreen === "string" ? v.offscreen : null,
    fp: str(v.fp),
  }
}

/** How the decision model reads it: `[12] link "Ask" -> /ask (below, ~2 screens)`. */
export const describe = (e: Element) => {
  const tag = e.role === e.tag ? "" : ` <${e.tag}>`
  const href = e.href === null ? "" : ` -> ${e.href}`
  const off = e.offscreen === null ? "" : ` (${e.offscreen})`
  return `[${e.n}] ${e.role}${tag} ${e.label === "" ? "(no text)" : e.label}${href}${off}`
}

/** What `match` matches and an approval names: `button "Save"`. */
export const line = (e: Element) => `${e.role} "${e.label}"`

/** How it's listed for agents: `[12] link "Ask" -> /ask (below, ~2 screens)`. */
export const listed = (e: Element) => {
  const href = e.href === null ? "" : ` -> ${e.href}`
  const off = e.offscreen === null ? "" : ` (${e.offscreen})`
  return `[${e.n}] ${line(e)}${href}${off}`
}

export interface Snapshot {
  readonly elements: Element[]
  readonly outline: string
  readonly url: string
  readonly title: string
}

/** A key press as the browser's input events, with the editing command a Mac would run for it. */
export interface Press {
  readonly key: string
  readonly code: string
  readonly vk: number
  readonly modifiers: number
  readonly text: string | null
  readonly command: string | null
}

const NAMED: Record<string, readonly [string, number]> = {
  escape: ["Escape", 27],
  esc: ["Escape", 27],
  enter: ["Enter", 13],
  return: ["Enter", 13],
  tab: ["Tab", 9],
  backspace: ["Backspace", 8],
  delete: ["Delete", 46],
  del: ["Delete", 46],
  space: ["Space", 32],
  arrowup: ["ArrowUp", 38],
  up: ["ArrowUp", 38],
  arrowdown: ["ArrowDown", 40],
  down: ["ArrowDown", 40],
  arrowleft: ["ArrowLeft", 37],
  left: ["ArrowLeft", 37],
  arrowright: ["ArrowRight", 39],
  right: ["ArrowRight", 39],
  home: ["Home", 36],
  end: ["End", 35],
  pageup: ["PageUp", 33],
  pagedown: ["PageDown", 34],
  insert: ["Insert", 45],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, [`F${i + 1}`, 112 + i] as const]),
  ),
}

/** Modifier keys as CDP's bits. */
export const modifierBits = (text: string) => {
  let bits = 0
  for (const part of text.split("+").map((p) => p.trim().toLowerCase())) {
    if (part === "") {
      continue
    }
    if (part === "alt" || part === "option" || part === "opt") {
      bits |= 1
    } else if (part === "ctrl" || part === "control") {
      bits |= 2
    } else if (part === "cmd" || part === "command" || part === "meta" || part === "super") {
      bits |= 4
    } else if (part === "shift") {
      bits |= 8
    } else {
      throw new Error(`No modifier "${part}"; use cmd, ctrl, alt or shift`)
    }
  }
  return bits
}

const COMMANDS: Record<string, string> = {
  "4:a": "selectAll",
  "2:a": "selectAll",
  "4:c": "copy",
  "2:c": "copy",
  "4:x": "cut",
  "2:x": "cut",
  "4:v": "paste",
  "2:v": "paste",
  "4:z": "undo",
  "2:z": "undo",
  "12:z": "redo",
  "10:z": "redo",
  "4:arrowleft": "moveToBeginningOfLine",
  "4:arrowright": "moveToEndOfLine",
  "4:arrowup": "moveToBeginningOfDocument",
  "4:arrowdown": "moveToEndOfDocument",
  "1:arrowleft": "moveWordLeft",
  "1:arrowright": "moveWordRight",
  "1:backspace": "deleteWordBackward",
  "4:backspace": "deleteToBeginningOfLine",
}

/** Parses a combination like `Escape`, `cmd+a`, `Shift+Tab` or `a`. */
export const parseKey = (combo: string): Press => {
  const parts = combo.split("+").map((p) => p.trim())
  let name = parts.pop() ?? ""
  if (name === "" && combo.endsWith("+")) {
    name = "+"
  }
  const modifiers = modifierBits(parts.join("+"))
  const named = NAMED[name.toLowerCase()]
  let press: Omit<Press, "modifiers" | "command">
  if (named) {
    const [key, vk] = named
    const TYPED: Record<string, string> = { Space: " ", Enter: "\r" }
    const typed = TYPED[key] ?? null
    press = { key: key === "Space" ? " " : key, code: key, vk, text: typed }
  } else if (name.length === 1) {
    const upper = name.toUpperCase()
    let code = ""
    if (/\d/u.test(name)) {
      code = `Digit${name}`
    } else if (/[a-z]/iu.test(name)) {
      code = `Key${upper}`
    }
    press = { key: name, code, vk: upper.codePointAt(0) ?? 0, text: name }
  } else {
    throw new Error(
      `No key "${name}"; use names like Escape, Enter, Tab, ArrowDown, PageDown, F5, or one character`,
    )
  }
  const shortcut = (modifiers & 6) !== 0
  return {
    ...press,
    modifiers,
    text: shortcut ? null : press.text,
    command: COMMANDS[`${modifiers}:${press.key.toLowerCase()}`] ?? null,
  }
}

/** Text compared loosely: zero-width characters dropped, whitespace collapsed. */
export const loosely = (text: string) =>
  text.replaceAll(/[​-‍﻿]/gu, "").split(/\s+/u).filter(Boolean).join(" ")

/** Whether an evaluation failed because the document it ran in went away. */
const stale = (error: unknown) => {
  const text = String(error instanceof Error ? error.message : error)
  return [
    "Cannot find context",
    "Execution context was destroyed",
    "__switch",
    "Inspected target navigated",
    "Cannot find default execution context",
    "No frame",
  ].some((sign) => text.includes(sign))
}

/** A page exception's message without "Error: " and the page's stack. */
const pageError = (details: Json) => {
  const exception = isJson(details.exception) ? details.exception : {}
  const description = str(exception.description) || str(details.text) || "the page script failed"
  const first = description.split("\n")[0] ?? description
  return first.startsWith("Error: ") ? first.slice(7) : first
}

/** The handles an agent's script leaves, let go once its value is copied out. */
const SCRIPT_GROUP = "switch-script"

/** A debugger reply's result, or what stopped it: a dialog the page opened, or the page's error. */
const settled = (reply: Json): Json => {
  if (reply.dialog === true) {
    throw new Error(
      "The page opened a dialog, which holds its scripts until it's answered (op dialog)",
    )
  }
  if (isJson(reply.exceptionDetails)) {
    throw new Error(pageError(reply.exceptionDetails))
  }
  return isJson(reply.result) ? reply.result : {}
}

/** A result's value copied out: null for undefined, its description when it can't be copied. */
const copied = (result: Json): unknown => {
  if ("value" in result) {
    return result.value
  }
  if (result.type === "undefined") {
    return null
  }
  return str(result.description) || "(a value that can't be copied out)"
}

const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi)

/** A session's tab, with its gate held: every op on it goes through here. */
/** A frame from another site in the tab, and its own debugger session when it has one. */
export interface Frame {
  readonly frameId: string
  readonly session: string | null
}

/**
 * What runs in a frame's world (`frameWorld`) around a fill: the focused text box is marked (an
 * attribute, which every world sees), then counted, sealed (dots in screenshots) or emptied, never read.
 */
export const FRAME_FIELD = {
  mark: `(() => {
    let el = document.activeElement
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    const editable = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.readOnly && !el.disabled
    for (const old of document.querySelectorAll("[data-switch-fill]")) old.removeAttribute("data-switch-fill")
    if (editable) el.setAttribute("data-switch-fill", "")
    return { editable }
  })()`,
  held: `(() => {
    const el = document.querySelector("[data-switch-fill]")
    const value = el ? el.value : ""
    return { length: value.length, digits: (value.match(/\\d/g) || []).length }
  })()`,
  seal: `(() => {
    const el = document.querySelector("[data-switch-fill]")
    if (!el) return {}
    el.style.setProperty("-webkit-text-security", "disc", "important")
    el.setAttribute("data-switch-sealed", "")
    el.removeAttribute("data-switch-fill")
    return {}
  })()`,
  empty: `(() => {
    const el = document.querySelector("[data-switch-fill]")
    if (!el) return {}
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "")
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.removeAttribute("data-switch-fill")
    return {}
  })()`,
}

export class Tab {
  readonly s: Session

  constructor(s: Session) {
    this.s = s
  }

  get name() {
    return this.s.name
  }

  get log() {
    return this.s.log
  }

  /** Opens the session's tab in the background if it has none. */
  async ensure() {
    if (!this.s.opened) {
      await chrome.call("open", { session: this.s.name, group: this.s.group }, CDP_MS)
      this.s.opened = true
    }
  }

  /**
   * A debugger command. The browser doesn't answer a command while the page sits in a dialog it
   * opened, so when one opens during it, this stops waiting and says `{dialog: true}`.
   */
  async cdp(method: string, params: Json = {}, ms = CDP_MS): Promise<Json> {
    const sent = chrome.call(
      "cdp",
      { session: this.s.name, group: this.s.group, method, params },
      ms,
    )
    if (this.log.dialog !== null) {
      const r = await sent
      return isJson(r) ? r : {}
    }
    const watch = { on: true }
    const opened = (async () => {
      for (;;) {
        await Bun.sleep(40)
        if (!watch.on) {
          return {}
        }
        if (this.log.dialog !== null) {
          return { dialog: true }
        }
      }
    })()
    try {
      const r = await Promise.race([sent, opened])
      return isJson(r) ? r : {}
    } finally {
      watch.on = false
    }
  }

  /** A dialog waiting for an answer blocks the page's scripts, so ops that need them stop here. */
  noDialog() {
    const d = this.log.dialog
    if (d !== null) {
      throw new Error(
        `A ${str(d.type) || "JavaScript"} dialog is open in the tab: "${str(d.message)}". Answer it first with op dialog {accept: true or false}`,
      )
    }
  }

  private async evaluate(context: number | null, expression: string, ms = CDP_MS, repl = false) {
    const params: Json = { expression, returnByValue: !repl, awaitPromise: true, userGesture: true }
    if (context !== null) {
      params.contextId = context
    }
    if (!repl) {
      return copied(settled(await this.cdp("Runtime.evaluate", params, ms)))
    }
    // REPL mode awaits a top-level `await`, but not a promise the code ends on (an async IIFE), so
    // the result stays a handle: a promise is awaited, anything else copied out, then let go.
    params.replMode = true
    params.objectGroup = SCRIPT_GROUP
    try {
      const result = settled(await this.cdp("Runtime.evaluate", params, ms))
      const id = str(result.objectId)
      if (id === "") {
        return copied(result)
      }
      const reply =
        result.subtype === "promise"
          ? await this.cdp("Runtime.awaitPromise", { promiseObjectId: id, returnByValue: true }, ms)
          : await this.cdp(
              "Runtime.callFunctionOn",
              {
                objectId: id,
                functionDeclaration: "function () { return this }",
                returnByValue: true,
              },
              ms,
            )
      return copied(settled(reply))
    } finally {
      if (this.log.dialog === null) {
        // Not waited on: a page still busy past the timeout mustn't hold the answer longer.
        this.cdp("Runtime.releaseObjectGroup", { objectGroup: SCRIPT_GROUP }).catch(() => {})
      }
    }
  }

  /** The page script's world in the current document, made and installed if the document changed. */
  private async worldId() {
    const { generation } = this.log
    if (this.s.world?.generation === generation) {
      return this.s.world.id
    }
    const tree = await this.cdp("Page.getFrameTree")
    const frameTree = isJson(tree.frameTree) ? tree.frameTree : {}
    const frame = isJson(frameTree.frame) ? str(frameTree.frame.id) : ""
    if (frame === "") {
      throw new Error("The tab has no page")
    }
    this.log.mainFrame = frame
    const made = await this.cdp("Page.createIsolatedWorld", {
      frameId: frame,
      worldName: "switch",
      grantUniveralAccess: true,
    })
    const id = num(made.executionContextId)
    if (id === null) {
      throw new Error("Chrome made no isolated world")
    }
    await this.evaluate(id, PAGE)
    this.s.world = { id, generation }
    return id
  }

  /** Calls the page script (`point(3, "…")`), installing it again when the document changed. */
  async page(call: string, ms = CDP_MS): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      this.noDialog()
      try {
        const id = await this.worldId()
        return await this.evaluate(id, `globalThis.__switch.${call}`, ms)
      } catch (error) {
        if (attempt >= 3 || !stale(error)) {
          throw error
        }
        this.s.world = null
        await Bun.sleep(150)
      }
    }
  }

  /** The page script's answer as an object. */
  async pageJson(call: string): Promise<Json> {
    const v = await this.page(call)
    return isJson(v) ? v : {}
  }

  /** Runs an agent's JavaScript in the page's own world, REPL-style. */
  async script(code: string, ms: number) {
    this.noDialog()
    return await this.evaluate(null, code, ms, true)
  }

  /** The tab's address and title. */
  async info() {
    const t = await chrome.call("tab", { session: this.s.name }, CDP_MS)
    return isJson(t) ? { url: str(t.url), title: str(t.title) } : { url: "", title: "" }
  }

  /**
   * Waits for the page to settle after an action that started at `since`: a new document's DOM in,
   * the document, fetch and XHR requests the action started done, and the DOM still for a moment.
   * A page set leaving for another document counts as loading until that document's in. Bounded,
   * so a page that never stops costs seconds, not forever.
   */
  async settle(since: number) {
    let leaving = false
    for (;;) {
      const elapsed = Date.now() - since
      const { log } = this
      const loading = log.loadingSince !== null
      const busy = [...log.inflight.values()].some((started) => started >= since)
      const stopped = log.stopped !== null && log.stopped >= since
      if (
        log.dialog !== null ||
        elapsed > LOAD_AT_MOST ||
        (elapsed > AT_MOST && !loading && !leaving)
      ) {
        return
      }
      if (elapsed >= AT_LEAST && !loading && !busy) {
        try {
          const quiet = await this.page("quiet()", 3000)
          if (isJson(quiet)) {
            const away = num(quiet.away)
            leaving = away !== null && away <= Date.now() - since && !stopped
            if (quiet.ready !== "loading" && (num(quiet.idle) ?? 0) >= QUIET_MS && !leaving) {
              return
            }
          }
        } catch {
          // Mid-navigation: looked at again next time round.
        }
      }
      await Bun.sleep(80)
    }
  }

  /** Numbers what can be acted on and describes the page. */
  async snapshot(limit: number, mark: boolean, outline: boolean): Promise<Snapshot> {
    const start = Math.max(this.s.next, 1)
    const got = await this.pageJson(`collect(${JSON.stringify({ limit, start, outline, mark })})`)
    const raw = Array.isArray(got.elements) ? got.elements : []
    const elements = raw.flatMap((e) => {
      const el = toElement(e)
      return el ? [el] : []
    })
    // Masked here, so neither agents nor decision models ever see what a page shows of credentials.
    for (const e of elements) {
      e.label = redact(e.label)
    }
    this.s.next = Math.max(num(got.next) ?? start, start)
    if (this.s.seen.size > 5000) {
      const keepFrom = this.s.next - 2000
      for (const n of this.s.seen.keys()) {
        if (n < keepFrom) {
          this.s.seen.delete(n)
        }
      }
    }
    for (const e of elements) {
      this.s.seen.set(e.n, e.fp)
    }
    const { url, title } = await this.info()
    return { elements, outline: redact(str(got.outline)), url, title }
  }

  /** What the agent knew a number as, so the page can find it again. */
  known(n: number) {
    return JSON.stringify(this.s.seen.get(n) ?? "")
  }

  /** A point that clicks element `n`, scrolled into view. */
  async point(n: number) {
    const p = await this.pageJson(`point(${n}, ${this.known(n)})`)
    if (typeof p.covered === "string") {
      throw new TypeError(
        `Element ${n} is covered by ${p.covered} right now; close that first (Escape often does), or act on it if it's what you want`,
      )
    }
    const x = num(p.x)
    const y = num(p.y)
    if (x === null || y === null) {
      throw new Error(`No point for element ${n}`)
    }
    return { x, y }
  }

  private async mouse(
    type: string,
    at: { x: number; y: number },
    button: string,
    buttons: number,
    clickCount: number,
    modifiers: number,
  ) {
    await this.cdp("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button,
      buttons,
      clickCount,
      modifiers,
    })
  }

  /** Moves the mouse onto a point in one move, which is what hover menus need. */
  async glide(to: { x: number; y: number }, buttons = 0) {
    const p = this.s.pointer
    if (p?.x !== to.x || p.y !== to.y) {
      await this.mouse("mouseMoved", to, buttons === 0 ? "none" : "left", buttons, 0, 0)
    }
    this.s.pointer = to
  }

  /** A real click at a point: `count` 2 or 3 for double and triple clicks. */
  async clickAt(at: { x: number; y: number }, button = "left", count = 1, modifiers = 0) {
    await this.glide(at)
    const buttons = { right: 2, middle: 4 }[button] ?? 1
    for (let click = 1; click <= Math.min(Math.max(count, 1), 3); click += 1) {
      await this.mouse("mousePressed", at, button, buttons, click, modifiers)
      await this.mouse("mouseReleased", at, button, 0, click, modifiers)
    }
  }

  /** Presses at one point, moves to another through steps on the way, and lets go. */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.glide(from)
    await this.mouse("mousePressed", from, "left", 1, 1, 0)
    const steps = 12
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await this.mouse(
        "mouseMoved",
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        "left",
        1,
        0,
        0,
      )
      await Bun.sleep(16)
    }
    await this.mouse("mouseReleased", to, "left", 0, 1, 0)
    this.s.pointer = to
  }

  /** Presses one key combination. */
  async press(p: Press) {
    const down: Json = {
      type: p.text === null ? "rawKeyDown" : "keyDown",
      key: p.key,
      code: p.code,
      windowsVirtualKeyCode: p.vk,
      modifiers: p.modifiers,
    }
    if (p.text !== null) {
      down.text = p.text
      down.unmodifiedText = p.text
    }
    if (p.command !== null) {
      down.commands = [p.command]
    }
    await this.cdp("Input.dispatchKeyEvent", down)
    await this.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: p.key,
      code: p.code,
      windowsVirtualKeyCode: p.vk,
      modifiers: p.modifiers,
    })
  }

  /** Puts text in at the cursor in one go, as a paste or an IME would. */
  async insert(text: string) {
    await this.cdp("Input.insertText", { text })
  }

  /** Types text a key at a time, for editors that only react to typing. A newline is Enter. */
  async keystrokes(text: string) {
    for (const c of text) {
      const enter = c === "\n"
      const key = enter ? "Enter" : c
      const code = enter ? "Enter" : ""
      const vk = enter ? 13 : 0
      const typed = enter ? "\r" : c
      await this.cdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: vk,
        text: typed,
        unmodifiedText: typed,
      })
      await this.cdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: vk,
      })
      await Bun.sleep(12)
    }
  }

  /** Replaces a field's text (or adds to it), then reads it back and fails if it didn't stick. */
  async fill(n: number, text: string, append = false, keystrokes = false) {
    await this.clickAt(await this.point(n))
    if (append) {
      await this.press({
        key: "End",
        code: "End",
        vk: 35,
        modifiers: 0,
        text: null,
        command: "moveToEndOfDocument",
      })
    } else {
      await this.press(parseKey("cmd+a"))
      await this.press(parseKey("Backspace"))
    }
    await (keystrokes ? this.keystrokes(text) : this.insert(text))
    const value = str(await this.page(`readBack(${n}, ${this.known(n)})`))
    const got = loosely(value)
    const wanted = loosely(text)
    if (append ? !got.endsWith(wanted) : got !== wanted) {
      throw new Error(
        `The field didn't end up with the text; it reads "${value.slice(0, 120)}"${keystrokes ? "" : " (try keystrokes: true)"}`,
      )
    }
    return value
  }

  /** Replaces a field's text with a secret (a one-time code) and says how long it is, never reading it. */
  async fillHidden(n: number, text: string) {
    await this.clickAt(await this.point(n))
    let held = 0
    for (const keystrokes of [false, true]) {
      await this.press(parseKey("cmd+a"))
      await this.press(parseKey("Backspace"))
      await (keystrokes ? this.keystrokes(text) : this.insert(text))
      held = num(await this.page(`length(${n}, ${this.known(n)})`)) ?? 0
      if (held > 0) {
        break
      }
    }
    return held
  }

  /**
   * Another site's frame at a point (a card form's secure box), which the page script can't reach:
   * its frame id, and its own debugger session when it runs in a process of its own. Null when the
   * point isn't on one.
   */
  async foreignFrame(at: { x: number; y: number }): Promise<Frame | null> {
    const hit = await this.cdp("DOM.getNodeForLocation", {
      x: Math.round(at.x),
      y: Math.round(at.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    })
    const backendNodeId = num(hit.backendNodeId)
    if (backendNodeId === null) {
      return null
    }
    const described = await this.cdp("DOM.describeNode", { backendNodeId })
    const node = isJson(described.node) ? described.node : {}
    const frameId = str(node.frameId)
    if (!/^i?frame$/iu.test(str(node.nodeName)) || frameId === "") {
      return null
    }
    const own = await chrome.call(
      "frame",
      { session: this.s.name, group: this.s.group, frameId },
      CDP_MS,
    )
    return { frameId, session: typeof own === "string" ? own : null }
  }

  /** Runs expressions in a world of this extension's own inside a frame (`foreignFrame`). */
  async frameWorld(frame: Frame) {
    const send = async (method: string, params: Json) => {
      const r =
        frame.session === null
          ? await this.cdp(method, params)
          : await chrome.call(
              "cdp",
              { session: this.s.name, group: this.s.group, method, params, frame: frame.session },
              CDP_MS,
            )
      return isJson(r) ? r : {}
    }
    const made = await send("Page.createIsolatedWorld", {
      frameId: frame.frameId,
      worldName: "switch-frame",
    })
    const contextId = num(made.executionContextId)
    if (contextId === null) {
      throw new Error("Chrome made no world in the frame")
    }
    return async (expression: string) => {
      const reply = await send("Runtime.evaluate", { expression, contextId, returnByValue: true })
      if (isJson(reply.exceptionDetails)) {
        throw new Error(pageError(reply.exceptionDetails))
      }
      const result = isJson(reply.result) ? reply.result : {}
      return isJson(result.value) ? result.value : {}
    }
  }

  /**
   * Replaces the text of the field at a point inside another site's frame with a secret, the way
   * `fillHidden` does a page's own: clicked into, then put in at once, or key by key when the field
   * drops that. Says how many characters and digits it then holds, never what they are, and gives
   * the frame's world back for sealing or emptying it.
   */
  async fillInFrame(frame: Frame, at: { x: number; y: number }, text: string) {
    await this.clickAt(at)
    await Bun.sleep(150)
    const world = await this.frameWorld(frame)
    const focused = await world(FRAME_FIELD.mark)
    if (focused.editable !== true) {
      throw new Error("Clicking there put the cursor in no text box inside the frame")
    }
    let held = { length: 0, digits: 0 }
    for (const keystrokes of [false, true]) {
      await this.press(parseKey("cmd+a"))
      await this.press(parseKey("Backspace"))
      await (keystrokes ? this.keystrokes(text) : this.insert(text))
      const read = await world(FRAME_FIELD.held)
      held = { length: num(read.length) ?? 0, digits: num(read.digits) ?? 0 }
      if (held.length > 0) {
        break
      }
    }
    return { held, world }
  }

  /** Wheel scrolling at a point in a few eased steps, like a person's scroll. */
  async wheel(at: { x: number; y: number }, dx: number, dy: number) {
    await this.glide(at)
    const frames = 5
    let done = { x: 0, y: 0 }
    for (let i = 1; i <= frames; i += 1) {
      const t = i / frames
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const to = { x: dx * eased, y: dy * eased }
      await this.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: at.x,
        y: at.y,
        deltaX: to.x - done.x,
        deltaY: to.y - done.y,
      })
      done = to
      await Bun.sleep(30)
    }
  }

  /** The viewport's size in CSS pixels. */
  async viewport() {
    const metrics = await this.cdp("Page.getLayoutMetrics")
    const view = isJson(metrics.cssVisualViewport) ? metrics.cssVisualViewport : {}
    const width = num(view.clientWidth)
    const height = num(view.clientHeight)
    if (width === null || height === null) {
      throw new Error("No viewport")
    }
    return { width, height, zoom: num(view.zoom) ?? 1 }
  }

  /**
   * A JPEG of the viewport at CSS-pixel size (so its pixels are click coordinates), or of a region
   * of it, `zoom` times larger. Works while the tab is in the background.
   */
  async screenshot(region: readonly [number, number, number, number] | null, zoom: number) {
    const { width, height, zoom: pageZoom } = await this.viewport()
    const world = await this.worldId()
    const ratio = num(await this.evaluate(world, "devicePixelRatio")) ?? 1
    const [a, b, c, d] = region ?? [0, 0, width, height]
    const x0 = clamp(a, width)
    const y0 = clamp(b, height)
    const x1 = clamp(c, width)
    const y1 = clamp(d, height)
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      throw new Error(`That region is outside the viewport (${width}×${height})`)
    }
    const clip = {
      x: x0 * pageZoom,
      y: y0 * pageZoom,
      width: (x1 - x0) * pageZoom,
      height: (y1 - y0) * pageZoom,
      scale: zoom / ratio,
    }
    const shot = await this.cdp("Page.captureScreenshot", { format: "jpeg", quality: 70, clip })
    const data = str(shot.data)
    if (data === "") {
      throw new Error("Chrome sent no image")
    }
    return { data, width: Math.round((x1 - x0) * zoom), height: Math.round((y1 - y0) * zoom) }
  }

  /** The `<input type=file>` behind element `n`, as a debugger handle (`loose`: or the page's only one). */
  async fileInput(n: number, loose: boolean) {
    this.noDialog()
    const world = await this.worldId()
    const reply = await this.cdp("Runtime.evaluate", {
      expression: `globalThis.__switch.fileInput(${n}, ${this.known(n)}, ${loose})`,
      contextId: world,
      returnByValue: false,
    })
    if (isJson(reply.exceptionDetails)) {
      throw new Error(pageError(reply.exceptionDetails))
    }
    const result = isJson(reply.result) ? reply.result : {}
    return typeof result.objectId === "string" ? result.objectId : null
  }

  /** The names of the files a file input holds now. */
  async attached(input: string) {
    const reply = await this.cdp("Runtime.callFunctionOn", {
      objectId: input,
      functionDeclaration: "function () { return [...(this.files ?? [])].map((f) => f.name) }",
      returnByValue: true,
    })
    const result = isJson(reply.result) ? reply.result : {}
    return Array.isArray(result.value) ? result.value.filter((v) => typeof v === "string") : []
  }

  /** Loads a URL in the tab and waits for it to settle. */
  async navigate(url: string) {
    this.noDialog()
    const full = /^(?:[a-z]+:\/\/|about:|data:|file:)/u.test(url) ? url : `https://${url}`
    const since = Date.now()
    const went = await this.cdp("Page.navigate", { url: full })
    if (str(went.errorText) !== "") {
      throw new Error(`Couldn't load ${full}: ${str(went.errorText)}`)
    }
    this.s.world = null
    await this.settle(since)
  }

  /** Goes back or forward in the tab's history. */
  async history(step: number) {
    this.noDialog()
    const h = await this.cdp("Page.getNavigationHistory")
    const current = num(h.currentIndex)
    const entries = Array.isArray(h.entries) ? h.entries : []
    const entry: unknown = current === null ? undefined : entries[current + step]
    if (!isJson(entry)) {
      throw new Error(
        `There's no page ${step < 0 ? "before this one" : "after this one"} in this tab's history`,
      )
    }
    const since = Date.now()
    await this.cdp("Page.navigateToHistoryEntry", { entryId: entry.id })
    this.s.world = null
    await this.settle(since)
  }
}

/** The session's tab, with its gate held, for `work`. */
export const withTab = async <A>(
  name: string,
  group: string | null,
  work: (tab: Tab) => Promise<A>,
): Promise<A> => {
  const s = session(name)
  return await s.locked(async () => {
    if (group !== null && group.trim() !== "") {
      s.group = group.trim()
    }
    return await work(new Tab(s))
  })
}
