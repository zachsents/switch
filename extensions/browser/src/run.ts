// `run`: a routine goal, driven step by step by the user's decision model (the profile's browse
// role). Each step the model reads the page as a numbered outline and picks one action and one
// element in a single call. No language model writes anything: text to type comes from the
// caller's facts, and the caller reads the page itself for answers. The same call judges whether the
// step would commit something (send, submit, buy, post, delete); unless the caller says the user
// asked for exactly that, the run stops before it, holds the tab, and hands back the one call that
// does that step, for an approval. Secret fields are never typed into. Ported from Switchboard's
// run.rs, itself grown from Agent Quick Browse.
import type { ModelAnswer } from "switch-ext-kit"

import type { Json } from "./chrome.ts"
import { isJson } from "./chrome.ts"
import { redactUrl, secretText } from "./guard.ts"
import { done, hold, str } from "./common.ts"
import type { Decide, Done } from "./common.ts"
import { attachFiles, realFile } from "./ops.ts"
import { describe, line, loosely, parseKey } from "./tab.ts"
import type { Element, Snapshot, Tab } from "./tab.ts"

const ACTIONS: Record<string, string> = {
  click:
    "Click the numbered element that best advances the goal (link, button, tab, checkbox, result, etc.).",
  type: "Type one of the provided facts into a numbered text field / search box, or pick an option in a numbered dropdown. Only if that field doesn't already hold the right value.",
  upload:
    "Attach one of the provided files using the numbered file upload field, upload button, or drop zone.",
  hover:
    "Hover the mouse over the numbered element (a row, card, or menu) to reveal controls or a menu that only appear on hover.",
  press_escape:
    "Press Escape to close a popup, suggestion list, menu, or dialog that is in the way (do not click buttons to dismiss it).",
  press_enter:
    "Press Enter to submit text that was just typed (e.g. a search box with no visible submit button).",
  wait: "Wait a couple of seconds because something is still loading or processing (an upload in progress, a spinner, results not shown yet).",
  scroll_down: "Scroll down because what is needed is not visible yet.",
  scroll_up: "Scroll back up because what is needed is above the current view.",
  go_back: "Go back to the previous page because this page is a dead end.",
  done: "The goal is fully accomplished, or the information that answers it is visible on screen right now.",
  blocked:
    "Stuck: login wall, CAPTCHA, paywall, an error page, or the goal needs information we don't have. Also choose this if the same action keeps repeating without progress.",
}

const LOOK =
  "You are operating a web browser to achieve the goal. The page is given as a text outline with interactive elements numbered [n]. Elements marked (above/below …) are off-screen but can be clicked or typed into directly — no need to scroll to them. What is the single best next action?"

const COMMITS =
  "Would the next action, the one that best advances the goal, commit something outside this browser that can't simply be taken back: send a message or email, submit an order, application or form, post or publish, buy or pay, book, delete, or change account settings? Navigating, searching, filtering, sorting, opening things, filling in fields, saving a draft and closing popups don't count."

const NO_TEXT = "no text was provided to type here"

type Step = { readonly note: string | null } | { readonly blocked: string }

interface End {
  readonly status: "done" | "blocked" | "max_steps" | "needs_approval"
  readonly reason: string | null
  readonly pending: { readonly step: string; readonly call: Json } | null
}

const end = (status: End["status"], reason: string | null = null): End => ({
  status,
  reason,
  pending: null,
})

const needsTarget = (action: string) => ["click", "type", "hover", "upload"].includes(action)

const confidence = (a: ModelAnswer | undefined) => (a ? (a.probabilities[a.choice] ?? 0) : 0)

/** Text quoted in the goal, as facts for goals given none, so the model can search for it. */
const quoted = (goal: string) =>
  Object.fromEntries(
    [...goal.matchAll(/["“](?<text>[^"”]{2,200})["”]/gu)].map((m, i) => [
      `quoted_text_${i + 1}`,
      m.groups?.text ?? "",
    ]),
  )

/**
 * The same action three times in the last six steps: straight repeats and back-and-forth loops
 * alike. A scroll counts only when it ended up in the same place: scrolling that gets nowhere.
 */
const looping = (history: readonly string[], summary: string) => {
  const recent = history.slice(-6)
  if (summary.startsWith("scroll_")) {
    const last = history.at(-1)
    return last !== undefined && recent.filter((e) => e === last).length >= 3
  }
  return recent.filter((e) => e === summary || e.startsWith(`${summary} -> `)).length >= 3
}

/** File names attached so far, from the upload notes in the history. */
const attachedSoFar = (history: readonly string[]) => [
  ...new Set(
    history.flatMap((e) => {
      const name = /-> (?:already )?attached (?<name>.+?)(?: to \[|$)/u.exec(e)?.groups?.name
      return name === undefined ? [] : [name]
    }),
  ),
]

/** The page as the model reads it, tried again when a snapshot lands mid-navigation. */
const look = async (tab: Tab): Promise<Snapshot> => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await tab.snapshot(254, false, true)
    } catch (error) {
      if (tries >= 3) {
        throw error
      }
      await tab.settle(Date.now())
    }
  }
}

/** The step a run stopped before, and the one `act` call that does just it. */
const pending = async (tab: Tab, action: string, t: Element | undefined, snapshot: Snapshot) => {
  if (action === "click" && t !== undefined) {
    const l = line(t)
    const index = snapshot.elements.filter((e) => line(e) === l).findIndex((e) => e.n === t.n)
    const call: Json = { op: "click", session: tab.name, match: l, ...(index > 0 && { index }) }
    return { step: `click ${describe(t)}`, call }
  }
  // Enter in a field: the call clicks back into the field, then presses Enter.
  const field = await tab.pageJson("field(null)").catch((): Json => ({}))
  const fl = str(field.line)
  const focused = fl.includes("] ") ? fl.slice(fl.indexOf("] ") + 2) : fl
  const steps =
    focused === ""
      ? [{ op: "key", keys: "Enter" }]
      : [
          { op: "click", match: focused },
          { op: "key", keys: "Enter" },
        ]
  return {
    step: `press Enter in ${fl === "" ? "the page" : fl}`,
    call: { session: tab.name, steps },
  }
}

class Run {
  readonly history: string[] = []
  readonly log: string[] = []

  readonly goal: string
  readonly facts: Readonly<Record<string, string>>
  readonly files: Readonly<Record<string, string>>
  readonly keystrokes: boolean
  readonly approved: boolean
  readonly decide: Decide

  constructor(given: {
    readonly goal: string
    readonly facts: Readonly<Record<string, string>>
    readonly files: Readonly<Record<string, string>>
    readonly keystrokes: boolean
    readonly approved: boolean
    readonly decide: Decide
  }) {
    this.goal = given.goal
    this.facts = given.facts
    this.files = given.files
    this.keystrokes = given.keystrokes
    this.approved = given.approved
    this.decide = given.decide
  }

  private async ask(
    state: Json,
    questions: Record<
      string,
      { instructions: string; choices: { value: string; description?: string }[] }
    >,
  ) {
    const decision = await this.decide({ stable: LOOK, item: JSON.stringify(state) }, questions)
    return decision.answers
  }

  async steps(tab: Tab, maxSteps: number): Promise<End> {
    for (let step = 1; step <= maxSteps; step += 1) {
      const started = Date.now()
      const snapshot = await look(tab)
      const answers = await this.questions(snapshot, step, maxSteps)
      const action = answers.action?.choice ?? ""
      if (!(action in ACTIONS)) {
        throw new Error(`The decision model picked an unknown action "${action}"`)
      }
      const chosen = answers.target?.choice
      const t =
        chosen === undefined
          ? snapshot.elements[0]
          : snapshot.elements.find((e) => `e${e.n}` === chosen)
      const summary = t !== undefined && needsTarget(action) ? `${action} ${describe(t)}` : action
      const targetConfidence =
        answers.target !== undefined && needsTarget(action)
          ? `, target ${confidence(answers.target).toFixed(2)}`
          : ""
      this.log.push(
        `${step}. ${summary} (action ${confidence(answers.action).toFixed(2)}${targetConfidence}, ${Date.now() - started}ms)`,
      )
      if (action === "done") {
        return end("done")
      }
      if (action === "blocked") {
        return end(
          "blocked",
          "the decision model judged it stuck (a login wall, a CAPTCHA, an error, or something it needs)",
        )
      }
      if (
        !this.approved &&
        answers.commits?.choice === "yes" &&
        (action === "click" || action === "press_enter")
      ) {
        return {
          status: "needs_approval",
          reason: null,
          pending: await pending(tab, action, t, snapshot),
        }
      }
      const acted = Date.now()
      try {
        const r = await this.perform(tab, action, t)
        if ("blocked" in r) {
          return end("blocked", r.blocked)
        }
        this.history.push(r.note === null ? summary : `${summary} -> ${r.note}`)
        if (looping(this.history, summary)) {
          return end("blocked", `repeated "${summary}" without getting anywhere`)
        }
      } catch (error) {
        // A failed action goes back to the model, so it can pick something else next step.
        const message =
          (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? ""
        this.log.push(`   ! ${message}`)
        this.history.push(`${summary} -> FAILED: ${message}`)
        if (looping(this.history, summary)) {
          return end(
            "blocked",
            `repeated "${summary}" without getting anywhere (last error: ${message})`,
          )
        }
      }
      await tab.settle(acted)
    }
    return end("max_steps")
  }

  private filesLeft() {
    const attached = attachedSoFar(this.history)
    return Object.entries(this.files).filter(
      ([, p]) => !attached.some((name) => p.endsWith(`/${name}`)),
    )
  }

  /** One step's questions: which action, on which element, and whether it commits. */
  private async questions(snapshot: Snapshot, step: number, maxSteps: number) {
    const hasSelect = snapshot.elements.some((e) => e.tag === "select")
    const hasFacts = Object.keys(this.facts).length > 0
    const hasFiles = Object.keys(this.files).length > 0
    const state: Json = {
      goal: this.goal,
      url: redactUrl(snapshot.url),
      title: snapshot.title,
      step: `${step} of ${maxSteps}`,
      previous_actions: this.history.length === 0 ? "none yet" : this.history.slice(-10),
      page: snapshot.outline,
    }
    if (hasFacts) {
      state.facts = this.facts
    }
    if (hasFiles) {
      const left = this.filesLeft()
      state.uploads =
        left.length === 0
          ? `All provided files are attached (${attachedSoFar(this.history).join(", ")}); no uploads left to do`
          : {
              files_to_upload: left.map(([name]) => name),
              already_attached: attachedSoFar(this.history),
            }
    }
    // Without facts there's nothing to type (but dropdown choices), and without files nothing to upload.
    const nothing = snapshot.elements.length === 0
    const offered = Object.entries(ACTIONS)
      .filter(
        ([name]) =>
          !(name === "type" && !hasFacts && !hasSelect) && !(name === "upload" && !hasFiles),
      )
      .filter(([name]) => !(nothing && needsTarget(name)))
      .map(([value, description]) => ({ value, description }))
    const questions: Record<
      string,
      { instructions: string; choices: { value: string; description?: string }[] }
    > = {
      action: { instructions: LOOK, choices: offered },
    }
    if (snapshot.elements.length >= 2) {
      questions.target = {
        instructions:
          "If the next action is a click, typing, upload, or hover, which numbered element should it act on? Pick the one that most directly advances the goal.",
        choices: snapshot.elements.map((e) => ({ value: `e${e.n}`, description: describe(e) })),
      }
    }
    if (!this.approved) {
      questions.commits = { instructions: COMMITS, choices: [{ value: "yes" }, { value: "no" }] }
    }
    return await this.ask(state, questions)
  }

  /** Does one step. A thrown error goes back to the model; `blocked` ends the run. */
  private async perform(tab: Tab, action: string, t: Element | undefined): Promise<Step> {
    const need = (what: string) => {
      if (t === undefined) {
        throw new Error(`No element to ${what}`)
      }
      return t
    }
    switch (action) {
      case "click": {
        const e = need("click")
        // A native dropdown or file input opens a popup the debugger can't operate.
        if (e.tag === "select") {
          return await this.chooseOption(tab, e)
        }
        if (e.role === "file upload") {
          return await this.upload(tab, e)
        }
        await tab.clickAt(await tab.point(e.n))
        return { note: null }
      }
      case "upload": {
        return await this.upload(tab, need("upload to"))
      }
      case "type": {
        const e = need("type into")
        if (e.sensitive !== null) {
          return {
            blocked: `${describe(e)} is a ${e.sensitive} field, which you never fill: sign_in or autofill fills it`,
          }
        }
        if (e.tag === "select") {
          return await this.chooseOption(tab, e)
        }
        if (e.role === "file upload") {
          return await this.upload(tab, e)
        }
        if (!e.editable) {
          // A dropdown-style widget opens with a click; anything else fails so the model picks again.
          if (!["combobox", "listbox", "spinbutton"].includes(e.role)) {
            const why = ["input", "textarea"].includes(e.tag)
              ? "is read-only: set it with the page's own picker or list options instead"
              : "is not a text field"
            throw new Error(`[${e.n}] ${why}; pick the field to type into`)
          }
          await tab.clickAt(await tab.point(e.n))
          return { note: "opened the dropdown" }
        }
        const fact = await this.chooseFact(e)
        if ("blocked" in fact) {
          return fact
        }
        const holds = await tab.page(`value(${e.n}, ${tab.known(e.n)})`).catch(() => null)
        if (typeof holds === "string" && loosely(holds) === loosely(fact.text)) {
          throw new Error(`[${e.n}] already holds ${fact.name}; go on with the rest of the goal`)
        }
        await tab.fill(e.n, fact.text, false, this.keystrokes)
        return { note: `typed ${fact.name}` }
      }
      case "hover": {
        await tab.glide(await tab.point(need("hover").n))
        return { note: null }
      }
      case "press_enter":
      case "press_escape": {
        await tab.press(parseKey(action === "press_enter" ? "Enter" : "Escape"))
        return { note: null }
      }
      case "wait": {
        await Bun.sleep(2000)
        return { note: null }
      }
      case "scroll_down":
      case "scroll_up": {
        const { width, height } = await tab.viewport()
        const center = { x: width / 2, y: height / 2 }
        const pointer = tab.s.pointer ?? center
        const here =
          (await tab.page(`canScrollAt(${pointer.x}, ${pointer.y})`).catch(() => false)) === true
        await tab.wheel(
          here ? pointer : center,
          0,
          action === "scroll_down" ? height * 0.8 : -height * 0.8,
        )
        const at = await tab.pageJson("position()")
        return { note: `at y=${String(at.y)} of ${String(at.height)}px` }
      }
      case "go_back": {
        await tab.history(-1)
        return { note: null }
      }
      default: {
        throw new Error(`No action ${action}`)
      }
    }
  }

  /** Picks a dropdown option with the model, since that's a pure decision. */
  private async chooseOption(tab: Tab, e: Element): Promise<Step> {
    const raw = await tab.page(`options(${e.n}, ${tab.known(e.n)})`)
    const options = (Array.isArray(raw) ? raw : [])
      .filter((o) => typeof o === "string")
      .slice(0, 255)
    if (options.length < 2) {
      throw new Error("The dropdown has fewer than 2 options")
    }
    const answers = await this.ask(
      { goal: this.goal, facts: this.facts, dropdown: describe(e) },
      {
        option: {
          instructions: "Which dropdown option should be selected to achieve the goal?",
          choices: options.map((value) => ({ value })),
        },
      },
    )
    const option = answers.option?.choice
    if (option === undefined) {
      throw new Error("The decision model picked no option")
    }
    await tab.page(`set(${e.n}, ${tab.known(e.n)}, ${JSON.stringify(option)})`)
    return { note: `selected "${option}"` }
  }

  /**
   * Which fact goes in a field. With none that fits, the first try fails like any action (the goal
   * may be reachable by clicking instead); the second stops the run, so the caller can supply it.
   */
  private async chooseFact(
    field: Element,
  ): Promise<{ name: string; text: string } | { blocked: string }> {
    const needs = () => {
      if (this.history.some((e) => e.includes(NO_TEXT))) {
        return {
          blocked: `needs text for ${describe(field)}: pass it in facts, or type it with act`,
        }
      }
      throw new Error(`${NO_TEXT}; reach the goal another way (e.g. by clicking)`)
    }
    const entries = Object.entries(this.facts)
    if (entries.length === 0) {
      return needs()
    }
    // One fact leaves nothing to choose, until it's been typed somewhere.
    const [only, ...more] = entries
    if (only && more.length === 0 && !this.history.some((e) => e.endsWith(`-> typed ${only[0]}`))) {
      return { name: only[0], text: only[1] }
    }
    const answers = await this.ask(
      { goal: this.goal, field: describe(field), previous_actions: this.history.slice(-5) },
      {
        fact: {
          instructions: "Which of these values should be typed into the field to achieve the goal?",
          choices: [
            ...entries.map(([name, value]) => ({
              value: name,
              description: `${name}: type "${value}"`,
            })),
            { value: "__none__", description: "None of these values belongs in this field" },
          ],
        },
      },
    )
    const picked = entries.find(([name]) => name === answers.fact?.choice)
    return picked ? { name: picked[0], text: picked[1] } : needs()
  }

  /** Attaches the file the model picks for an upload field, without a file picker. */
  private async upload(tab: Tab, e: Element): Promise<Step> {
    if (Object.keys(this.files).length === 0) {
      return {
        blocked: `needs a file for ${describe(e)}: pass it in files, or attach it with act's upload`,
      }
    }
    const left = this.filesLeft()
    if (left.length === 0) {
      return {
        note: `nothing left to upload (already attached: ${attachedSoFar(this.history).join(", ")})`,
      }
    }
    let file = left[0]?.[1] ?? ""
    if (left.length > 1) {
      const answers = await this.ask(
        { goal: this.goal, upload_field: describe(e), previous_actions: this.history.slice(-5) },
        {
          file: {
            instructions: "Which of these files should be uploaded here to achieve the goal?",
            choices: [
              ...left.map(([name, p]) => ({
                value: name,
                description: `${name}: ${p.split("/").at(-1) ?? p}`,
              })),
              { value: "__none__", description: "None of these files belongs in this field" },
            ],
          },
        },
      )
      const picked = left.find(([name]) => name === answers.file?.choice)
      if (!picked) {
        return { blocked: `none of the files fits ${describe(e)}` }
      }
      ;[, file] = picked
    }
    const said = await attachFiles(tab, e.n, [file])
    const name = file.split("/").at(-1) ?? file
    return { note: said.startsWith("already") ? `already attached ${name}` : `attached ${name}` }
  }
}

const pairs = (v: unknown) =>
  Object.fromEntries(
    Object.entries(isJson(v) ? v : {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  )

/** A routine goal, run to its end; says where the tab ended up and the steps it took. */
export const run = async (tab: Tab, args: Json, decide: Decide): Promise<Done> => {
  const goal = str(args.goal).trim()
  if (goal === "") {
    throw new Error("run needs a goal")
  }
  let facts = pairs(args.facts)
  for (const [name, value] of Object.entries(facts)) {
    const why = secretText(value)
    if (why !== null) {
      throw new Error(`The fact "${name}" reads as ${why}, and you never type those`)
    }
  }
  if (Object.keys(facts).length === 0) {
    facts = quoted(goal)
  }
  const files = Object.fromEntries(
    await Promise.all(
      Object.entries(pairs(args.files)).map(async ([n, p]) => [n, await realFile(p)] as const),
    ),
  )
  const maxSteps = Math.min(
    Math.max(typeof args.max_steps === "number" ? args.max_steps : 12, 1),
    40,
  )
  const r = new Run({
    goal,
    facts,
    files,
    keystrokes: args.keystrokes === true,
    approved: args.approved === true,
    decide,
  })
  const started = Date.now()
  await tab.ensure()
  if (typeof args.url === "string") {
    await tab.navigate(args.url)
  }
  const ended = await r.steps(tab, maxSteps)
  const { url, title } = await tab.info().catch(() => ({ url: "", title: "" }))
  const seen = str(await tab.page("inView(1500)").catch(() => ""))
  const n = r.history.length
  let text = `${ended.status} after ${n} step${n === 1 ? "" : "s"} in ${((Date.now() - started) / 1000).toFixed(1)}s${ended.reason === null ? "" : `: ${ended.reason}`}\nNow on: ${title === "" ? "(untitled)" : title} — ${redactUrl(url)}\n`
  if (ended.pending !== null) {
    await hold(tab.name, Date.now() + 24 * 3_600_000).catch(() => null)
    text += `Stopped before: ${ended.pending.step}. The decision model judged it would commit something, and the tab stays open for a day. If the user asked for exactly this, run again with approved: true; otherwise ask the user for approval, and on it call act with:\n${JSON.stringify(ended.pending.call)}\n`
  }
  if (r.log.length > 0) {
    text += `Steps:\n${r.log.join("\n")}\n`
  }
  if (seen.trim() !== "") {
    text += `In view:\n${seen}`
  }
  return done(text)
}
