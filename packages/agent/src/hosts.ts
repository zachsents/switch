// A host is an account: a provider, a login and a machine. Turns go where they fit (Switchboard's
// place.rs): the machine with the work's folder, then an always-on one, a desktop, a laptop, and
// the user's own laptop last; among those, across the hosts that run the thread's provider, by how
// much of their usage windows is left.
import {
  closeSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import type { Subscription } from "@switch/models"
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"

import type { InstalledAgent } from "./acp-install.ts"

export interface Proc {
  readonly pid: number
  readonly write: (line: string) => void
  readonly end: () => void
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly kill: (signal?: NodeJS.Signals) => void
}

/** On the user's own laptop: what keeps a turn's shell off heavy work. */
export interface Guard {
  /** A PreToolUse hook command that refuses heavy shell commands, saying where to run them. */
  readonly hook: string
  /** PATH stand-ins that refuse builds, tests and encodes a script runs. */
  readonly bin: string
  /** Sourced before each shell command (CLAUDE_ENV_FILE): the stand-ins first on PATH. */
  readonly envFile: string
}

/** Where processes run: this one, or another machine's host over its link to the core. */
export interface Machine {
  /** Its name to the core. */
  readonly id: string
  readonly home: string
  /** Its host's state folder, where accounts lent to it keep their homes: `~/.switch` when unset. */
  readonly dir?: string
  /** What it provides: its OS, and "always-on", "laptop" or "personal" for where turns go. */
  readonly provides: readonly string[]
  /** The environment its processes start from. */
  readonly env: Readonly<Record<string, string>>
  readonly guard?: Guard
  readonly spawn: (
    argv: readonly string[],
    options: {
      readonly cwd: string
      readonly env: Readonly<Record<string, string>>
      /** Read once by the child on fd 3: never in its environment or arguments. */
      readonly secret?: Redacted.Redacted
    },
  ) => Effect.Effect<Proc>
  /** `secret`: readable by its owner only. */
  readonly writeFile: (file: string, text: string, secret?: boolean) => Effect.Effect<void>
  readonly exists: (file: string) => Effect.Effect<boolean>
  /** Null when it isn't there. */
  readonly realpath: (dir: string) => Effect.Effect<string | null>
  /** Kills what a previous run left running here, with everything it started. */
  readonly reap: Effect.Effect<number>
}

/** A login's token for one session, and until when it's good (ms; Infinity when it doesn't lapse). */
export interface Credential {
  readonly secret: Redacted.Redacted
  readonly until: number
}

export interface Host {
  readonly acp?: InstalledAgent
  readonly id: string
  readonly machine: Machine
  /** Claude when unset. */
  readonly provider?: Subscription
  /**
   * The login's home: CLAUDE_CONFIG_DIR, CODEX_HOME or GEMINI_HOME. The machine's default sign-in
   * when unset. Hosts that share one share sessions, so a thread moves between them as it is.
   */
  readonly configDir?: string
  /** A login held as a token (`claude setup-token`, or one the core keeps fresh), read when a session starts. */
  readonly token?: Effect.Effect<Credential | null>
  /** The account its login is, when it isn't its own: hosts of one account share its usage and limits. */
  readonly account?: string
  /** The account's login lent to this machine by the core, rather than one of the machine's own. */
  readonly lent?: boolean
}

export const providerOf = (host: Host): Subscription => host.provider ?? "claude"

/**
 * `host`, with each process it starts carrying `work` as `SWITCH_WORK`: what that starts inherits
 * it, a job left detached (`nohup job.sh &`) too, so a Mac's runaway stopper knows it for the work's
 * (core runaway.ts).
 */
export const workOn = (host: Host, work: string): Host => ({
  ...host,
  machine: {
    ...host.machine,
    spawn: (argv, options) =>
      host.machine.spawn(argv, { ...options, env: { ...options.env, SWITCH_WORK: work } }),
  },
})

/** This process's environment. */
export const processEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v
    }
  }
  return env
}

/**
 * A child CLI's environment on `machine`: its own, without what `drop` matches; on the user's
 * laptop, with the stand-ins first on PATH and sourced before each shell command.
 */
export const guarded = (
  machine: Pick<Machine, "env" | "guard">,
  drop: RegExp,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(machine.env)) {
    if (!drop.test(k)) {
      out[k] = v
    }
  }
  Object.assign(out, extra)
  if (machine.guard) {
    out.CLAUDE_ENV_FILE = machine.guard.envFile
    out.PATH = `${machine.guard.bin}:${out.PATH ?? ""}`
  }
  return out
}

// What's written to a child that has gone (its pipe broken, EPIPE) goes nowhere: its end is told
// by its `exited`. Unheard, the error, thrown or rejected, would end the core.
const toChild = async (send: () => number | Promise<number>) => {
  try {
    await send()
  } catch {
    // Gone: see above.
  }
}

const startedAt = (pid: number) =>
  Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="])
    .stdout.toString()
    .trim()

/** Every process's parent and start (as `ps` says it), by pid. */
const table = () => {
  const out = new Map<number, { readonly ppid: number; readonly started: string }>()
  for (const row of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,lstart="])
    .stdout.toString()
    .split("\n")) {
    const m = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<started>.+?)\s*$/u.exec(row)
    if (m?.groups) {
      out.set(Number(m.groups.pid), {
        ppid: Number(m.groups.ppid),
        started: m.groups.started ?? "",
      })
    }
  }
  return out
}

const descendantsIn = (procs: ReturnType<typeof table>, root: number) => {
  const children = new Map<number, number[]>()
  for (const [pid, p] of procs) {
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid])
  }
  const out: number[] = []
  const walk = (pid: number) => {
    for (const c of children.get(pid) ?? []) {
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

const descendants = (root: number) => descendantsIn(table(), root)

const parentOf = (pid: number) =>
  Number(
    Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  )

const signal = (pids: readonly number[], sig: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, sig)
    } catch {
      // Already gone.
    }
  }
}

/**
 * What `root` started, as it stands now. Once `root` is gone they're launchd's, out of its tree, so
 * a child that ignores its parent's end would run on: `end` asks those still running to stop, then
 * kills what's left after `graceMs`. Each by its pid and start, so a pid given again is never it.
 */
export const startedBy = (root: number) => {
  const now = table()
  const was = descendantsIn(now, root).map((pid) => [pid, now.get(pid)?.started] as const)
  const still = () => {
    const then = table()
    return was.filter(([pid, started]) => then.get(pid)?.started === started).map(([pid]) => pid)
  }
  return {
    end: (graceMs: number) => {
      signal(still(), "SIGTERM")
      setTimeout(() => {
        signal(still(), "SIGKILL")
      }, graceMs)
    },
  }
}

/**
 * A command that gives way to the core on its machine: on macOS, at utility QoS (`taskpolicy -c
 * utility`), which it and all it starts inherit, below the core's own Interactive job. An agent's
 * build, encode or test then never starves the core serving the clients. The program is exec'd in
 * place, so its pid is the one spawned.
 */
export const yielding = (argv: readonly string[]): string[] =>
  process.platform === "darwin" ? ["/usr/sbin/taskpolicy", "-c", "utility", ...argv] : [...argv]

const ProcRecord = Schema.Struct({ pid: Schema.Number, started: Schema.String })
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ProcRecord))

/**
 * This Mac. Each process it spawns is recorded by pid and start time under `stateDir`, so the
 * next run can kill what a crash left behind; the start time keeps a reused pid safe.
 */
export const localMachine = (
  stateDir: string,
  about: {
    readonly id?: string
    readonly provides?: readonly string[]
    readonly guard?: Guard
  } = {},
): Machine => {
  const records = path.join(stateDir, "procs")
  mkdirSync(records, { recursive: true })
  const record = (pid: number) => path.join(records, `${pid}.json`)
  const env = processEnv()
  return {
    id: about.id ?? "local",
    home: homedir(),
    provides: about.provides ?? [],
    env,
    ...(about.guard && { guard: about.guard }),
    spawn: (argv, options) =>
      Effect.sync(() => {
        const child = Bun.spawn(yielding(argv), {
          cwd: options.cwd,
          env: { ...options.env },
          stdio: options.secret ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        })
        if (options.secret) {
          // Down a pipe on its fd 3: never on disk, so a crash leaves it nowhere.
          const fd = child.stdio.at(3)
          if (typeof fd !== "number") {
            child.kill("SIGKILL")
            throw new Error("No pipe for the secret")
          }
          writeSync(fd, Redacted.value(options.secret))
          closeSync(fd)
        }
        writeFileAtomic(
          record(child.pid),
          JSON.stringify({ pid: child.pid, started: startedAt(child.pid) }),
        )
        const exited = child.exited.then((code) => {
          rmSync(record(child.pid), { force: true })
          return code
        })
        return {
          pid: child.pid,
          write: (line) => {
            void toChild((): number | Promise<number> => child.stdin.write(line))
            void toChild((): number | Promise<number> => child.stdin.flush())
          },
          end: () => {
            void toChild((): number | Promise<number> => child.stdin.end())
          },
          stdout: child.stdout,
          stderr: child.stderr,
          exited,
          kill: (sig) => {
            // Tools run in shells of their own, so take the whole tree.
            signal([child.pid, ...descendants(child.pid)], sig ?? "SIGTERM")
          },
        }
      }),
    writeFile: (file, text, secret) =>
      Effect.sync(() => {
        const owned = secret === true
        mkdirSync(path.dirname(file), { recursive: true, ...(owned && { mode: 0o700 }) })
        writeFileAtomic(file, text, owned ? { mode: 0o600 } : {})
      }),
    exists: (file) => Effect.sync(() => Bun.file(file).size > 0),
    realpath: (dir) =>
      Effect.sync(() => {
        try {
          return realpathSync(dir)
        } catch {
          return null
        }
      }),
    reap: Effect.gen(function* reaping() {
      const trees: number[][] = []
      // Secrets an earlier version left on disk when it died mid-spawn.
      for (const name of readdirSync(records).filter((n) => n.startsWith("."))) {
        rmSync(path.join(records, name), { force: true })
      }
      for (const name of readdirSync(records).filter((n) => n.endsWith(".json"))) {
        const file = path.join(records, name)
        const r = Option.getOrNull(decodeRecord(readFileSync(file, "utf-8")))
        if (r === null) {
          // Not one this wrote whole: without its start time its pid may be anyone's now.
          yield* Effect.logWarning(`Unreadable process record ${file}: not reaped`)
        } else if (r.started !== "" && startedAt(r.pid) === r.started) {
          // Still held by a live parent: another run's own (a core running beside this one), not
          // left behind; a run that died leaves its children to launchd.
          if (parentOf(r.pid) !== 1) {
            continue
          }
          trees.push([r.pid, ...descendants(r.pid)])
        }
        rmSync(file, { force: true })
      }
      if (trees.length > 0) {
        signal(trees.flat(), "SIGTERM")
        yield* Effect.sleep("2 seconds")
        signal(trees.flat(), "SIGKILL")
      }
      return trees.length
    }),
  }
}

export class NoHost extends Data.TaggedError("NoHost")<{
  /** When the soonest usage limit lifts, if every host is limited. */
  readonly resetAt: number | null
}> {}

/** One of an account's usage windows, as its provider last reported it. */
export interface Window {
  readonly name: string
  /** 0 to 1. */
  readonly used: number
  /** ms; 0 when unknown. */
  readonly resetsAt: number
}

export interface HostState {
  readonly host: Host
  /** The account its login is. */
  readonly account: string
  readonly running: number
  readonly limitedUntil: number
  readonly up: boolean
  /** Why it's down besides a usage limit, such as a login that's signed out. */
  readonly problem: string
  readonly windows: readonly Window[]
  /** The fullest window's share used, 0 to 1. */
  readonly used: number
}

export interface HostsShape {
  /** Every host now: this machine's, those of machines linked in, and the accounts lent to them. */
  readonly all: readonly Host[]
  /** An account signed in since the start. */
  readonly add: (host: Host) => Effect.Effect<void>
  /** An account forgotten: turns no longer go to it. */
  readonly remove: (id: string) => Effect.Effect<void>
  readonly get: (id: string) => Host | undefined
  /** The account a host's login is: its own id unless it's another login of an account. */
  readonly account: (id: string) => string
  /** Logins found to be the same account as another, by host id: each the account's id. */
  readonly merge: (same: ReadonlyMap<string, string>) => Effect.Effect<void>
  /** Lends accounts to each machine linked in: `f` gives a machine its hosts of them. */
  readonly lend: (f: (machine: Machine) => readonly Host[]) => Effect.Effect<void>
  /**
   * The host for a turn on `provider` (any when unset), where it fits best: on a machine with the
   * work's folder (`folders`, by machine), then an always-on one, a steady one (a desktop), a
   * laptop, and the user's own laptop last; a better-placed one with room always first. Within
   * the best, `prefer` wins while it's up and has room: the thread's session and prompt cache are
   * there. Otherwise the one with most room. A machine's own login of an account goes before one
   * lent to it.
   */
  readonly pick: (
    prefer: string | null,
    provider?: Subscription,
    folders?: ReadonlySet<string>,
    account?: string,
    eligible?: ReadonlySet<string>,
  ) => Effect.Effect<Host, NoHost>
  readonly begin: (id: string) => Effect.Effect<void>
  readonly end: (id: string) => Effect.Effect<void>
  /** Down until `until`: a usage limit, or `problem`. */
  readonly limit: (id: string, until: number, problem?: string) => Effect.Effect<void>
  /** What the provider said of the account's windows. Whether anything worth recording changed. */
  readonly learn: (id: string, windows: readonly Window[]) => Effect.Effect<boolean>
  /** Each account's state, by the host whose id is the account's (its first login otherwise). */
  readonly states: Effect.Effect<readonly HostState[]>
  /** A machine linked in, with its hosts: those of a machine by that name before it go. */
  readonly attach: (machine: Machine, hosts: readonly Host[]) => Effect.Effect<void>
  /** A machine gone, as it was attached: its hosts go, and what ran there carries on elsewhere. */
  readonly detach: (machine: Machine) => Effect.Effect<void>
  /** Called with each machine that goes, for what ran there to carry on elsewhere. */
  readonly onGone: (f: (machine: string) => Effect.Effect<void>) => void
}

// Ported from Switchboard's accounts.rs: a running turn counts for about what one takes of a
// 5-hour window, so turns under way weigh in before the provider says what they used.
const TURN_SHARE = 0.05
// Past this, a warm session moves anyway when another account has room.
const ROOMY = 0.9

const load = (s: HostState) => s.used + s.running * TURN_SHARE
// Whole points of a window, or a reset moving: enough to record, not every turn.
const windowsKey = (ws: readonly Window[]) =>
  ws.map((w) => `${w.name}:${Math.round(w.used * 100)}:${w.resetsAt}`).join(" ")

/** Where a machine stands for turns, best first (Switchboard's place.rs). */
const rank = (m: Machine) => {
  if (m.provides.includes("always-on")) {
    return 0
  }
  if (m.provides.includes("personal")) {
    return 3
  }
  if (m.provides.includes("laptop")) {
    return 2
  }
  return 1
}

/** A host's place for a turn whose work has folders on `folders`: lower is better. */
const placeOf = (s: HostState, folders: ReadonlySet<string> | undefined) =>
  (folders?.has(s.host.machine.id) === true ? 0 : 10) + rank(s.host.machine)

const lendNone = (): readonly Host[] => []

const makeHosts = (initial: readonly Host[]): HostsShape => {
  let hosts = [...initial]
  // Machines linked in, and the hosts of the accounts lent to each.
  const machines = new Map<string, Machine>()
  let lender: (machine: Machine) => readonly Host[] = lendNone
  let lent: Host[] = []
  let same: ReadonlyMap<string, string> = new Map()
  const gone: ((machine: string) => Effect.Effect<void>)[] = []
  // By account.
  const running = new Map<string, number>()
  const limited = new Map<string, number>()
  const lastUsed = new Map<string, number>()
  const windows = new Map<string, readonly Window[]>()
  const problems = new Map<string, string>()
  const relend = () => {
    lent = [...machines.values()]
      .flatMap((m) => lender(m))
      .filter((l) => !hosts.some((h) => h.id === l.id))
  }
  const all = () => [...hosts, ...lent]
  const find = (id: string) => all().find((h) => h.id === id)
  const accountOfHost = (h: Host) => {
    const a = same.get(h.id) ?? h.account ?? h.id
    return same.get(a) ?? a
  }
  const account = (id: string) => {
    const host = find(id)
    return host === undefined ? (same.get(id) ?? id) : accountOfHost(host)
  }
  const state = (host: Host, now: number): HostState => {
    const a = accountOfHost(host)
    const limitedUntil = limited.get(a) ?? 0
    const down = limitedUntil > now
    const ws = (windows.get(a) ?? []).filter((w) => w.resetsAt === 0 || w.resetsAt > now)
    return {
      host,
      account: a,
      running: running.get(a) ?? 0,
      limitedUntil,
      up: !down,
      problem: down ? (problems.get(a) ?? "") : "",
      windows: ws,
      used: Math.max(0, ...ws.map((w) => w.used)),
    }
  }
  return {
    get all() {
      return all()
    },
    add: (host) =>
      Effect.sync(() => {
        hosts = [...hosts.filter((h) => h.id !== host.id), host]
        relend()
      }),
    remove: (id) =>
      Effect.sync(() => {
        hosts = hosts.filter((h) => h.id !== id)
        relend()
      }),
    get: find,
    account,
    merge: (next) =>
      Effect.sync(() => {
        same = next
      }),
    lend: (f) =>
      Effect.sync(() => {
        lender = f
        relend()
      }),
    pick: (prefer, provider, folders, wanted, eligible) =>
      Effect.suspend(() => {
        const now = Date.now()
        const want = wanted === undefined ? undefined : account(wanted)
        const able = all().filter(
          (h) =>
            (provider === undefined || providerOf(h) === provider) &&
            (want === undefined || accountOfHost(h) === want) &&
            (eligible === undefined || eligible.has(h.id) || eligible.has(accountOfHost(h))),
        )
        const states = able
          .filter(
            (h) =>
              h.lent !== true ||
              !able.some(
                (o) =>
                  o.lent !== true &&
                  o.machine.id === h.machine.id &&
                  accountOfHost(o) === accountOfHost(h),
              ),
          )
          .map((h) => state(h, now))
        const up = states.filter((s) => s.up)
        const roomy = up.some((s) => s.used < ROOMY)
        // The best-placed hosts with room; when none has any, the best-placed.
        const best = Math.min(
          ...up.filter((s) => s.used < ROOMY || !roomy).map((s) => placeOf(s, folders)),
        )
        const here = up.filter((s) => placeOf(s, folders) === best)
        const preferred = here.find((s) => s.host.id === prefer)
        if (preferred && (preferred.used < ROOMY || !roomy)) {
          return Effect.succeed(preferred.host)
        }
        // Among an account's logins on a machine, the one by the account's id first.
        const [first] = here.toSorted(
          (a, b) =>
            load(a) - load(b) ||
            (lastUsed.get(accountOfHost(a.host)) ?? 0) -
              (lastUsed.get(accountOfHost(b.host)) ?? 0) ||
            Number(a.host.id !== accountOfHost(a.host)) -
              Number(b.host.id !== accountOfHost(b.host)),
        )
        if (first) {
          return Effect.succeed(first.host)
        }
        const resets = states.map((s) => s.limitedUntil).filter((t) => t > 0)
        return Effect.fail(new NoHost({ resetAt: resets.length > 0 ? Math.min(...resets) : null }))
      }),
    begin: (id) =>
      Effect.sync(() => {
        const a = account(id)
        running.set(a, (running.get(a) ?? 0) + 1)
        lastUsed.set(a, Date.now())
      }),
    end: (id) =>
      Effect.sync(() => {
        const a = account(id)
        running.set(a, Math.max(0, (running.get(a) ?? 0) - 1))
      }),
    limit: (id, until, problem) =>
      Effect.sync(() => {
        const a = account(id)
        limited.set(a, until)
        problems.set(a, problem ?? "")
      }),
    learn: (id, next) =>
      Effect.sync(() => {
        const a = account(id)
        const before = windows.get(a) ?? []
        windows.set(a, next)
        return windowsKey(before) !== windowsKey(next)
      }),
    states: Effect.sync(() => {
      const now = Date.now()
      const out = new Map<string, Host>()
      for (const h of hosts) {
        const a = accountOfHost(h)
        if (!out.has(a) || h.id === a) {
          out.set(a, h)
        }
      }
      return [...out.values()].map((h) => state(h, now))
    }),
    attach: (machine, more) =>
      Effect.sync(() => {
        hosts = [...hosts.filter((h) => h.machine.id !== machine.id), ...more]
        machines.set(machine.id, machine)
        relend()
      }),
    detach: (machine) =>
      Effect.suspend(() => {
        const was = hosts.length
        hosts = hosts.filter((h) => h.machine !== machine)
        if (machines.get(machine.id) === machine) {
          machines.delete(machine.id)
        }
        const hadLent = lent.length
        relend()
        return was === hosts.length && hadLent === lent.length
          ? Effect.void
          : Effect.forEach(gone, (f) => f(machine.id), { discard: true })
      }),
    onGone: (f) => {
      gone.push(f)
    },
  }
}

export class Hosts extends Context.Service<Hosts, HostsShape>()("switch/Hosts") {
  static readonly layer = (hosts: readonly Host[]) => Layer.succeed(Hosts, makeHosts(hosts))
}

/** Claude Code's session file for `cwd` under a login. `cwd` must be real (no symlinks). */
export const sessionFile = (host: Host, cwd: string, session: string) =>
  path.join(
    host.configDir ?? path.join(host.machine.home, ".claude"),
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"),
    `${session}.jsonl`,
  )
