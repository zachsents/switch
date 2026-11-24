// The scripts a machine's host runs for the core (scripts.ts). Each runs apart from the host, in a
// session of its own, its output straight to a log in its folder, under a shell that writes its exit
// code there when it ends. So a deploy or a host's restart (launchd stopping the core or the host)
// leaves it running, and the next host takes it up: the process table is its record (the shell's
// command line names the run), the rest is the core's (each spec's pid and restarts), so a host that
// dies just after a start never starts it twice. One a reboot or a kill stopped before it ended,
// with no exit code, is started again from the top. Its log is bounded as an extension's is
// (host.ts): past 5 MB it moves to `log.1`.
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs"
import path from "node:path"
import { yielding } from "@switch/agent"
import { writeFileAtomic } from "@switch/brain/files"
import { Option, Schema } from "effect"

import { scriptSpec } from "./link.ts"
import type { ScriptSpec, ToCore } from "./link.ts"

const MAX_LOG = 5 * 1024 * 1024
const STOP_GRACE_MS = 10_000
/** The lines of output `script.ended` carries. */
const ENDED_LINES = 20
/** How much of a log's end a tail reads. */
const TAIL_BYTES = 256 * 1024

// `$1` is the script, `$2` where its exit code goes once it ends on its own.
const WRAP = '"$1"; code=$?; printf %s "$code" > "$2.tmp"; mv "$2.tmp" "$2"'

/** A run of a script: one per set. */
const runOf = (s: ScriptSpec) => `${s.id}:${s.gen}`

const decodeWant = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(scriptSpec)))

/** Every process's command line, by pid. */
const commands = () => {
  const out = new Map<number, string>()
  const rows = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,command="])
    .stdout.toString()
    .split("\n")
  for (const row of rows) {
    const m = /^\s*(?<pid>\d+)\s+(?<command>.+?)\s*$/u.exec(row)
    if (m?.groups) {
      out.set(Number(m.groups.pid), m.groups.command ?? "")
    }
  }
  return out
}

const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig)
  } catch {
    // Already gone.
  }
}

/** The last `n` lines of a file, or "" without one. */
const lastLines = (file: string, n: number) => {
  if (!existsSync(file)) {
    return ""
  }
  const { size } = statSync(file)
  const fd = openSync(file, "r")
  try {
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    return buf.toString("utf-8").trimEnd().split("\n").slice(-n).join("\n")
  } finally {
    closeSync(fd)
  }
}

export const makeScripts = (options: {
  /** The host's own folder: scripts keep theirs in `<root>/scripts/<id>`. */
  readonly root: string
  /** Each script's environment, before what the core gives it. */
  readonly env: () => Readonly<Record<string, string>>
  readonly emit: (m: ToCore) => void
}) => {
  const dir = path.join(options.root, "scripts")
  mkdirSync(dir, { recursive: true })
  const wantFile = path.join(dir, "want.json")
  const wanted = new Map<string, ScriptSpec>()

  const folderOf = (id: string) => path.join(dir, id)
  const runFile = (id: string) => path.join(folderOf(id), "run")
  // One per run it was set for: a replaced run's end never reads as the next one's.
  const codeFile = (id: string, gen: number) => path.join(folderOf(id), `code.${gen}`)
  const logFile = (id: string) => path.join(folderOf(id), "log")
  // This host's own starts and reported ends, each by run: what the core may not have heard yet.
  const starts = new Map<string, { readonly pid: number; readonly restarts: number }>()
  const told = new Set<string>()

  /** The shells running script `id`, each with the run it's for: by the command line WRAP gives it. */
  const runsOf = (id: string, procs: Map<number, string>) => {
    const named = ` script ${runFile(id)} ${path.join(folderOf(id), "code.")}`
    const out: { readonly pid: number; readonly gen: number }[] = []
    for (const [pid, command] of procs) {
      const at = command.lastIndexOf(named)
      if (at !== -1) {
        out.push({ pid, gen: Number(command.slice(at + named.length)) })
      }
    }
    return out
  }
  const liveOf = (s: ScriptSpec, procs: Map<number, string>) =>
    runsOf(s.id, procs).find((r) => r.gen === s.gen)

  /** Its last pid and restarts: this host's start, else the core's record; null if never started. */
  const heldOf = (s: ScriptSpec) =>
    starts.get(runOf(s)) ?? (s.pid === undefined ? null : { pid: s.pid, restarts: s.restarts ?? 0 })

  const report = (s: ScriptSpec, pid: number, restarts: number, code?: number) => {
    options.emit({
      t: "script",
      id: s.id,
      gen: s.gen,
      pid,
      restarts,
      ...(code !== undefined && { code, tail: lastLines(logFile(s.id), ENDED_LINES) }),
    })
  }

  const start = (s: ScriptSpec, restarts: number) => {
    const folder = folderOf(s.id)
    // A new run starts clean; one started again keeps its log.
    if (restarts === 0) {
      rmSync(folder, { recursive: true, force: true })
    }
    mkdirSync(folder, { recursive: true })
    const run = runFile(s.id)
    writeFileAtomic(run, s.run.startsWith("#!") ? s.run : `#!/bin/sh\n${s.run}`, { mode: 0o700 })
    const out = openSync(logFile(s.id), "a")
    const child = Bun.spawn(
      yielding(["/bin/sh", "-c", WRAP, "script", run, codeFile(s.id, s.gen)]),
      {
        cwd: folder,
        env: { ...options.env(), SWITCH_SCRIPT: s.name, ...s.env },
        detached: true,
        stdio: ["ignore", out, out],
      },
    )
    closeSync(out)
    child.unref()
    starts.set(runOf(s), { pid: child.pid, restarts })
    report(s, child.pid, restarts)
    // Its end is seen at once, not at the next look.
    void child.exited.then(() => {
      settle(commands())
      return null
    })
  }

  /** Stops each of its runs but the one for `gen` (every one without it). */
  const stopRuns = (id: string, procs: Map<number, string>, gen?: number) => {
    for (const r of runsOf(id, procs)) {
      if (r.gen === gen) {
        continue
      }
      signalGroup(r.pid, "SIGTERM")
      setTimeout(() => {
        if (runsOf(id, commands()).some((now) => now.pid === r.pid)) {
          signalGroup(r.pid, "SIGKILL")
        }
      }, STOP_GRACE_MS)
    }
  }

  /** One script as it stands: ended on its own, still running, or started again. */
  const settleOne = (s: ScriptSpec, procs: Map<number, string>) => {
    stopRuns(s.id, procs, s.gen)
    if (s.ended === true || liveOf(s, procs) !== undefined) {
      return
    }
    const held = heldOf(s)
    const code = codeFile(s.id, s.gen)
    if (existsSync(code)) {
      if (!told.has(runOf(s))) {
        told.add(runOf(s))
        report(s, held?.pid ?? 0, held?.restarts ?? 0, Number(readFileSync(code, "utf-8")))
      }
      return
    }
    start(s, held === null ? 0 : held.restarts + 1)
  }

  const settle = (procs: Map<number, string>) => {
    for (const s of wanted.values()) {
      settleOne(s, procs)
    }
  }

  /** Each tick: what ended or stopped, and logs past their bound. */
  const tick = () => {
    if (wanted.size === 0) {
      return
    }
    settle(commands())
    for (const s of wanted.values()) {
      const log = logFile(s.id)
      if (existsSync(log) && statSync(log).size > MAX_LOG) {
        copyFileSync(log, `${log}.1`)
        truncateSync(log, 0)
      }
    }
  }

  /** What the core wants run (or kept): the rest stop and go; each one's state goes back to it. */
  const want = (specs: readonly ScriptSpec[]) => {
    const procs = commands()
    const ids = new Set(specs.map((s) => s.id))
    for (const id of readdirSync(dir)) {
      if (id !== "want.json" && !ids.has(id)) {
        stopRuns(id, procs)
        rmSync(folderOf(id), { recursive: true, force: true })
      }
    }
    wanted.clear()
    told.clear()
    for (const s of specs) {
      wanted.set(s.id, s)
    }
    writeFileAtomic(wantFile, JSON.stringify(specs))
    settle(procs)
    for (const s of specs) {
      const live = liveOf(s, procs)
      if (live !== undefined) {
        report(s, live.pid, heldOf(s)?.restarts ?? 0)
      }
    }
  }

  const tail = (id: string, lines: number) =>
    existsSync(folderOf(id))
      ? [lastLines(`${logFile(id)}.1`, lines), lastLines(logFile(id), lines)]
          .filter((t) => t !== "")
          .join("\n")
          .split("\n")
          .slice(-lines)
          .join("\n")
      : null

  // What the core last wanted, before it's reached: a script that ended or stopped while no host
  // ran is seen to now. One that won't read is no list: nothing is stopped until the core says.
  if (existsSync(wantFile)) {
    const last = decodeWant(readFileSync(wantFile, "utf-8"))
    if (Option.isSome(last)) {
      want(last.value)
    }
  }

  return { want, tick, tail }
}
