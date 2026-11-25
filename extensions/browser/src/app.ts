// The browser extension: this Mac's own browser (Chrome, or another Chromium browser), signed in as the
// user is there, driven through its Chrome extension and the browser's debugger in background tabs,
// grouped and collapsed out of the way. `run` hands a routine goal to the user's decision model;
// `act` is exact control; `secret` lists and keeps the vault's secrets fill_secret puts in fields; the tab widget shows the
// tab held for the user, which they drive from it; `browser.page` says what's in front. Ported from
// Switchboard's browser appendage.
import { hostname } from "node:os"

import { Effect, Queue, Schema } from "effect"
import { AppEvents, answer, defineApp, defineEvent, mcpApp, Models, tool } from "switch-ext-kit"
import type { WidgetDef, ModelsService, AsksService } from "switch-ext-kit"

import { challengeTools } from "./challenge.ts"
import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { redact, redactUrl } from "./guard.ts"
import * as secrets from "./secrets.ts"
import { newestHeld } from "./session.ts"
import { parseKey, withTab } from "./tab.ts"
import { tabHtml } from "./view/build.ts"
import { act, OPS } from "./ops.ts"
import { askedField, consented, guard, marked } from "./personal.ts"
import type { Decide, Done } from "./common.ts"
import * as portal from "./portal.ts"
import { run } from "./run.ts"
import type { Tab } from "./tab.ts"

const APP = "browser"
const DEFAULT_SESSION = "browser"
const machine = process.env.SWITCH_MACHINE ?? hostname().split(".")[0] ?? "mac"

/** What's in front in this Mac's browser: the user looking at a page, or an agent's tab. */
export const PageEvent = defineEvent(
  "browser.page",
  1,
  Schema.Struct({
    machine: Schema.String,
    url: Schema.String,
    title: Schema.String,
    /** An agent is driving it. */
    agent: Schema.Boolean,
    /** None of the browser's windows is in front. */
    hidden: Schema.Boolean,
  }),
)

/** Whether this sense works: the bridge to the browser's extension, `chrome.bridge`. */
export const Heartbeat = defineEvent(
  "browser.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.String,
    summary: Schema.String,
    facts: Schema.Struct({
      failing: Schema.NullOr(Schema.String),
      machine: Schema.String,
      browser: Schema.NullOr(Schema.String),
      connected: Schema.Boolean,
      open: Schema.Boolean,
      tabs: Schema.optionalKey(Schema.Finite),
    }),
  }),
)

const LOOK_MS = 60_000
const BEAT_MS = 5 * 60_000

const summaryOf = (b: chrome.Bridge) => {
  if (b.failing !== null) {
    return b.failing
  }
  return b.connected && b.browser !== null ? `In ${b.browser}` : "No browser open"
}

/**
 * Emits each change of what's in front, as the extension says it, and the heartbeat: the bridge
 * looked at each minute, a beat every five and at once when what's failing changes. Both come from
 * this one loop, so the beat stops if it does.
 */
export const watch = Effect.gen(function* watching() {
  const events = yield* AppEvents
  const pages = yield* Queue.unbounded<chrome.Page>()
  chrome.onPage((page) => {
    Queue.offerUnsafe(pages, page)
  })
  let last = ""
  let lookedAt = 0
  let sent: string | null = null
  let sentAt = 0
  for (;;) {
    const page = yield* Effect.timeoutOption(Queue.take(pages), LOOK_MS)
    if (page._tag === "Some") {
      const payload = { machine, ...page.value, url: redactUrl(page.value.url) }
      const key = JSON.stringify(payload)
      if (key !== last) {
        last = key
        yield* Effect.ignore(events.emit({ type: PageEvent.type, payload }))
      }
    }
    if (Date.now() - lookedAt >= LOOK_MS) {
      lookedAt = Date.now()
      const b = yield* Effect.promise(chrome.bridge)
      if (sentAt === 0 || b.failing !== sent || Date.now() - sentAt >= BEAT_MS) {
        sent = b.failing
        sentAt = Date.now()
        const facts = { ...b, machine }
        const beat = { entity: "sense:browser", summary: summaryOf(b), facts }
        yield* Effect.ignore(events.emit(Heartbeat.make(beat)))
      }
    }
  }
})

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const output = (d: Done) =>
  answer({ text: redact(d.text) }, [
    { type: "text", text: redact(d.text) },
    ...d.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: "image/jpeg" })),
  ])

/** Runs `work` on the named session's tab, once the extension is there. */
const onTab = (args: Json, work: (tab: Tab) => Promise<Done>) =>
  task(async () => {
    guard(args)
    await chrome.reach()
    if (consented(args)) {
      await chrome.call("consent", {}, 10_000)
    }
    const name =
      typeof args.session === "string" && args.session !== "" ? args.session : DEFAULT_SESSION
    const group = typeof args.group === "string" ? args.group : null
    return output(await withTab(name, group, work))
  })

/** The user's decision model, as the profile's browse role runs it. */
const decider = Effect.gen(function* deciding() {
  const models = yield* Models
  const decide: Decide = async (input, questions) =>
    await Effect.runPromise(models.decide(input, questions, "browse"))
  return decide
})

const optionalString = Schema.optionalKey(Schema.String)
const optionalNumber = Schema.optionalKey(Schema.Finite)
const optionalBoolean = Schema.optionalKey(Schema.Boolean)
const strings = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const runTool = tool(
  "run",
  {
    description: marked(
      "Do a routine web task in the user's own browser on this Mac, signed in as they are there, with a fast decision model (about half a second a step): navigating, searching, following links, filling forms, multi-step clicking. Give one objective on one site with explicit steps (name exact link and button text when you know it), every string to type in facts, and files to upload in files. It works in a background tab (the session's, shared with act, so check and finish with act). It returns where the tab ended up and the steps it took, not an answer: status done (the model's belief, so check), blocked with why, max_steps, or needs_approval when the next step would commit something (send, submit, buy, post, delete): it stops there and gives the act call that does just that step, unless approved says the user asked for exactly this. Use act for fiddly widgets, judgment calls, reading, and anything visual. Never give it passwords, payment or identity numbers: it refuses them (act's sign_in signs in from the browser's saved passwords).",
    ),
    input: Schema.Struct({
      goal: Schema.String,
      url: optionalString,
      facts: strings,
      files: strings,
      max_steps: optionalNumber,
      approved: optionalBoolean,
      keystrokes: optionalBoolean,
      session: optionalString,
      group: optionalString,
      ...askedField,
    }),
  },
  (input) =>
    Effect.gen(function* running() {
      const decide = yield* decider
      return yield* onTab(input, async (tab) => await run(tab, input, decide))
    }),
)

const actTool = tool(
  "act",
  {
    description: marked(
      `Exact control of a tab in the user's own browser on this Mac, signed in as they are there, in the background (a collapsed tab group; their own tabs and focus are left alone). Each session is one tab that lasts between calls. Ops: look (the page as an outline with numbered elements; view: screenshot for an annotated screenshot), find {text} (elements by words, else by meaning), click {element | match | x, y; button, count, modifiers}, type {text, element?, submit?, append?} (replaces a field's text and checks it), set {element, value} (a dropdown option, a checkbox, a date), sign_in {account?, otp?, submit?} (fills a sign-in page after page, pressing Next or Enter after each, and nothing secret passes through you: account names a login in the user's vault (accounts lists them), whose username, password and authenticator code it fills, on its own sites only; without account, the vault's one login for the site if it has one; else the browser fills it from its saved passwords, account then being words from the saved sign-in, like its username; a page asking again is reported, never retried; otp puts in a one-time code from an email or text), save_account {account, username?, sites?, password?: generate | page | a file's path, totp?: page | a file's path, element | match, length?} (keeps a login in the user's vault: generate has the vault make a strong password and fills the page's new-password fields, the old one staying in its history; page reads a password or two-factor key an element shows, never into your context), accounts {account?, forget?} (the vault's logins: usernames and sites, never secrets; forget moves one to its trash), fill_secret {secret; element | match | x, y; format?, slice?} (one of the vault's secrets by reference, like card/main.number, into the field straight from the vault, in the background, a text box inside another site's frame too (a card form's secure boxes: the frame's element, or a point in it): the secret tool lists them; format shapes it, each # its next letter or digit, like ##/##; slice [start, end] is the part one box of a split field takes), autofill {element | match | x, y; pick?} (the browser fills the field from what it has saved, a card's number, expiry and code at once: without pick it lists what it offers; pick is words from one, like a card's last four digits), key {keys: "Escape", "cmd+a", "Tab Tab Enter"}, hover, scroll {direction?, amount?, element | x, y}, drag {element | x, y, to}, screenshot {element? region? marks?}, text (the page's words), value {element, save_to?}, wait {text | gone | seconds}, navigate {url}, back, forward, reload, js {code} (JavaScript in the page; the last expression's value comes back), upload {element, paths}, dialog {accept, text?}, console, network {match? body?}, tabs, attach {tab: an id from tabs, or "front"}, show (brings the tab to the front of the screen), hold {hours?} (keeps it open for an approval), release {keep?}. steps (op steps, or steps alone): a list of ops run in order, stopping at the first that fails. Numbers stay with their element. match is text (or /regex/) in an element's line, like button "Send". Every op says where the tab is after it. sign_in and autofill bring the tab to the front for a few seconds. Never type passwords, payment or identity numbers (refused). A committal click (send, submit, buy, post, delete) is the user's unless they asked for exactly that: hold the tab and ask for approval first.`,
    ),
    input: Schema.Struct({
      op: Schema.optionalKey(Schema.Literals([...OPS, "steps"])),
      steps: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      session: optionalString,
      group: optionalString,
      element: optionalNumber,
      match: optionalString,
      index: optionalNumber,
      x: optionalNumber,
      y: optionalNumber,
      to: Schema.optionalKey(Schema.Unknown),
      url: optionalString,
      text: optionalString,
      submit: optionalBoolean,
      append: optionalBoolean,
      keystrokes: optionalBoolean,
      value: Schema.optionalKey(Schema.Unknown),
      pick: optionalString,
      account: optionalString,
      otp: optionalString,
      backgroundOnly: optionalBoolean,
      keys: optionalString,
      repeat: optionalNumber,
      button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
      count: optionalNumber,
      modifiers: optionalString,
      direction: Schema.optionalKey(Schema.Literals(["down", "up", "left", "right"])),
      amount: optionalNumber,
      view: Schema.optionalKey(Schema.Literals(["text", "screenshot"])),
      region: Schema.optionalKey(Schema.Array(Schema.Finite)),
      marks: optionalBoolean,
      scale: optionalNumber,
      code: optionalString,
      seconds: optionalNumber,
      gone: optionalBoolean,
      timeout: optionalNumber,
      paths: Schema.optionalKey(Schema.Array(Schema.String)),
      accept: optionalBoolean,
      body: optionalString,
      errors: optionalBoolean,
      clear: optionalBoolean,
      tab: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
      keep: optionalBoolean,
      hours: optionalNumber,
      save_to: optionalString,
      secret: optionalString,
      format: optionalString,
      slice: Schema.optionalKey(Schema.Array(Schema.Finite)),
      username: optionalString,
      sites: Schema.optionalKey(Schema.Array(Schema.String)),
      password: optionalString,
      totp: optionalString,
      length: optionalNumber,
      forget: optionalBoolean,
      ...askedField,
    }),
  },
  (input) =>
    Effect.gen(function* acting() {
      const decide = yield* decider
      return yield* onTab(input, async (tab) => await act(tab, input, decide))
    }),
)

const secretTool = tool(
  "secret",
  {
    description:
      "The user's secrets for forms in their vault (card numbers and codes, identity and bank numbers), which act's fill_secret puts straight into a field: list (names and what they hold, never a secret), import {card, name, label?} (keeps a card the browser has saved, its words like its last four digits, in the vault as name.number, .cvc, .month, .year, .expiry and .holder; it brings a tab to the front for a few seconds), forget {name} (moves it to the vault's trash).",
    input: Schema.Struct({
      op: Schema.Literals(["list", "import", "forget"]),
      card: optionalString,
      name: optionalString,
      label: optionalString,
      ...askedField,
    }),
  },
  (input) =>
    task(async () => {
      if (input.op === "import") {
        guard(input)
        if (input.card === undefined || input.name === undefined) {
          throw new Error(
            "import needs card (words from the card's line in the browser's suggestions) and name (like card/main)",
          )
        }
        return await secrets.importCard(input.card, input.name, input.label ?? null)
      }
      if (input.op === "forget") {
        const gone = await secrets.forget(input.name ?? "")
        return `Forgot ${gone.join(", ")}.`
      }
      const all = await secrets.list()
      return all.length === 0
        ? "The vault keeps no secrets for forms. import keeps a card the browser has saved."
        : all
            .map(
              (o) =>
                `- ${o.name}: ${o.title} (${o.kind}; ${o.fields
                  .filter((f) => f.set === true)
                  .map((f) => `${o.name}.${f.id}`)
                  .join(", ")})${o.urls.length > 0 ? `, only on ${o.urls.join(", ")}` : ""}`,
            )
            .join("\n")
    }),
)

/** The session a view shows: the one asked for, else the newest held for the user. */
const shown = (session: string | undefined) => {
  const name = session ?? newestHeld()
  if (name === null || name === "") {
    throw new Error("Nothing held")
  }
  return name
}

const viewTool = tool(
  "view",
  {
    description: "The tab held for the user, now: its picture, for the tab widget.",
    readOnly: true,
    appOnly: true,
    input: Schema.Struct({ session: optionalString }),
  },
  (input) =>
    task(async () => {
      const name = shown(input.session)
      await chrome.reach()
      return await withTab(name, null, async (tab) => {
        await tab.ensure()
        const [{ url, title }, shot] = await Promise.all([tab.info(), tab.screenshot(null, 1)])
        return answer(
          {
            session: name,
            url: redactUrl(url),
            title,
            width: shot.width,
            height: shot.height,
            mimeType: "image/jpeg",
            data: shot.data,
          },
          [{ type: "image", data: shot.data, mimeType: "image/jpeg" }],
        )
      })
    }),
)

const inputTool = tool(
  "input",
  {
    description:
      "The user's own input to the tab the widget shows: a click, a scroll, typing or a key. What's typed is kept nowhere.",
    appOnly: true,
    input: Schema.Struct({
      session: Schema.String,
      kind: Schema.Literals(["click", "scroll", "type", "key"]),
      x: optionalNumber,
      y: optionalNumber,
      dy: optionalNumber,
      text: optionalString,
      keys: optionalString,
    }),
  },
  (input) =>
    task(async () => {
      await chrome.reach()
      await withTab(input.session, null, async (tab) => {
        const at = { x: input.x ?? 0, y: input.y ?? 0 }
        if (input.kind === "click") {
          await tab.clickAt(at)
        } else if (input.kind === "scroll") {
          const { width, height } = await tab.viewport()
          await tab.wheel(
            input.x === undefined ? { x: width / 2, y: height / 2 } : at,
            0,
            input.dy ?? 0,
          )
        } else if (input.kind === "type") {
          await tab.insert(input.text ?? "")
        } else {
          await tab.press(parseKey(input.keys ?? "Enter"))
        }
      })
      return { ok: true }
    }),
)

const portalTool = tool(
  "portal",
  {
    description:
      "An ask's live view of this Mac's screen, for the core to relay to the user's apps: open (watch to show it, control to drive it, with the session's tab brought to the front first) or close a view.",
    appOnly: true,
    input: Schema.Struct({
      op: Schema.Literals(["open", "close"]),
      session: optionalString,
      scope: Schema.optionalKey(Schema.Literals(["watch", "control"])),
      grant: optionalString,
    }),
  },
  (input) =>
    task(async () => {
      if (input.op === "close") {
        await portal.close(input.grant ?? "")
        return { closed: true }
      }
      return { ...(await portal.open(input.session ?? DEFAULT_SESSION, input.scope ?? "watch")) }
    }),
)

// Built when the extension starts: Bun runs no macros from an installed package.
const html = tabHtml(APP)

const tabWidget: WidgetDef = {
  name: "tab",
  title: "Tab",
  surfaces: ["chat", "space"],
  resource: `ui://${APP}/tab`,
  size: {
    aspect: "wide",
    ratio: 16 / 10,
    min: { cols: 2, rows: 2 },
    preferred: { cols: 6, rows: 4 },
    grows: true,
  },
  a2ui: () =>
    mcpApp("tab", {
      title: "Tab",
      html,
      toolInput: "/input",
      allowedTools: [`${APP}_view`, `${APP}_input`],
    }),
}

export const browserApp = defineApp<ModelsService | AsksService>({
  name: APP,
  version: "3",
  instructions:
    'The user\'s own browser on this Mac, signed in as they are there, in background tabs. run does routine web tasks with a decision model; act is exact control: its sign_in signs in from a login in the user\'s vault or the browser\'s saved passwords, and fill_secret puts a vault secret in a field. When the step left is the user\'s own in a tab (a CAPTCHA or other human check, which you never solve; a sign-in only they can finish; a passkey), fill everything else, hold the tab (act\'s hold), and put up an action item with a live view: portal {"app": "browser", "session": "<session>"}. Its card shows this Mac\'s screen live in both apps, their iPhone included, wherever they are; opening it brings that tab to the front, and they click, drag, scroll and type in it. A notification about it opens it. Add a resolve_when that finds the page past the check when you can. Nothing in it is kept. Release sessions when done.',
  tools: [runTool, actTool, secretTool, viewTool, inputTool, portalTool, ...challengeTools],
  events: [PageEvent, Heartbeat],
  widgets: [tabWidget],
})
