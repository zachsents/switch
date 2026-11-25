// The Mac as the agent's body, ported from Switchboard's sb-macos: commands, files, vitals,
// attention, the moment, screenshots and driving any app's interface, plus the upkeep that was
// grown beside it (strays from proc-sweep, protected folders from tcc-guard, whose load from
// load-owners). One runs on every Mac, as `macos-<machine>`. Accessibility, Screen Recording and
// Full Disk Access are the host app's, which this runs under.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import type { Stats } from "node:fs"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"

import {
  AppEvents,
  answer,
  defineApp,
  defineEvent,
  MCP_CATALOG,
  surface,
  tool,
} from "switch-ext-kit"
import { decode } from "./barcodes.ts"
import { capture, hands } from "./hands.ts"
import * as vault from "./vault.ts"
import { load, noteDisk } from "./load.ts"
import { thisMac } from "./look.ts"
import { askedField, guard, guardExec, marked } from "./personal.ts"
import { beat, Heartbeat, kept, said, watch as watched } from "./health.ts"
import { check, grants } from "./protected.ts"
import * as strays from "./strays.ts"
import { Device, deviceLooked, moreTools, watchDevice } from "./more.ts"
import * as procs from "./procs.ts"
import { diskEvents, diskLooked, diskTool, makeRoomTool, watchDisk } from "./upkeep.ts"
import { picture } from "./picture.ts"
import { ratio, vitalsPage } from "./vitals-widget/page.ts"
import { alerting, alerts, notable, read, reading } from "./vitals.ts"
import type { Reading } from "./vitals.ts"

export const machine = process.env.SWITCH_MACHINE ?? hostname().split(".")[0] ?? "mac"
const dir = process.cwd()
const OFF = path.join(dir, "attention-off")
const RULES = path.join(dir, "strays.json")

// Events, versioned.

export const Vitals = defineEvent("macos.vitals", 1, reading)

export const Attention = defineEvent(
  "macos.attention",
  1,
  Schema.Struct({
    machine: Schema.String,
    /** Following what's in front; off, only whether the user is here. */
    tracking: Schema.Boolean,
    /** Input in the last two minutes, and the screen open. */
    active: Schema.Boolean,
    locked: Schema.Boolean,
    app: Schema.optionalKey(Schema.String),
    bundle: Schema.optionalKey(Schema.String),
    window: Schema.optionalKey(Schema.String),
  }),
)

export const Permissions = defineEvent(
  "macos.permissions",
  1,
  Schema.Struct({
    machine: Schema.String,
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
    fullDiskAccess: Schema.Boolean,
  }),
)

export const StraysStopped = defineEvent(
  "macos.strays_stopped",
  1,
  Schema.Struct({
    machine: Schema.String,
    stopped: Schema.Array(
      Schema.Struct({ pid: Schema.Finite, kind: Schema.String, what: Schema.String }),
    ),
  }),
)

// Plain async work as a tool's effect: its error's message is what went wrong.
const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

const expand = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

// Attention: what's in front, kept as it changes.

const IDLE_S = 120
const HISTORY = 20
const OWN_INPUT_MS = 1000
const CHROMIUM = new Set([
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.google.Chrome.beta",
  "org.chromium.Chromium",
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi",
])
/** Switch's own window, by its app's name (a dev build is "Switch-dev"). */
const isSwitch = (app: string) => app === "Switch" || app.startsWith("Switch-")

interface Glance {
  readonly app: string
  readonly bundle: string
  readonly pid: number
  readonly window?: string
  readonly at: number
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : 0)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {}

let current: Glance | null = null
const history: Glance[] = []
let posted = 0
let person: number | null = null

/** Seconds since the user's last input, not counting keys this extension posted for the agent. */
const idleOf = (idle: number) => {
  const latest = Date.now() - idle * 1000
  const own = posted > 0 && Math.abs(latest - posted) <= OWN_INPUT_MS
  const at = own ? (person ?? 0) : latest
  person = at
  return Math.max(0, (Date.now() - at) / 1000)
}

const glance = async () => {
  const g = obj(await hands("glance"))
  const bundle = str(g.bundle)
  // A browser's window title is its tab's, which may be a private one: only its app is known.
  const window = CHROMIUM.has(bundle) ? undefined : str(g.window) || undefined
  const seen: Glance = {
    app: str(g.app),
    bundle,
    pid: num(g.pid),
    ...(window === undefined ? {} : { window }),
    at: Date.now(),
  }
  return {
    seen,
    idle: idleOf(num(g.idle)),
    locked: g.locked === true,
    trusted: g.trusted === true,
  }
}

const tracking = () => !existsSync(OFF)

const strip = ({ pid: _, ...g }: Glance) => g

const samePlace = (a: Glance | null, b: Glance) =>
  a !== null && a.bundle === b.bundle && a.window === b.window

const attentionLooked = watched("attention", 60_000, 5)

const watchAttention = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let last = ""
  let lastAt = 0
  for (;;) {
    yield* Effect.sleep("2 seconds")
    const looked = yield* Effect.result(task(glance))
    yield* attentionLooked(looked._tag === "Failure" ? said(looked.failure) : null)
    if (looked._tag === "Failure") {
      continue
    }
    const { seen, idle, locked } = looked.success
    const on = tracking()
    const active = idle < IDLE_S && !locked
    if (on && !samePlace(current, seen)) {
      history.push(seen)
      history.splice(0, Math.max(0, history.length - HISTORY))
    }
    current = on ? seen : null
    const payload = {
      machine,
      tracking: on,
      active,
      locked,
      ...(on && seen.app !== "" ? { app: seen.app, bundle: seen.bundle } : {}),
      ...(on && seen.window !== undefined ? { window: seen.window } : {}),
    }
    const key = JSON.stringify(payload)
    // Presence and the lock count at once; titles that tick, once per five seconds.
    if (key === last || (!stateChanged(last, payload) && Date.now() - lastAt < 5000)) {
      continue
    }
    last = key
    lastAt = Date.now()
    yield* events.emit(Attention.make(payload)).pipe(Effect.ignore)
  }
})

const stateChanged = (
  was: string,
  now: { readonly tracking: boolean; readonly active: boolean; readonly locked: boolean },
) => {
  const parsed = obj(was === "" ? null : JSON.parse(was))
  return (
    parsed.tracking !== now.tracking || parsed.active !== now.active || parsed.locked !== now.locked
  )
}

// Vitals: read every minute, an event every five or when something worth a glance changes. Its
// widget's page is made as the extension starts: Bun runs no macros from an installed package.

const mac = await thisMac()
const page = vitalsPage(mac.name, picture(mac.look), mac.battery)

let latest: Reading | null = null

const vitalsLooked = watched("vitals", 5 * 60_000, 2)

const watchVitals = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let sent: Reading | null = null
  let sentAt = 0
  for (;;) {
    const r = yield* Effect.result(task(async () => await read(machine)))
    yield* vitalsLooked(r._tag === "Failure" ? said(r.failure) : null)
    if (r._tag === "Success") {
      latest = r.success
      noteDisk(r.success.diskFreeGb)
      if (notable(sent, r.success) || Date.now() - sentAt >= 300_000) {
        sent = r.success
        sentAt = Date.now()
        yield* events.emit(Vitals.make(r.success)).pipe(Effect.ignore)
      }
    }
    // This Mac's heartbeat goes from here: it stops if this watch does.
    yield* beat
    yield* Effect.sleep("1 minute")
  }
})

// Permissions, as they change.

const access = async () => {
  const a = obj(await hands("access"))
  return {
    machine,
    accessibility: a.accessibility === true,
    screenRecording: a.screenRecording === true,
    fullDiskAccess: grants().fullDiskAccess === true,
  }
}

const permissionsLooked = watched("permissions", 16 * 60_000)

const watchPermissions = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let last = ""
  for (;;) {
    const a = yield* Effect.result(task(access))
    yield* permissionsLooked(a._tag === "Failure" ? said(a.failure) : null)
    if (a._tag === "Success" && JSON.stringify(a.success) !== last) {
      last = JSON.stringify(a.success)
      yield* events.emit(Permissions.make(a.success)).pipe(Effect.ignore)
    }
    yield* Effect.sleep("5 minutes")
  }
})

// Strays, swept every five minutes.

/** Works still going on: running, waiting on a watch or script of their own, or to be carried on. */
const GOING = new Set(["running", "waiting", "limited", "interrupted"])

/**
 * Which of these works go on, from the brain's work list (its query tool, as a widget calls it); null
 * when the core can't say.
 */
const live: strays.Live = async (works) => {
  try {
    const core = process.env.SWITCH_URL ?? "http://127.0.0.1:4871"
    const r = await fetch(`${core}/widgets/brain/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.SWITCH_TOKEN !== undefined && {
          authorization: `Bearer ${process.env.SWITCH_TOKEN}`,
        }),
      },
      body: JSON.stringify({
        from: "work",
        where: [{ field: "thread", op: "in", value: works }],
        fields: ["thread", "status"],
        limit: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body: unknown = await r.json()
    const rows = Schema.decodeUnknownOption(WorkRows)(body)
    if (!r.ok || rows._tag === "None" || rows.value.isError === true) {
      return null
    }
    return new Set(
      rows.value.structuredContent.rows.filter((w) => GOING.has(w.status)).map((w) => w.thread),
    )
  } catch {
    return null
  }
}

const WorkRows = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.Struct({
    rows: Schema.Array(Schema.Struct({ thread: Schema.String, status: Schema.String })),
  }),
})

const sweep = async () => {
  const found = await strays.look(RULES, live)
  const unread = found.filter((s) => s.unread !== undefined)
  const stopped = await strays.stop(found.filter((s) => s.stopInS === 0))
  return {
    stopped,
    unread:
      unread.length === 0 ? null : `${unread.length} unread, kept: ${unread[0]?.unread ?? ""}`,
  }
}

const straysLooked = watched("strays", 16 * 60_000)

const watchStrays = Effect.gen(function* watching() {
  const events = yield* AppEvents
  for (;;) {
    yield* Effect.sleep("5 minutes")
    const swept = yield* Effect.result(task(sweep))
    yield* straysLooked(swept._tag === "Failure" ? said(swept.failure) : swept.success.unread)
    if (swept._tag === "Success" && swept.success.stopped.length > 0) {
      const list = swept.success.stopped.map((s) => ({ pid: s.pid, kind: s.kind, what: s.what }))
      yield* events.emit(StraysStopped.make({ machine, stopped: list })).pipe(Effect.ignore)
    }
  }
})

/** What this extension does on its own while it runs; one watch's crash leaves the others. */
export const watch = Effect.all(
  [
    kept(attentionLooked, watchAttention),
    kept(vitalsLooked, watchVitals),
    kept(permissionsLooked, watchPermissions),
    kept(straysLooked, watchStrays),
    kept(diskLooked, watchDisk),
    kept(deviceLooked, watchDevice),
  ],
  {
    concurrency: "unbounded",
    discard: true,
  },
)

// Tools.

const MAX_OUTPUT = 30_000

const clipOutput = (text: string) =>
  text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, 10_000)}\n… ${text.length - MAX_OUTPUT} characters cut …\n${text.slice(-20_000)}`

const exec = tool(
  "exec",
  {
    description: marked(
      "Run a shell command on this Mac (zsh, login environment), in its own process group: a timeout stops everything it started, and so does cancel. Output is its head and tail when long. Files move between machines with rsync or scp over ssh, from whichever machine reaches the other.",
      "heavy commands (builds, tests, Blender, ffmpeg, simulators) are",
    ),
    input: Schema.Struct({
      command: Schema.String,
      cwd: Schema.optionalKey(Schema.String),
      timeout_s: Schema.optionalKey(Schema.Finite),
      env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      ...askedField,
    }),
  },
  (input) =>
    task(async () => {
      const started = Date.now()
      const cwd = expand(input.cwd ?? "~")
      const command = guardExec(input.command, cwd, input)
      const id = crypto.randomUUID()
      const proc = Bun.spawn(["/bin/zsh", "-lc", command], {
        cwd,
        env: { ...process.env, ...input.env, SWITCH_EXEC: id },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })
      procs.began(id.slice(0, 8), input.command, proc.pid)
      void proc.exited.then((code) => {
        procs.ended(id.slice(0, 8))
        return code
      })
      const limit = Math.min(Math.max(1, input.timeout_s ?? 120), 3600) * 1000
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {
          proc.kill("SIGKILL")
        }
      }, limit)
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      clearTimeout(timer)
      return {
        code,
        ...(timedOut ? { timedOut: true } : {}),
        ms: Date.now() - started,
        stdout: clipOutput(out),
        ...(err === "" ? {} : { stderr: clipOutput(err) }),
      }
    }),
)

const IMAGE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
const MAX_TEXT = 256 * 1024

const readFileTool = tool(
  "read_file",
  {
    description:
      "Read a file on this Mac: text (from `offset`, at most `limit` bytes, 256 KB by default) or an image, shown.",
    readOnly: true,
    input: Schema.Struct({
      path: Schema.String,
      offset: Schema.optionalKey(Schema.Finite),
      limit: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      const mime = IMAGE[path.extname(p).toLowerCase()]
      const bytes = await readFile(p)
      if (mime !== undefined) {
        return answer({ path: p, size: bytes.length }, [
          { type: "image", data: bytes.toString("base64"), mimeType: mime },
        ])
      }
      const from = Math.max(0, input.offset ?? 0)
      const part = bytes.subarray(from, from + Math.min(input.limit ?? MAX_TEXT, MAX_TEXT))
      if (part.includes(0)) {
        throw new Error(`Binary, ${bytes.length} bytes`)
      }
      return { text: part.toString("utf-8"), size: bytes.length, from, to: from + part.length }
    }),
)

const writeFileTool = tool(
  "write_file",
  {
    description: "Write text to a file on this Mac, making its folders; `append` adds to the end.",
    input: Schema.Struct({
      path: Schema.String,
      text: Schema.String,
      append: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      mkdirSync(path.dirname(p), { recursive: true })
      await (input.append === true ? appendFile(p, input.text) : writeFile(p, input.text))
      return { path: p, size: statSync(p).size }
    }),
)

const kindOf = (s: Stats) => {
  if (s.isDirectory()) {
    return "folder"
  }
  if (s.isSymbolicLink()) {
    return "link"
  }
  return "file"
}

const listFiles = tool(
  "list_files",
  {
    description: "A folder's entries on this Mac: name, kind, size and when modified. At most 500.",
    readOnly: true,
    input: Schema.Struct({ path: Schema.String }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      const names = readdirSync(p).toSorted().slice(0, 500)
      const entries = names.map((name) => {
        try {
          const s = statSync(path.join(p, name))
          return { name, kind: kindOf(s), size: s.size, modified: s.mtime.toISOString() }
        } catch {
          return { name, kind: "unreadable" }
        }
      })
      return await Promise.resolve({ path: p, entries })
    }),
)

const statFile = tool(
  "stat_file",
  {
    description: "Whether a path on this Mac exists, and its kind, size, times and mode.",
    readOnly: true,
    input: Schema.Struct({ path: Schema.String }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      if (!existsSync(p)) {
        return { path: p, exists: false }
      }
      const s = statSync(p)
      return await Promise.resolve({
        path: p,
        exists: true,
        kind: kindOf(s),
        size: s.size,
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        mode: (s.mode % 0o1_0000).toString(8),
      })
    }),
)

const vitals = tool(
  "vitals",
  {
    description:
      "This Mac's vitals now: load (and over five minutes), CPU, memory and its pressure, swap and how fast it grows, free disk, battery.",
    readOnly: true,
  },
  () =>
    task(async () => {
      const r = latest ?? (await read(machine))
      // `alerting` is which of its widget's meters they show on.
      return { ...r, alerts: alerts(r), alerting: alerting(r) }
    }),
)

const loadTool = tool(
  "load",
  {
    description:
      "Whose load this Mac carries: each owner (the work or extension whose mark its processes carry, app, Claude Code session, program) with its CPU and memory footprint and its heaviest process, heaviest first; and the disk, free and how fast it's falling.",
    readOnly: true,
    input: Schema.Struct({ top: Schema.optionalKey(Schema.Finite) }),
  },
  (input) => task(async () => await load(input.top ?? 12)),
)

const attention = tool(
  "attention",
  {
    description:
      "Whether this Mac follows what's in front of the user (app and window). With `on`, turn it on or off; off, only whether they're here is known.",
    input: Schema.Struct({ on: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    task(async () => {
      if (input.on === false) {
        writeFileSync(OFF, "")
        current = null
        history.length = 0
      } else if (input.on === true) {
        rmSync(OFF, { force: true })
      }
      return await Promise.resolve({ on: tracking() })
    }),
)

const moment = tool(
  "moment",
  {
    description:
      "What the user is doing on this Mac now: the app and window in front (what was before Switch, if Switch is), what's focused and selected there, the last places they went, how long since their last input, whether the screen is locked. Secure fields are never read.",
    readOnly: true,
  },
  () =>
    task(async () => {
      const { seen, idle, locked, trusted } = await glance()
      if (!tracking()) {
        return { machine, tracking: false, idleS: Math.round(idle), locked }
      }
      const recent = history.slice(-10).toReversed()
      const lookedAt = isSwitch(seen.app)
        ? recent.find((g) => !isSwitch(g.app) && g.at > Date.now() - 600_000)
        : seen
      const focus =
        lookedAt !== undefined && trusted && !CHROMIUM.has(lookedAt.bundle)
          ? await hands("focused", { pid: lookedAt.pid }).catch((): null => null)
          : null
      return {
        machine,
        tracking: true,
        front: strip(seen),
        ...(lookedAt === undefined || lookedAt === seen ? {} : { lookedAt: strip(lookedAt) }),
        focus,
        recent: recent.map(strip),
        idleS: Math.round(idle),
        locked,
        accessibility: trusted,
      }
    }),
)

const barcodes = tool(
  "barcodes",
  {
    description:
      "Every barcode (QR, Aztec, PDF417, Code 128, Data Matrix, EAN/UPC…) on a ticket, boarding pass, bib or flyer: an image or PDF (a path on this Mac, a URL or a data: URL), or a Wallet pass's own. Each code's exact text, and `wallet`, the barcode for a Wallet pass as it is (format, message, encoding) when Wallet can draw its kind.",
    readOnly: true,
    input: Schema.Struct({ source: Schema.String }),
  },
  (input) =>
    task(async () => {
      const found = await decode(input.source.trim())
      return found
    }),
)

const screenshot = tool(
  "screenshot",
  {
    description:
      "A screenshot of a display of this Mac (1 is the main one). A locked screen that takes no password is opened first; one only the user can open fails, saying so.",
    readOnly: true,
    input: Schema.Struct({
      display: Schema.optionalKey(Schema.Finite),
      width: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    task(async () => {
      await hands("open-screen")
      const data = await capture({ display: input.display ?? 1 }, input.width ?? 1600)
      return answer({ machine, display: input.display ?? 1 }, [
        { type: "image", data, mimeType: "image/jpeg" },
      ])
    }),
)

const ui = tool(
  "ui",
  {
    description: marked(
      "Drive any app on this Mac through Accessibility: one step {op, app?, match?: {role?, text?}, index?, …} or {app?, steps: [step, …]}, stopping at the first that fails. Ops: tree {depth?}, find, press, set {attribute? (AXValue), value | secret}, focus, keys {keys: \"cmd+shift+g\"}, type {text | secret}, wait {timeout_ms?, gone?}. `app` is a name or bundle id, the front one if left out. secret is one of the user's vault secrets by reference (like card/main.number, or a login's name.password), put in straight from the vault without passing through you: set puts it in the matched field (the focused one without match), type types it wherever the cursor is (a terminal, a dialog, a field Accessibility can't set). Results say only how many characters went in, and it's masked wherever an app shows it back.",
      "driving its apps is",
    ),
    input: Schema.Record(Schema.String, Schema.Unknown),
  },
  (input) =>
    task(async () => {
      guard("drive its apps", input)
      const keyed = /"op":"(?:keys|type)"/u.test(JSON.stringify(input))
      const steps = Array.isArray(input.steps) ? input.steps : [input]
      const refs = [
        ...new Set(steps.map((step) => str(obj(step).secret)).filter((ref) => ref !== "")),
      ]
      const where = str(input.app) || "the app in front"
      const released = await Promise.all(
        refs.map(async (ref) => {
          const { value } = await vault.release(`macos-${machine}`, ref, `into ${where}`)
          return [ref, value] as const
        }),
      )
      const secrets = refs.length === 0 ? null : Object.fromEntries(released)
      const result = await hands("ui", input, secrets)
      if (keyed) {
        posted = Date.now()
      }
      return obj(result)
    }),
)

const open = tool(
  "open",
  {
    description: marked(
      "Open a URL (System Settings panes too), with an app if given; or an app; or show a path in Finder (`reveal`).",
      "opening things in front of the user is",
    ),
    input: Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      app: Schema.optionalKey(Schema.String),
      reveal: Schema.optionalKey(Schema.String),
      ...askedField,
    }),
  },
  (input) =>
    task(async () => {
      guard("open things in front of them", input)
      const opened: string[] = []
      if (input.url !== undefined || input.app !== undefined) {
        const argv = ["open"]
        if (input.app !== undefined) {
          const byId = input.app.includes(".") && !/[ /]/u.test(input.app)
          argv.push(byId ? "-b" : "-a", input.app)
        }
        if (input.url !== undefined) {
          argv.push(input.url)
        }
        if ((await Bun.spawn(argv, { stderr: "ignore" }).exited) !== 0) {
          throw new Error(`Couldn't open ${input.url ?? input.app ?? ""}`)
        }
        opened.push(input.url ?? input.app ?? "")
      }
      if (input.reveal !== undefined) {
        const p = expand(input.reveal)
        if ((await Bun.spawn(["open", "-R", p], { stderr: "ignore" }).exited) !== 0) {
          throw new Error(`Couldn't show ${p} in Finder`)
        }
        opened.push(p)
      }
      if (opened.length === 0) {
        throw new Error("open takes url, app or reveal")
      }
      return { opened }
    }),
)

const checkPaths = tool(
  "check_paths",
  {
    description:
      "Before touching a path macOS privacy may guard (Downloads, Desktop, Documents, iCloud, Mail, other apps' containers, /Volumes): per path, ok, blocked, missing or error, what guards it and the grant that opens it. Probes in a child killed after timeout_ms, so it never hangs; `live` false decides from the grants alone, touching nothing.",
    readOnly: true,
    input: Schema.Struct({
      paths: Schema.Array(Schema.String),
      timeout_ms: Schema.optionalKey(Schema.Finite),
      live: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    task(async () => {
      const held = grants()
      const ms = Math.min(Math.max(100, input.timeout_ms ?? 3000), 60_000)
      const paths = await Promise.all(
        input.paths.map(async (p) => await check(p, ms, input.live ?? true, held)),
      )
      return { permissions: held, paths }
    }),
)

const straysTool = tool(
  "strays",
  {
    description:
      "Processes agent turns and execs left running on this Mac, by kind (work, claude-shell, exec, leftover, unclaimed), with when each is due to be stopped; unclaimed ones are only reported. Swept every five minutes.",
    readOnly: true,
  },
  () => task(async () => ({ strays: await strays.look(RULES, live) })),
)

const sweepStrays = tool(
  "sweep_strays",
  {
    description:
      "Stop strays now: those given by pid (any kind but a launchd job's), else every one that's due. TERM, then KILL after 10 s.",
    input: Schema.Struct({ pids: Schema.optionalKey(Schema.Array(Schema.Finite)) }),
  },
  (input) =>
    task(async () => {
      const found = await strays.look(RULES, live)
      const { pids } = input
      const chosen =
        pids === undefined
          ? found.filter((s) => s.stopInS === 0)
          : found.filter((s) => pids.includes(s.pid))
      const stopped = await strays.stop(chosen)
      return { stopped: stopped.map((s) => ({ pid: s.pid, kind: s.kind, what: s.what })) }
    }),
)

const keepRunning = tool(
  "keep_running",
  {
    description: "Never stop a stray whose command line holds `text`.",
    input: Schema.Struct({ text: Schema.String }),
  },
  (input) => task(async () => await Promise.resolve(strays.keep(RULES, input.text))),
)

export const macosApp = defineApp({
  name: "macos",
  version: "1",
  instructions: `The Mac ${machine}: commands, files, vitals, what the user is doing on it, screenshots and any app's interface.`,
  tools: [
    exec,
    readFileTool,
    writeFileTool,
    listFiles,
    statFile,
    barcodes,
    vitals,
    loadTool,
    attention,
    moment,
    screenshot,
    ui,
    open,
    checkPaths,
    straysTool,
    sweepStrays,
    keepRunning,
    diskTool,
    makeRoomTool,
    ...moreTools,
  ],
  events: [Vitals, Attention, Permissions, StraysStopped, ...diskEvents, Device, Heartbeat],
  widgets: [
    {
      name: "vitals",
      title: "Vitals",
      surfaces: ["space"],
      resource: "ui://macos/vitals",
      // This Mac's picture between its meters, a shape that scales with its cell.
      size: {
        aspect: "wide",
        ratio: ratio(mac.battery),
        min: { cols: 4, rows: 2 },
        preferred: { cols: 5, rows: 2 },
        max: { cols: 8, rows: 3 },
      },
      tool: "vitals",
      refresh: [Vitals.type],
      a2ui: () =>
        surface("vitals", MCP_CATALOG, [
          {
            id: "root",
            component: "McpApp",
            title: mac.name,
            htmlContent: page,
            // The tool's whole result, as MCP Apps' tool-result.
            data: { paths: { toolResult: "/" } },
          },
        ]),
    },
  ],
})
