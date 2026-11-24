// A tool call as a step a person can read: "Searched Google for “costco orders”", "Ran `ls ~/code`
// on studio", "Read `Views/List.swift`", each with its icon. Known tools get their own wording;
// an app's tool reads from its verb and its first argument; anything else falls back to its name.
// Old Switchboard's steps (mac/src/ui/steps.rs), its icons and words, for the tools a turn calls
// now.
import { rec, str } from "./json.ts"

/** A piece of a step's wording: words, or a command, path, query or address shown as code. */
export interface Part {
  readonly text: string
  readonly code?: true
}

/** A step's icon, as old Switchboard drew it (ui/step-icons.tsx). */
export type StepIcon =
  | "terminal-window"
  | "file-text"
  | "note-pencil"
  | "folder-open"
  | "paper-plane-tilt"
  | "camera"
  | "eye"
  | "globe"
  | "cursor-click"
  | "gear"
  | "robot"
  | "lightning"
  | "arrow-elbow-down-right"
  | "wrench"
  | "tray"
  | "magnifying-glass"
  | "database"
  | "book-open"
  | "notebook"
  | "squares-four"
  | "chat-text"
  | "list-checks"
  | "brain"
  | "stop"
  | "bell"

/** A step: its icon and its words. */
export interface Step {
  readonly icon: StepIcon
  readonly parts: readonly Part[]
}

type Input = Record<string, unknown>

const words = (text: string): Part => ({ text })

const step = (icon: StepIcon, parts: readonly Part[]): Step => ({ icon, parts })

/** One line of at most `max` characters, home folders as `~`. */
const short = (value: string, max: number) => {
  const line = value
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replaceAll(/\/Users\/[^/\s]+/gu, "~")
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const code = (value: string): Part => ({ text: short(value, 90), code: true })

/** A file as a step names it: its folder and its name (`~/code/app/Views/List.swift` is
 * `Views/List.swift`); a short path stays whole. */
const file = (path: string): Part => {
  const parts = path.trim().replace(/\/+$/u, "").split("/")
  return parts.length > 2 ? code(parts.slice(-2).join("/")) : code(path)
}

/** Quoted words, cut to `max`. */
const quoted = (value: string, max = 100) => `“${short(value, max)}”`

/** The first of `keys` the input has as words. */
const field = (input: Input, ...keys: string[]) => {
  for (const key of keys) {
    const v = str(input[key]).trim()
    if (v !== "") {
      return v
    }
  }
  return ""
}

/** A web address as a person says it: its host, and its path when there's one. */
const site = (url: string) => {
  try {
    const u = new URL(url)
    const host = u.host.replace(/^www\./u, "")
    return u.pathname === "/" ? host : `${host}${u.pathname}`
  } catch {
    return url
  }
}

/** An app's name as a person says it: "uber-courier" is "Uber courier". */
const named = (app: string) => {
  const spaced = app.replaceAll(/[-_]/gu, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The longest of `apps` that `name` starts with, then one of `after`. */
const appIn = (name: string, apps: readonly string[], ...after: string[]) => {
  const [longest] = apps
    .filter((a) => after.some((c) => name.startsWith(`${a}${c}`)))
    .toSorted((a, b) => b.length - a.length)
  return longest
}

/** Where a tool ran: an app, and the machine its instance is on ("macos-studio" is macos on
 * studio) when `apps` knows the app. */
interface At {
  readonly app: string
  readonly machine: string
}

const atOf = (instance: string, apps: readonly string[]): At => {
  const app = appIn(instance, apps, "-")
  return app === undefined
    ? { app: instance, machine: "" }
    : { app, machine: instance.slice(app.length + 1) }
}

const on = (at: At): Part[] => (at.machine === "" ? [] : [words(` on ${at.machine}`)])

const target = (s: Input) => field(s, "match", "text", "selector", "label")

/** A browser step (`op`), with what it acted on; `null` when it says nothing. */
const BROWSER: Record<string, (s: Input) => Step | null> = {
  open: (s) =>
    field(s, "url") === "" ? null : step("globe", [words("Opened "), code(site(field(s, "url")))]),
  click: (s) =>
    target(s) === "" ? null : step("cursor-click", [words(`Clicked ${quoted(target(s), 60)}`)]),
  fill: (s) =>
    step("cursor-click", [
      words(target(s) === "" ? "Filled in a field" : `Filled in ${quoted(target(s), 60)}`),
    ]),
  read: () => step("globe", [words("Read the page")]),
  js: () => step("terminal-window", [words("Ran a script on the page")]),
  screenshot: () => step("camera", [words("Took a screenshot")]),
}
const BROWSER_ALSO: Record<string, string> = {
  goto: "open",
  navigate: "open",
  type: "fill",
  text: "read",
  snapshot: "read",
  eval: "js",
  shot: "screenshot",
}

/** What an app's verb did, given its input. */
type Verb = (input: Input, at: At) => Step

const searched: Verb = (input, at) => {
  const query = field(input, "query", "q", "text", "term", "pattern", "search")
  const app = named(at.app)
  return step("magnifying-glass", [
    words(query === "" ? `Searched ${app}` : `Searched ${app} for ${quoted(query)}`),
    ...on(at),
  ])
}
const ran: Verb = (input, at) => {
  const argv = Array.isArray(input.argv) ? input.argv.map(str).join(" ") : ""
  const command = field(input, "command", "cmd") || argv
  return step("terminal-window", [
    words("Ran "),
    command === "" ? words("a command") : code(command),
    ...on(at),
  ])
}
const readIt: Verb = (input, at) => {
  const path = field(input, "path", "file_path", "file")
  return step(
    "file-text",
    path === "" ? [words(`Read ${named(at.app)}`)] : [words("Read "), file(path), ...on(at)],
  )
}
const listed: Verb = (input, at) => {
  const path = field(input, "path")
  const what = path === "" ? [words(`Listed ${named(at.app)}`)] : [words("Listed "), code(path)]
  return step("folder-open", [...what, ...on(at)])
}
const checked: Verb = (_input, at) => step("eye", [words(`Checked ${named(at.app)}`), ...on(at)])
const pictured: Verb = (_input, at) =>
  step("camera", [words(`Took a picture with ${named(at.app)}`), ...on(at)])

const VERBS: Record<string, Verb> = {
  exec: ran,
  run: ran,
  shell: ran,
  search: searched,
  find: searched,
  lookup: searched,
  query: searched,
  read: readIt,
  read_file: readIt,
  write_file: (input, at) =>
    step("note-pencil", [
      words("Wrote "),
      file(field(input, "path", "file_path") || "a file"),
      ...on(at),
    ]),
  list: listed,
  list_files: listed,
  transfer_file: (input) =>
    step("paper-plane-tilt", [
      words("Sent "),
      code(field(input, "path") || "a file"),
      words(` to ${field(input, "to") || "another Mac"}`),
    ]),
  open: (input, at) => {
    const url = field(input, "url", "link")
    return step("globe", [
      words("Opened "),
      url === "" ? words(named(at.app)) : code(site(url)),
      ...on(at),
    ])
  },
  ui: (input, at) =>
    step("cursor-click", [words(`Drove ${field(input, "app") || "the app in front"}`), ...on(at)]),
  moment: (_input, at) =>
    step("eye", [
      words(`Looked at what you had open${at.machine === "" ? "" : ` on ${at.machine}`}`),
    ]),
  screenshot: pictured,
  shot: pictured,
  snap: pictured,
  camera: pictured,
  status: checked,
  health: checked,
  check: checked,
  state: checked,
  get_state: checked,
}

/** Verbs whose step is the verb done to the app, or to what it was given. */
const PAST: Record<string, string> = {
  install: "Installed",
  update: "Updated",
  remove: "Removed",
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  send: "Sent",
  print: "Printed",
  order: "Ordered",
  cancel: "Cancelled",
  approve: "Approved",
  merge: "Merged",
  deploy: "Deployed",
  render: "Rendered",
  slice: "Sliced",
  label: "Labeled",
  book: "Booked",
  quote: "Got a quote from",
  checkout: "Checked out on",
  call: "Called",
  notify: "Notified",
  connect: "Connected",
  disconnect: "Disconnected",
  show: "Showed",
}

/** Verbs that run an app itself: old Switchboard's appendage's own icon. */
const RUNS = new Set(["install", "update", "remove", "start", "stop", "restart"])

/** A browser-like action's first step (`op`, or the first of its `steps`), and how many more. */
const browsed = (verb: string, input: Input, at: At): Step | null => {
  const steps = Array.isArray(input.steps) ? input.steps.map(rec) : []
  const [first = input] = steps
  const op = field(input, "op", "action") || str(first.op)
  if (op === "" || op === verb) {
    return null
  }
  const done = BROWSER[BROWSER_ALSO[op] ?? op]?.(first)
  if (!done) {
    return null
  }
  const more = steps.length > 1 ? [words(` and ${steps.length - 1} more`)] : []
  return step(done.icon, [...done.parts, ...more, ...on(at)])
}

/** An app's action by its verb, with what it was given. `null` when the verb says nothing known. */
const action = (verb: string, input: Input, at: At): Step | null => {
  const browser = browsed(verb, input, at)
  if (browser) {
    return browser
  }
  const known = VERBS[verb]
  if (known) {
    return known(input, at)
  }
  const past = PAST[verb]
  if (past === undefined) {
    return null
  }
  const what = field(input, "query", "title", "name", "id")
  const app = named(at.app)
  return step(RUNS.has(verb) ? "robot" : "lightning", [
    words(`${past} ${what === "" ? app : `${app} ${quoted(what, 60)}`}`),
    ...on(at),
  ])
}

/** A tool nobody wrote wording for: its name, and its first argument. */
const fallback = (name: string, input: Input, at?: At): Step => {
  const first = Object.values(input).find((v) => typeof v === "string" && v.trim() !== "")
  return step("lightning", [
    words(named(name.trim())),
    ...(typeof first === "string" ? [words(" "), code(first)] : []),
    ...(at ? on(at) : []),
  ])
}

const gist = (input: Input, max = 100) =>
  short(field(input, "text", "what", "lesson", "title", "summary"), max)

/** A space as a tool was given it, by id or name. */
const spaceIn = (input: Input, key = "space") => quoted(field(input, key) || "a space", 40)

/** How an ask's step leads, by its kind. */
const ASKED: Record<string, string> = {
  approval: "Asked for your approval: ",
  task: "Asked you to ",
}

/** A tapback as iMessage says it: "Loved your message"; none takes one back. */
const TAPBACK: Record<string, string> = {
  love: "Loved",
  like: "Liked",
  dislike: "Disliked",
  laugh: "Laughed at",
  emphasize: "Emphasized",
  question: "Questioned",
}

/** An extension as a tool was given it, as code. */
const extensionIn = (input: Input) => code(field(input, "extension", "source", "name") || "?")

/**
 * Switch's own apps' tools (the gateway's), by name: old Switchboard's wording where it had the tool
 * (its brain tool's say, ask, follow, dismiss), else the same way: what it did, past tense, with what
 * it was given. `output` is what came back, where it names the step.
 */
const OWN: Record<string, (input: Input, output: string) => Step> = {
  brain_query: (i) =>
    step("database", [words(`Looked through the brain's ${field(i, "from") || "events"}`)]),
  brain_post: (i) =>
    step("chat-text", [words(`Said in ${field(i, "space") || "a space"}: ${gist(i, 80)}`)]),
  brain_react: (i) => {
    const tapback = TAPBACK[field(i, "reaction")]
    const emoji = field(i, "emoji")
    if (emoji !== "") {
      return step("chat-text", [words(`Reacted ${emoji} to your message`)])
    }
    return step("chat-text", [
      words(tapback === undefined ? "Took back a reaction" : `${tapback} your message`),
    ])
  },
  brain_user: () => step("book-open", [words("Read who you are")]),
  brain_describe_user: () => step("note-pencil", [words("Updated who you are")]),
  brain_spaces: () => step("squares-four", [words("Listed the spaces")]),
  brain_create_space: (i) =>
    step("squares-four", [words(`Made the space ${quoted(field(i, "name"), 40)}`)]),
  brain_rename_space: (i) =>
    step("squares-four", [words(`Renamed ${spaceIn(i)} to ${quoted(field(i, "name"), 40)}`)]),
  brain_move_space: (i) =>
    step("squares-four", [
      words(
        field(i, "parent") === ""
          ? `Moved ${spaceIn(i)} to the top`
          : `Moved ${spaceIn(i)} into ${spaceIn(i, "parent")}`,
      ),
    ]),
  brain_archive_space: (i) =>
    step("squares-four", [
      words(i.undo === true ? `Opened ${spaceIn(i)} again` : `Archived ${spaceIn(i)}`),
    ]),
  brain_move_exchange: (i) => step("squares-four", [words(`Moved an exchange to ${spaceIn(i)}`)]),
  brain_widgets: () => step("squares-four", [words("Listed the widgets")]),
  brain_show_widget: (i) =>
    step("squares-four", [
      words(
        `Showed ${field(i, "title") ? quoted(field(i, "title"), 40) : named(field(i, "app") || "a widget")}`,
      ),
    ]),
  brain_preview_html: () => step("squares-four", [words("Previewed a page")]),
  brain_publish: (i) =>
    step("squares-four", [
      words(
        i.retired === true
          ? "Took down a page"
          : `Published ${field(i, "title") ? quoted(field(i, "title"), 40) : "a page"}`,
      ),
    ]),
  brain_pages: () => step("squares-four", [words("Listed the pages")]),
  brain_place_widget: (i) =>
    step("squares-four", [words(`Placed ${named(field(i, "app") || "a widget")}`)]),
  brain_remove_widget: (i) =>
    step("squares-four", [words(`Took down ${named(field(i, "app") || "a widget")}`)]),
  brain_folder: (i) =>
    step(
      "folder-open",
      field(i, "path") === ""
        ? [words(`Cleared the folder of ${spaceIn(i)}`)]
        : [words(`Set the folder of ${spaceIn(i)} to `), code(field(i, "path"))],
    ),
  brain_folders: () => step("folder-open", [words("Listed the folders")]),
  autonomy_say: (i, output) =>
    step("chat-text", [
      words(
        `${/"said":\s*false/u.test(output) ? "Didn't repeat: " : "Said: "}${short(field(i, "text"), 120)}`,
      ),
    ]),
  autonomy_nothing: (i) =>
    step("chat-text", [
      words(
        field(i, "note") === "" ? "Said nothing" : `Said nothing: ${short(field(i, "note"), 120)}`,
      ),
    ]),
  autonomy_expect: (i) =>
    step("eye", [
      words(`${i.drop === true ? "Stopped expecting" : "Will look again"}: ${gist(i)}`),
    ]),
  autonomy_wait: () => step("eye", [words("Waited")]),
  autonomy_surprise: (i) =>
    step("lightning", [words(i.dismiss === true ? "Took down a surprise" : `Flagged: ${gist(i)}`)]),
  autonomy_remember: (i) => step("brain", [words(`Remembered: ${gist(i)}`)]),
  autonomy_action_item: (i) => {
    const asked = gist(i, 140) || short(field(rec(i.ask), "title"), 140)
    return step("tray", [words(`${ASKED[field(i, "kind")] ?? "Asked you: "}${asked}`)])
  },
  autonomy_close_item: (i) =>
    step("tray", [
      words(
        `${field(i, "status") === "done" ? "Closed an ask" : "Dismissed an ask"}${field(i, "why") === "" ? "" : `: ${short(field(i, "why"), 120)}`}`,
      ),
    ]),
  autonomy_follow_item: (i) =>
    step("eye", [
      words(i.follow === false ? "Stopped waiting on an ask" : "Waiting on an item in your queue"),
    ]),
  autonomy_wake_rule: (i) =>
    step("eye", [
      words(i.retired === true ? "Retired the wake rule " : "Set the wake rule "),
      code(field(i, "name") || "?"),
    ]),
  autonomy_setting: (i) =>
    field(i, "key") === ""
      ? step("gear", [words("Read the dials")])
      : step("gear", [
          words("Set "),
          code(field(i, "key")),
          words(` to ${typeof i.value === "number" ? String(i.value) : quoted(str(i.value), 40)}`),
        ]),
  autonomy_cover: (i) =>
    step("camera", [
      words(`${field(i, "image") === "" ? "Cleared" : "Set"} the cover of ${spaceIn(i)}`),
    ]),
  autonomy_image: (i) => step("camera", [words(`Drew ${quoted(field(i, "prompt"), 40)}`)]),
  inbox_inbox: () => step("tray", [words("Read the inbox")]),
  inbox_thread: (i) =>
    step("chat-text", [
      words(
        field(i, "with") === ""
          ? "Read a conversation"
          : `Read the conversation with ${quoted(field(i, "with"), 40)}`,
      ),
    ]),
  iphone_notify: (i) =>
    step("bell", [words(`Notified your iPhone: ${short(field(i, "title", "body"), 80)}`)]),
  iphone_live_activity_start: (i) =>
    step("bell", [words(`Started a Live Activity: ${quoted(field(i, "title"), 60)}`)]),
  iphone_live_activity_update: (i) =>
    step("bell", [
      words(
        field(i, "title") === ""
          ? "Updated a Live Activity"
          : `Updated a Live Activity: ${quoted(field(i, "title"), 60)}`,
      ),
    ]),
  iphone_live_activity_end: () => step("bell", [words("Ended a Live Activity")]),
  iphone_wallet_issue_pass: (i) =>
    step("paper-plane-tilt", [words(`Issued a Wallet pass: ${quoted(field(i, "title"), 60)}`)]),
  iphone_wallet_bundle: (i) =>
    step("paper-plane-tilt", [
      words(`Bundled ${Array.isArray(i.serials) ? i.serials.length : "the"} Wallet passes`),
    ]),
  iphone_wallet_check: (i) =>
    step("eye", [words("Checked the Wallet pass "), file(field(i, "pass") || "?")]),
  iphone_wallet_check_link: (i) =>
    step("eye", [words("Checked the Wallet passes at "), code(site(field(i, "link") || "?"))]),
  desktop_screenshot: () => step("camera", [words("Took a screenshot of Switchboard")]),
  desktop_notify: (i) =>
    step("bell", [words(`Notified your Mac: ${short(field(i, "title", "body"), 80)}`)]),
  skills_read: (i) => step("book-open", [words(`Read the ${field(i, "name") || "a"} skill`)]),
  extensions_list: () => step("robot", [words("Listed the extensions")]),
  extensions_install: (i) =>
    step("robot", [
      words("Installed the extension "),
      extensionIn(i),
      ...(field(i, "machine") === "" ? [] : [words(` on ${field(i, "machine")}`)]),
    ]),
  extensions_update: (i) => step("robot", [words("Updated the extension "), extensionIn(i)]),
  extensions_remove: (i) => step("robot", [words("Removed the extension "), extensionIn(i)]),
  extensions_place: (i) =>
    step("robot", [
      words("Moved the extension "),
      extensionIn(i),
      words(` to ${field(i, "machine") || "another machine"}`),
    ]),
  accounts_list: () => step("gear", [words("Listed the accounts")]),
  accounts_add: (i) =>
    step("gear", [words(`Added a ${field(i, "provider") || "provider"} account`)]),
  accounts_sign_in: (i) =>
    step("gear", [words("Started signing in "), code(field(i, "id") || "an account")]),
  accounts_remove: (i) =>
    step("gear", [words("Removed the account "), code(field(i, "id") || "?")]),
  connections_list: () => step("gear", [words("Listed the connections")]),
  connections_request: (i) =>
    step("gear", [
      words(`Asked to connect ${field(i, "kind", "provider", "name") || "an account"}`),
    ]),
  connections_save: (i) =>
    step("gear", [
      words(`Saved a ${field(i, "provider") || "provider"} key from `),
      file(field(i, "file") || "a file"),
    ]),
  connections_connect: (i) =>
    step("gear", [words(`Opened ${field(i, "provider") || "a provider"}'s sign-in`)]),
  connections_recover: (i) =>
    step("gear", [words(`Refreshed the ${field(i, "provider") || "provider"} connection`)]),
  connections_verify: (i) =>
    step("gear", [words(`Checked the ${field(i, "provider") || "provider"} sign-in`)]),
  connections_readiness: (i) =>
    step("gear", [words(`Checked how ${field(i, "provider") || "a provider"} connects`)]),
  connections_client: (i) =>
    step("gear", [words(`Kept the ${field(i, "provider") || "provider"} OAuth client`)]),
  connections_disconnect: () => step("gear", [words("Disconnected an account")]),
}

/** A string field from pretty-printed JSON that may be cut short, `depth` levels in (0 is the
 * record itself, 1 its body): old Switchboard's `json_text`. */
const jsonText = (text: string, key: string, depth: number) => {
  const needle = `\n${"  ".repeat(depth + 1)}"${key}": "`
  const at = text.indexOf(needle)
  if (at === -1) {
    return ""
  }
  let value = ""
  let escaped = false
  for (const c of text.slice(at + needle.length)) {
    if (escaped) {
      value += c
      escaped = false
    } else if (c === "\\") {
      escaped = true
    } else if (c === '"') {
      return value
    } else {
      value += c
    }
  }
  return ""
}

/** What a record read back is called: its kind and its title or gist. */
const readBack = (output: string) => {
  const kind = jsonText(output, "kind", 0)
  const name = ["title", "summary", "statement", "text"]
    .map((key) => jsonText(output, key, 1))
    .find((v) => v !== "")
  if (kind !== "" && name !== undefined) {
    return `Read the ${kind} ${quoted(name, 80)}`
  }
  return kind === "" ? "Read a record" : `Read a ${kind}`
}

/** What was done to something to look at: taken down, changed, published or made. */
const made = (i: Input) => {
  if (i.retired === true) {
    return "Took down"
  }
  if (i.id !== undefined) {
    return "Updated"
  }
  return i.link === true ? "Published" : "Made"
}

/** Old Switchboard's brain tool, by its op; `output` is what came back, where it names the step. */
const LEGACY: Record<string, (input: Input, output: string) => Step> = {
  task: (i) =>
    i.work === undefined
      ? step("wrench", [words(`Started: ${short(field(i, "title") || "a task", 120)}`)])
      : step("arrow-elbow-down-right", [words(`Steered a task: ${short(field(i, "text"), 120)}`)]),
  ask: (i) => {
    const [first = ""] = field(i, "text").split("\n")
    return step("tray", [words(`${ASKED[field(i, "type")] ?? "Asked you: "}${short(first, 140)}`)])
  },
  follow: (i) =>
    step("eye", [
      words(
        field(i, "text") === ""
          ? "Waiting on an item in your queue"
          : `Waiting on your queue: ${short(field(i, "text"), 120)}`,
      ),
    ]),
  dismiss: (i) =>
    step("tray", [
      words(
        `${i.entirely === true ? "Dismissed an ask: " : "Stopped waiting on an ask: "}${short(field(i, "why"), 120)}`,
      ),
    ]),
  report: (i) => step("file-text", [words(`Reported: ${short(field(i, "takeaway"), 120)}`)]),
  say: (i, output) =>
    step("chat-text", [
      words(
        `${output.startsWith("Not said") ? "Didn't repeat: " : "Said: "}${short(field(i, "text"), 120)}`,
      ),
    ]),
  object: (i, output) => {
    const title = field(i, "title") || (output.split('"')[1] ?? "")
    const what = title === "" ? "an object" : quoted(title, 100)
    return step("squares-four", [words(`${made(i)} ${what}`)])
  },
  search: (i) =>
    step("magnifying-glass", [words("Searched the brain for "), code(field(i, "text"))]),
  query: (i) => step("database", [words("Queried "), code(field(i, "query"))]),
  recent: (i) =>
    step("book-open", [words("Read the latest in "), code(field(i, "stream") || "a stream")]),
  read: (i, output) => {
    const id = field(i, "id")
    if (id.startsWith("work/")) {
      return step("book-open", [words("Read a work")])
    }
    if (id.includes(":")) {
      return step("book-open", [words("Looked up "), code(id)])
    }
    return step("book-open", [words(readBack(output))])
  },
  zoom: () => step("book-open", [words("Opened a summary")]),
  expect: (i) =>
    i.retired === true
      ? fallback("brain", i)
      : step("eye", [words(`Will look again: ${short(field(i, "statement"), 100)}`)]),
  wait: () => step("eye", [words("Waited")]),
  record: (i) => {
    const body = rec(i.body)
    const kind = field(i, "kind")
    if (kind === "observation") {
      return step("notebook", [
        words(`Noted: ${short(field(body, "summary", "entity") || "something", 120)}`),
      ])
    }
    if (kind === "note") {
      return step("notebook", [words(`Noted: ${short(field(body, "text") || "something", 120)}`)])
    }
    return step("notebook", [
      words(`Recorded a ${kind || "record"} in `),
      code(field(i, "stream") || "the brain"),
    ])
  },
  request: (i) => {
    const [app = "", machine = ""] = field(i, "target").split("@")
    const at = app === "macos" ? { app: machine, machine: "" } : { app, machine }
    const verb = field(i, "action")
    const args = rec(i.args)
    return action(verb, args, at) ?? fallback(verb, args, at)
  },
}

const ranShell = (i: Input) => {
  const said = field(i, "description")
  return step(
    "terminal-window",
    said === ""
      ? [words("Ran "), code(field(i, "command", "cmd") || "a command")]
      : [words(short(said, 140))],
  )
}
const pathOf = (i: Input) => field(i, "file_path", "path", "notebook_path") || "a file"
const edited = (i: Input) => step("note-pencil", [words("Edited "), file(pathOf(i))])
const plan = (i: Input) => {
  const doing = Array.isArray(i.todos)
    ? i.todos.map(rec).find((t) => t.status === "in_progress")
    : undefined
  return step("list-checks", [
    words(doing ? short(str(doing.activeForm) || str(doing.content), 120) : "Updated the plan"),
  ])
}
const helper = (i: Input) =>
  step("robot", [words(`Asked a helper to ${short(field(i, "description") || "help", 120)}`)])
const toolsFor = (i: Input) =>
  step("magnifying-glass", [words(`Looked for tools: ${short(field(i, "query"), 80)}`)])

/** The agent's own tools: Claude Code's, Codex's, the gateway's. */
const AGENT: Record<string, (input: Input) => Step> = {
  Bash: ranShell,
  exec_command: ranShell,
  shell: ranShell,
  run_shell_command: ranShell,
  Read: (i) => step("file-text", [words("Read "), file(pathOf(i))]),
  Write: (i) => step("note-pencil", [words("Wrote "), file(pathOf(i))]),
  Edit: edited,
  MultiEdit: edited,
  NotebookEdit: edited,
  Glob: (i) =>
    step("folder-open", [words("Found files matching "), code(field(i, "pattern") || "*")]),
  Grep: (i) => step("magnifying-glass", [words("Searched for "), code(field(i, "pattern"))]),
  LS: (i) => step("folder-open", [words("Listed "), code(field(i, "path") || ".")]),
  WebSearch: (i) => step("globe", [words(`Searched the web for ${quoted(field(i, "query"))}`)]),
  WebFetch: (i) => step("globe", [words("Read "), code(site(field(i, "url") || "a page"))]),
  TodoWrite: plan,
  Task: helper,
  Agent: helper,
  ToolSearch: toolsFor,
  search_tools: toolsFor,
  delegate_task: (i) =>
    step("wrench", [words(`Started: ${short(field(i, "title", "task"), 120)}`)]),
  task_steer: (i) =>
    step("arrow-elbow-down-right", [words(`Steered a task: ${short(field(i, "text"), 120)}`)]),
  task_status: () => step("eye", [words("Checked on a task")]),
  task_cancel: () => step("stop", [words("Stopped a task")]),
  task_stage: (i) => step("list-checks", [words(`Stage: ${short(field(i, "stage"), 40)}`)]),
  Skill: (i) => step("book-open", [words(`Read the ${field(i, "skill", "name") || "a"} skill`)]),
}

/** An app's tool, `<app>_<verb>` (the app's instance may name its machine). */
const appTool = (tool: string, input: Input, apps: readonly string[], output: string) => {
  const known = OWN[tool]
  if (known) {
    return known(input, output)
  }
  const app = appIn(tool, apps, "_", "-")
  const cut = app === undefined ? tool.indexOf("_") : tool.indexOf("_", app.length)
  if (cut <= 0) {
    return fallback(tool, input)
  }
  const at = atOf(tool.slice(0, cut), apps)
  const verb = tool.slice(cut + 1)
  return action(verb, input, at) ?? fallback(`${at.app} ${verb}`, input, at)
}

/**
 * A tool call, as a step. `name` is the tool as the host recorded it: the agent's own, the
 * gateway's (`mcp__<server>__<tool>`, an app's through `call_tool`), or old Switchboard's
 * (`brain`, `<appendage>__<action>`). `apps` are the installed apps' names, to tell an app from
 * the machine its instance runs on. `output`, what came back, names a few of old Switchboard's.
 */
export const describe = (
  name: string,
  input: unknown,
  apps: readonly string[],
  output = "",
): Step => {
  const given = rec(input)
  if (name.startsWith("mcp__")) {
    const tool = name.split("__").slice(2).join("__")
    if (tool === "call_tool") {
      return appTool(field(given, "name"), rec(given.arguments), apps, output)
    }
    return AGENT[tool]?.(given) ?? appTool(tool, given, apps, output)
  }
  if (name === "brain") {
    return LEGACY[field(given, "op")]?.(given, output) ?? fallback("brain", given)
  }
  const agent = AGENT[name]
  if (agent) {
    return agent(given)
  }
  const [instance = "", act] = name.split("__")
  if (act !== undefined) {
    const at = atOf(instance, apps)
    return action(act, given, at) ?? fallback(act, given, at)
  }
  return fallback(name, given)
}

/** A step's words, as one line. */
export const stepText = (s: Step) => s.parts.map((p) => p.text).join("")

/** `macos-studio__exec` is "exec · macos-studio": an app's action reads action first. */
export const toolLabel = (name: string) => {
  const [app = "", act] = name.split("__")
  return act === undefined ? name : `${act} · ${app}`
}
