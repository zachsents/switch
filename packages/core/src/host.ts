// A machine's extension host: runs the extensions placed on it as stdio MCP servers, each from its
// own folder (an installed one's package added there first, from its pinned source), restarts one
// that dies or stops answering, and relays each one's MCP to the core over its link. Switchboard's
// keeper, boiled down (switchboard SPEC.md §5.8): a ping a minute and three missed restart it;
// backoff doubles to five minutes, reset by a minute's good run; what a host before it left running
// is stopped first. Extensions keep running while the core is away, from the last list it sent;
// what the core asked when its link drops is cancelled, so events wait for it to come back. On a
// machine besides the core's it also runs the agent turns the core places here, and stops them when
// the link drops: the core carries them on from the record.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { appendFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { localMachine } from "@switch/agent"
import { writeFileAtomic } from "@switch/brain/files"
import type { Login, Proc } from "@switch/agent"
import { chain, isJson, readOnly, switchboard } from "switch-ext-kit"
import type { Filter, Json } from "switch-ext-kit"
import { Cause, Effect, Exit, FiberMap, Option, Queue, Redacted, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Socket } from "effect/socket"

import { BUN } from "./config.ts"
import { guardOf } from "./guard.ts"
import { decodeToHost, SILENT_MS, spec } from "./link.ts"
import { RELEASE, TARGET, takeNext, takeRelease } from "./release.ts"
import { EVERY_MS, runaways } from "./runaway.ts"
import { makeScripts } from "./script-host.ts"
import type { Link, Spec, ToCore, ToHost } from "./link.ts"

const PING_MS = 60_000
const MISSES = 3
const STABLE_MS = 60_000
const MAX_BACKOFF_MS = 300_000
const STOP_GRACE_MS = 10_000
const MAX_LOG = 5 * 1024 * 1024
/** How often scripts are looked at: one that ended or stopped, a log past its bound. */
const SCRIPT_TICK_MS = 2000
// The link to the core, kept as T3's connection supervisor keeps its own (an attempt counts once
// the core answers), on Switchboard's bounds: a beat every 20 s (the core echoes each), and a link
// silent for SILENT_MS is dead (crates/sb/src/client.rs). A core busy for a few seconds is still
// there.
const BEAT_MS = 20_000
/** Once linked this long, a drop retries at once rather than backing off. */
const LINKED_MS = 30_000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000
const LOST_RETRY_MS = 250
/** How long a host waits for the core to say its release; one from before releases says nothing. */
const RELEASE_WAIT_MS = 5000
/** Ids of the host's own requests (pings), never the core's. */
const OWN = "host:"

export interface HostOptions {
  /** Extensions run in `<dir>/extensions/<name>`; the host keeps its records in `<dir>/host`. */
  readonly dir: string
  readonly machine: string
  readonly os: string
  readonly provides: readonly string[]
  /** The core's HTTP address from this machine: for extensions that call it (`SWITCH_URL`) and `sb`. */
  readonly core: string
  /** Agent turns the core may run here, on these logins: a host on another machine than it. */
  readonly turns?: { readonly logins: readonly Login[] }
}

interface Running {
  readonly spec: Spec
  run: number
  proc: Proc | null
  filter: Filter
  missed: number
  /** The core's requests it hasn't answered. */
  readonly open: Set<unknown>
}

export interface HostShape {
  /** A link to the core, until the scope closes. */
  readonly connect: Effect.Effect<Link, never, Scope.Scope>
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeWant = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(spec)))

const filterOf = (s: Spec): Filter =>
  chain([
    ...(s.shim === "switchboard" ? [switchboard(s.name)] : []),
    ...(s.readOnly === true ? [readOnly()] : []),
  ])

// Switchboard's `sb` would act as the user in Switchboard; a shimmed appendage finds Switch's instead.
const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const stub = (command: string) => `#!/bin/sh
unset BUN_BE_BUN
exec ${[process.execPath, ...(Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main]), ...(command === "" ? [] : [command])].map(quoted).join(" ")} "$@"
`

const rotate = (log: string) => {
  if (existsSync(log) && statSync(log).size > MAX_LOG) {
    renameSync(log, `${log}.1`)
  }
}

const gone = (p: Proc, ms: number) =>
  Effect.promise(async () => await p.exited).pipe(
    Effect.timeoutOption(ms),
    Effect.map(Option.isSome),
  )

/** Its stdin closed, as an MCP server ends; then asked, then killed, with what it started. */
const stop = (p: Proc) =>
  Effect.gen(function* stopping() {
    p.end()
    if (yield* gone(p, 2000)) {
      return
    }
    p.kill("SIGTERM")
    if (yield* gone(p, STOP_GRACE_MS)) {
      return
    }
    p.kill("SIGKILL")
  })

/** JSON with its keys in order, so a spec read back from want.json reads as the one the core sent. */
const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(sorted)
  }
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(
      Object.entries(v)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sorted(x)]),
    )
  }
  return v
}

// The same spec, however its keys are ordered: an extension started from want.json isn't restarted
// when the core's own want arrives, which raced the gateway's first session onto the run it
// stopped.
const same = (a: Spec, b: Spec) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

// Each add extracts into a temp folder of its own, gone when it ends: bun adds racing for a package
// the cache lacks (the extensions of a host, a canary beside the live one) leave the losers'
// extractions in TMPDIR, about 3 GB a day on a Mac that deploys often.
const runAdd = (dir: string, source: string) =>
  Effect.promise(async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "extension-add-"))
    try {
      const p = Bun.spawn([...BUN.argv, "add", source], {
        cwd: dir,
        env: { ...process.env, ...BUN.env, TMPDIR: tmp },
        stdout: "ignore",
        stderr: "pipe",
      })
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
      return { code, err }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

/** Adds `source` to the project in `dir`, unless it's what's there. Fails with bun's last words. */
export const addPackage = (dir: string, source: string) =>
  Effect.gen(function* adding() {
    const mark = path.join(dir, ".source")
    const there = existsSync(mark) && readFileSync(mark, "utf-8") === source
    if (!there) {
      mkdirSync(dir, { recursive: true })
      const manifest = path.join(dir, "package.json")
      if (!existsSync(manifest)) {
        writeFileAtomic(manifest, '{ "private": true }\n')
      }
      const done = yield* runAdd(dir, source)
      if (done.code !== 0) {
        const last = done.err.trim().split("\n").at(-1)
        yield* Effect.fail(`Can't add ${source}: ${last ?? `bun exited ${done.code}`}`)
      }
      writeFileAtomic(mark, source)
    }
  })

export const makeHost = Effect.fnUntraced(function* making(options: HostOptions) {
  const root = path.join(options.dir, "host")
  const bin = path.join(root, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileAtomic(path.join(bin, "sb"), stub("sb"), { mode: 0o755 })
  // A script's `switch event`.
  writeFileAtomic(path.join(bin, "switch"), stub(""), { mode: 0o755 })
  const wantFile = path.join(root, "want.json")
  const machine = localMachine(root)
  const reaped = yield* machine.reap
  if (reaped > 0) {
    yield* Effect.logInfo(`Stopped ${reaped} extensions a host before left running`)
  }
  // Extensions ran in `<dir>/spurs` before extensions were renamed: their folders move, once, with
  // none of them running.
  const legacy = path.join(options.dir, "spurs")
  if (existsSync(legacy) && !existsSync(path.join(options.dir, "extensions"))) {
    renameSync(legacy, path.join(options.dir, "extensions"))
  }

  // Agent turns the core runs here, by its id for each; stopped when its link drops.
  const turnMachine = options.turns ? localMachine(path.join(root, "turns")) : null
  if (turnMachine !== null) {
    const left = yield* turnMachine.reap
    if (left > 0) {
      yield* Effect.logInfo(`Stopped ${left} agent processes a core before left running`)
    }
  }
  const guard = options.turns ? guardOf(root, options.provides) : undefined
  const turns = new Map<string, Proc>()

  const running = new Map<string, Running>()
  const wanted = new Map<string, Spec>()
  const fibers = yield* FiberMap.make<string>()
  let link: Queue.Queue<ToCore> | null = null
  let runs = Date.now()

  const emit = (m: ToCore) => {
    if (link !== null) {
      Queue.offerUnsafe(link, m)
    }
  }
  // Scripts run apart from this host and outlive it (script-host.ts), each reaching the core as
  // the credential the core gave it.
  const scripts = makeScripts({
    root,
    env: () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined),
      )
      env.SWITCH_URL = options.core
      env.SWITCH_MACHINE = options.machine
      env.PATH = `${bin}:${env.PATH ?? ""}`
      return env
    },
    emit,
  })
  yield* Effect.forkScoped(
    Effect.forever(Effect.andThen(Effect.sleep(SCRIPT_TICK_MS), Effect.sync(scripts.tick))),
  )
  // An agent's process past half this machine's memory is stopped, and the core told (runaway.ts).
  const runaway = runaways()
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.andThen(
        Effect.sleep(EVERY_MS),
        Effect.suspend(() =>
          Effect.forEach(runaway(), (m) =>
            Effect.andThen(
              Effect.logWarning(
                `Stopped ${m.command} (pid ${m.pid}) at ${Math.round(m.bytes / 2 ** 20)} MB`,
              ),
              Effect.sync(() => {
                emit(m)
              }),
            ),
          ),
        ),
      ),
    ),
  )

  const write = (r: Running, m: Json) => {
    r.proc?.write(`${JSON.stringify(m)}\n`)
  }
  const cancelOpen = (r: Running) => {
    for (const requestId of r.open) {
      write(r, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: "The core went" },
      })
    }
    r.open.clear()
  }

  const envOf = (s: Spec, folder: string) => {
    const shimmed = s.shim === "switchboard"
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (kv): kv is [string, string] =>
          kv[1] !== undefined && !(shimmed && kv[0].startsWith("SB_")),
      ),
    )
    if (shimmed) {
      const home = path.join(folder, "home")
      mkdirSync(home, { recursive: true, mode: 0o700 })
      env.SB_HOME = home
      env.SB_INSTANCE = `${s.name}@${options.machine}`
      // Some only call `sb` when it holds a credential.
      env.SB_TOKEN = "switch"
      env.SWITCH_CORE = options.core
      env.PATH = `${bin}:${env.PATH ?? ""}`
    }
    // Its mark, which all it starts inherits: what a Mac's runaway stopper knows it by (runaway.ts).
    env.SWITCH_EXTENSION = s.name
    env.SWITCH_MACHINE = options.machine
    env.SWITCH_URL = options.core
    // What this machine is to an extension: "personal" makes it the user's own laptop.
    env.SWITCH_PROVIDES = options.provides.join(",")
    // A read-only extension may also hold itself back where its tools aren't the only way out.
    if (s.readOnly === true) {
      env.SWITCH_READ_ONLY = "1"
    }
    return { ...env, ...s.env }
  }

  const fromExtension = (r: Running, line: string) => {
    const m = Option.getOrUndefined(decodeLine(line))
    if (!isJson(m)) {
      return
    }
    if (typeof m.id === "string" && m.id.startsWith(OWN) && m.method === undefined) {
      r.missed = 0
      return
    }
    const out = r.filter.outbound(m)
    if (out === null) {
      return
    }
    if (out.method === undefined && out.id !== undefined) {
      r.open.delete(out.id)
    }
    emit({ t: "rpc", extension: r.spec.name, run: r.run, message: out })
  }

  const toExtension = (extension: string, run: number, message: Json) => {
    const r = running.get(extension)
    if (r === undefined || r.run !== run || r.proc === null) {
      return
    }
    const step = r.filter.inbound(message)
    if (step.answer !== null) {
      emit({ t: "rpc", extension, run, message: step.answer })
    }
    if (step.forward !== null) {
      if (step.forward.id !== undefined && typeof step.forward.method === "string") {
        r.open.add(step.forward.id)
      }
      write(r, step.forward)
    }
  }

  /** One run, from start to exit: why it ended. */
  const once = (r: Running) =>
    Effect.gen(function* runningOnce() {
      const folder = path.join(options.dir, "extensions", r.spec.name)
      mkdirSync(folder, { recursive: true })
      const log = path.join(folder, "log")
      rotate(log)
      const pkg = r.spec.package
      let argv = r.spec.command ?? []
      let env = envOf(r.spec, folder)
      if (pkg) {
        const at = path.join(folder, "pkg")
        const added = yield* Effect.result(addPackage(at, pkg.source))
        if (added._tag === "Failure") {
          return added.failure
        }
        const installed = path.join(at, "node_modules", pkg.name)
        argv =
          pkg.main === undefined
            ? argv.map((a) => (a.startsWith("./") ? path.join(installed, a) : a))
            : [...BUN.argv, path.join(installed, pkg.main)]
        env = { ...env, ...BUN.env }
      }
      if (argv.length === 0) {
        return "No command"
      }
      const proc = yield* Effect.acquireRelease(machine.spawn(argv, { cwd: folder, env }), stop)
      runs += 1
      r.run = runs
      r.proc = proc
      r.filter = filterOf(r.spec)
      r.missed = 0
      r.open.clear()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          r.proc = null
        }),
      )
      emit({ t: "up", extension: r.spec.name, run: r.run })
      yield* Effect.forkScoped(
        Stream.fromReadableStream({ evaluate: () => proc.stderr, onError: String }).pipe(
          Stream.runForEach((chunk) =>
            Effect.promise(async () => {
              await appendFile(log, chunk)
            }),
          ),
          Effect.ignore,
        ),
      )
      yield* Effect.forkScoped(
        Stream.fromReadableStream({ evaluate: () => proc.stdout, onError: String }).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              fromExtension(r, line)
            }),
          ),
          Effect.ignore,
        ),
      )
      const exited = Effect.promise(async () => await proc.exited).pipe(
        Effect.map((code) => `Exited ${code}`),
      )
      const pings = Effect.gen(function* pinging() {
        let n = 0
        while (r.missed < MISSES) {
          yield* Effect.sleep(PING_MS)
          r.missed += 1
          n += 1
          write(r, { jsonrpc: "2.0", id: `${OWN}${n}`, method: "ping" })
        }
        return "Stopped answering"
      })
      return yield* Effect.raceFirst(exited, pings)
    })

  const keep = (s: Spec) =>
    Effect.gen(function* keeping() {
      const r: Running = {
        spec: s,
        run: 0,
        proc: null,
        filter: filterOf(s),
        missed: 0,
        open: new Set(),
      }
      running.set(s.name, r)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (running.get(s.name) === r) {
            running.delete(s.name)
          }
        }),
      )
      let failures = 0
      for (;;) {
        const started = Date.now()
        const reason = yield* Effect.scoped(once(r)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              emit({ t: "down", extension: s.name, run: r.run, reason: "Stopped" })
            }),
          ),
        )
        emit({ t: "down", extension: s.name, run: r.run, reason })
        yield* Effect.logWarning(`${s.name}: ${reason}`)
        failures = Date.now() - started > STABLE_MS ? 0 : failures + 1
        yield* Effect.sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS))
      }
    }).pipe(Effect.scoped)

  const want = (specs: readonly Spec[]) =>
    Effect.gen(function* wanting() {
      for (const [name, was] of wanted) {
        const now = specs.find((s) => s.name === name)
        if (now === undefined || !same(now, was)) {
          wanted.delete(name)
          yield* FiberMap.remove(fibers, name)
        }
        // Not run here any more: its package goes, its folder (its state) stays.
        if (now === undefined) {
          rmSync(path.join(options.dir, "extensions", name, "pkg"), {
            recursive: true,
            force: true,
          })
        }
      }
      for (const s of specs) {
        if (!wanted.has(s.name)) {
          wanted.set(s.name, s)
          yield* FiberMap.run(fibers, s.name, keep(s))
        }
      }
      writeFileAtomic(wantFile, JSON.stringify(specs))
    })

  const pump = async (id: string, from: ReadableStream<Uint8Array>, fd: 1 | 2) => {
    const decoder = new TextDecoder()
    for await (const chunk of from) {
      emit({ t: "out", id, fd, data: decoder.decode(chunk, { stream: true }) })
    }
  }

  // A turn that never started here ends as a shell's command not found does: a failure, never -1,
  // which is a link gone (remote.ts) and has the core carry the turn on as cut off by a restart.
  const NOT_STARTED = 127
  const startTurn = (m: Extract<ToHost, { t: "spawn" }>) =>
    Effect.gen(function* starting() {
      if (turnMachine === null) {
        emit({ t: "exit", id: m.id, code: NOT_STARTED })
        return
      }
      // One that can't start here (a program not on this machine, a folder that isn't) ends at
      // once, saying why: it never takes the host's ears with it.
      const spawned = yield* Effect.exit(
        turnMachine.spawn(m.argv, {
          cwd: m.cwd,
          env: m.env,
          ...(m.secret !== undefined && { secret: Redacted.make(m.secret) }),
        }),
      )
      if (Exit.isFailure(spawned)) {
        emit({ t: "out", id: m.id, fd: 2, data: `${Cause.pretty(spawned.cause)}\n` })
        emit({ t: "exit", id: m.id, code: NOT_STARTED })
        return
      }
      const p = spawned.value
      turns.set(m.id, p)
      emit({ t: "started", id: m.id, pid: p.pid })
      const out = pump(m.id, p.stdout, 1)
      const err = pump(m.id, p.stderr, 2)
      void Promise.all([p.exited, out, err]).then(([code]) => {
        turns.delete(m.id)
        emit({ t: "exit", id: m.id, code })
        return code
      })
    })

  const SIGNALS = new Set<string>(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"])

  const fsDone = (m: Extract<ToHost, { t: "fs" }>) => {
    let value: string | boolean | null = null
    if (m.op === "write") {
      const owned = m.secret === true
      mkdirSync(path.dirname(m.file), { recursive: true, ...(owned && { mode: 0o700 }) })
      writeFileAtomic(m.file, m.text ?? "", owned ? { mode: 0o600 } : {})
      value = true
    } else if (m.op === "exists") {
      value = existsSync(m.file) && statSync(m.file).size > 0
    } else if (existsSync(m.file)) {
      value = realpathSync(m.file)
    }
    emit({ t: "fsDone", id: m.id, value })
  }

  const toTurn = (m: Extract<ToHost, { t: "stdin" | "eof" | "signal" | "fs" }>) => {
    const p = turns.get(m.id)
    if (m.t === "fs") {
      try {
        fsDone(m)
      } catch {
        emit({ t: "fsDone", id: m.id, value: null })
      }
    } else if (m.t === "stdin") {
      p?.write(m.data)
    } else if (m.t === "eof") {
      p?.end()
    } else if (SIGNALS.has(m.signal)) {
      p?.kill(m.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM")
    }
  }

  const stopTurns = () => {
    const all = [...turns.values()]
    for (const p of all) {
      p.kill("SIGTERM")
    }
    setTimeout(() => {
      for (const p of all) {
        p.kill("SIGKILL")
      }
    }, STOP_GRACE_MS)
  }

  // An extension moving between machines takes its folder along (its package stays: each machine
  // adds its own). Packed here once it's stopped, unpacked there before it starts; what was there
  // before is set aside in `.replaced`, never deleted.
  const extensionsDir = path.join(options.dir, "extensions")
  const pack = async (m: Extract<ToHost, { t: "pack" }>) => {
    const folder = path.join(extensionsDir, m.extension)
    if (!existsSync(folder)) {
      emit({ t: "packed", id: m.id, data: "", done: true, ok: false })
      return
    }
    const p = Bun.spawn(["tar", "-czf", "-", "--exclude", "./pkg", "-C", folder, "."], {
      stdout: "pipe",
      stderr: "ignore",
    })
    for await (const chunk of p.stdout) {
      emit({
        t: "packed",
        id: m.id,
        data: Buffer.from(chunk).toString("base64"),
        done: false,
        ok: true,
      })
    }
    emit({ t: "packed", id: m.id, data: "", done: true, ok: (await p.exited) === 0 })
  }
  const unpacked = async (m: Extract<ToHost, { t: "unpack" }>, file: string) => {
    const into = path.join(extensionsDir, `.incoming-${m.id}`)
    let ok = m.ok && existsSync(file)
    if (ok) {
      mkdirSync(into, { recursive: true })
      const p = Bun.spawn(["tar", "-xzf", file, "-C", into], { stdout: "ignore", stderr: "ignore" })
      ok = (await p.exited) === 0
    }
    if (ok && !wanted.has(m.extension)) {
      const folder = path.join(extensionsDir, m.extension)
      if (existsSync(folder)) {
        const aside = path.join(extensionsDir, ".replaced", `${m.extension}-${Date.now()}`)
        mkdirSync(path.dirname(aside), { recursive: true })
        renameSync(folder, aside)
      }
      renameSync(into, folder)
    } else {
      ok = false
    }
    rmSync(into, { recursive: true, force: true })
    rmSync(file, { force: true })
    emit({ t: "unpacked", id: m.id, ok })
  }
  /** Carries a piece failed to write: the folder there stays as it is. */
  const broken = new Set<string>()
  const unpack = (m: Extract<ToHost, { t: "unpack" }>) => {
    const file = path.join(extensionsDir, `.incoming-${m.id}.tgz`)
    try {
      mkdirSync(extensionsDir, { recursive: true })
      appendFileSync(file, Buffer.from(m.data, "base64"))
    } catch {
      broken.add(m.id)
    }
    if (m.done) {
      const whole = !broken.delete(m.id)
      void unpacked({ ...m, ok: m.ok && whole }, file).catch(() => {
        emit({ t: "unpacked", id: m.id, ok: false })
      })
    }
  }

  const inbox = yield* Queue.unbounded<ToHost>()
  const handle = (m: ToHost) => {
    if (m.t === "want") {
      return want(m.extensions)
    }
    if (m.t === "spawn") {
      return startTurn(m)
    }
    return Effect.sync(() => {
      if (m.t === "stdin" || m.t === "eof" || m.t === "signal" || m.t === "fs") {
        toTurn(m)
      } else if (m.t === "rpc") {
        toExtension(m.extension, m.run, m.message)
      } else if (m.t === "close") {
        const r = running.get(m.extension)
        if (r !== undefined && r.run === m.run) {
          cancelOpen(r)
        }
      } else if (m.t === "scripts") {
        scripts.want(m.scripts)
      } else if (m.t === "tail") {
        emit({ t: "tailed", id: m.id, text: scripts.tail(m.script, m.lines) })
      } else if (m.t === "pack") {
        void pack(m).catch(() => {
          emit({ t: "packed", id: m.id, data: "", done: true, ok: false })
        })
      } else if (m.t === "unpack") {
        unpack(m)
      }
    })
  }
  // Each message from the core on its own: one that fails is logged, and the host hears the next.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(inbox), (m) =>
        handle(m).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`The core's ${m.t} failed`, cause)),
        ),
      ),
    ),
  )

  // What the core last wanted runs now, before it's reached.
  // One that won't read is no list: nothing runs until the core says what.
  if (existsSync(wantFile)) {
    const last = decodeWant(readFileSync(wantFile, "utf-8"))
    yield* Option.isSome(last)
      ? want(last.value)
      : Effect.logWarning(`Unreadable ${wantFile}: waiting for the core`)
  }

  const connect = Effect.gen(function* connecting() {
    const q = yield* Queue.unbounded<ToCore>()
    link = q
    Queue.offerUnsafe(q, {
      t: "hello",
      machine: options.machine,
      os: options.os,
      ...(RELEASE !== null && { target: TARGET }),
      provides: [...options.provides],
      ...(options.turns && {
        turns: {
          home: homedir(),
          dir: options.dir,
          env: Object.fromEntries(
            Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined),
          ),
          // A token login's token stays in this machine's Keychain: only signed-in logins go.
          logins: options.turns.logins
            .filter((l) => l.keychain === undefined)
            .map((l) => ({
              id: l.id,
              ...(l.provider && { provider: l.provider }),
              ...(l.configDir !== undefined && { configDir: l.configDir }),
              ...(l.acp === undefined ? {} : { acp: l.acp }),
            })),
          ...(guard && { guard }),
        },
      }),
    })
    for (const r of running.values()) {
      if (r.proc !== null) {
        Queue.offerUnsafe(q, { t: "up", extension: r.spec.name, run: r.run })
      }
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (link === q) {
          link = null
        }
        for (const r of running.values()) {
          cancelOpen(r)
        }
        // Nothing reads them now: the core carries them on from the record.
        stopTurns()
      }).pipe(Effect.andThen(Queue.shutdown(q))),
    )
    const session: Link = {
      send: (m) => {
        Queue.offerUnsafe(inbox, m)
      },
      receive: Stream.fromQueue(q),
    }
    return session
  })

  const shape: HostShape = { connect }
  return shape
})

const text = new TextDecoder()

/**
 * One link to the core at `url`, until it drops. `linked` is set once the core answers. True when
 * this host took another release in its place (release.ts), the core's before it said anything to
 * it or the next one as the deploy puts it in: it exits.
 */
const link1 = (host: HostShape, url: string, linked: { at: number | null }) =>
  Effect.scoped(
    Effect.gen(function* dialing() {
      const socket = yield* Socket.makeWebSocket(url)
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      const first = yield* reader.pull.pipe(Effect.timeoutOption(RELEASE_WAIT_MS))
      if (Option.isSome(first)) {
        linked.at = Date.now()
      }
      const early: ToHost[] = []
      for (const frame of Option.getOrElse(first, () => [])) {
        const m = decodeToHost(typeof frame === "string" ? frame : text.decode(frame))
        if (Option.isNone(m) || m.value.t === "beat") {
          continue
        }
        if (m.value.t !== "release") {
          early.push(m.value)
        } else if (yield* takeRelease(url, m.value)) {
          return true
        }
      }
      const session = yield* host.connect
      for (const m of early) {
        session.send(m)
      }
      let heard = Date.now()
      const out = session.receive.pipe(Stream.runForEach((m) => writer.write(JSON.stringify(m))))
      // Until the link drops, or the release going in is swapped in here (true).
      const inbound = Effect.gen(function* hearing() {
        for (;;) {
          const frames = yield* reader.pull
          heard = Date.now()
          linked.at ??= heard
          for (const frame of frames) {
            const m = decodeToHost(typeof frame === "string" ? frame : text.decode(frame))
            if (Option.isNone(m) || m.value.t === "beat") {
              continue
            }
            if (m.value.t !== "next") {
              session.send(m.value)
            } else if (yield* takeNext(url, m.value)) {
              return true
            }
          }
        }
      })
      const beats = Effect.gen(function* beating() {
        let announced = false
        for (;;) {
          yield* writer.write(JSON.stringify({ t: "beat" }))
          yield* Effect.sleep(BEAT_MS)
          if (Date.now() - heard > SILENT_MS) {
            return yield* Effect.fail(linked.at === null ? "No answer" : "The core went quiet")
          }
          if (linked.at !== null && !announced) {
            announced = true
            yield* Effect.logInfo("Reached the core")
          }
        }
      })
      const ended = yield* Effect.raceFirst(out, Effect.raceFirst(inbound, beats))
      return ended === true
    }),
  ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))

/** Equal jitter on a doubling ceiling, as T3's supervisor waits between failed attempts. */
const retryMs = (failures: number) => {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures)
  return Math.round(ceiling / 2 + (ceiling / 2) * Math.random())
}

/**
 * Keeps a link to the core (`ws://…/hosts`, its credential in the address): a link that held drops
 * into a retry at once; attempts that fail back off with jitter to half a minute. The address is
 * asked for each time, so a lost credential is renewed. Ends once the host has taken the core's
 * release in place of its own.
 */
export const dial = <E, R>(host: HostShape, address: Effect.Effect<string, E, R>) =>
  Effect.gen(function* keeping() {
    let failures = 0
    for (;;) {
      const url = yield* address
      const shown = url.replace(/token=[^&]+/u, "token=…")
      const linked: { at: number | null } = { at: null }
      const taken = yield* link1(host, url, linked).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Core at ${shown}`, cause).pipe(Effect.as(false)),
        ),
      )
      if (taken) {
        return
      }
      const held = linked.at !== null && Date.now() - linked.at > LINKED_MS
      failures = held ? 0 : failures + 1
      yield* Effect.sleep(
        held ? Math.round(LOST_RETRY_MS * (0.5 + Math.random() / 2)) : retryMs(failures),
      )
    }
  })
