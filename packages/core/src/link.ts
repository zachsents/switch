import { InstalledAgent } from "@switch/agent/acp-install"
// What a machine's extension host and the core say to each other: one WebSocket per host
// (`/hosts`), or a pair of queues for the host inside the core. An extension's MCP messages ride it
// whole, tagged with its run, one per time it was started, so nothing meant for one run reaches the
// next. Agent turns the core places on another machine run there as processes the host starts,
// their stdio relayed here, as T3 Code runs a thread in a remote environment's own server.
import { SUBSCRIPTIONS } from "@switch/models"
import { Schema } from "effect"
import type { Stream } from "effect"

export const spec = Schema.Struct({
  name: Schema.String,
  /** Run from the extension's folder. */
  command: Schema.optionalKey(Schema.Array(Schema.String)),
  /** An installed package instead: added from `source`; its `main` run with bun, else `command`. */
  package: Schema.optionalKey(
    Schema.Struct({
      source: Schema.String,
      name: Schema.String,
      main: Schema.optionalKey(Schema.String),
    }),
  ),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** A Switchboard appendage, made an extension. */
  shim: Schema.optionalKey(Schema.Literal("switchboard")),
  /** Only the tools that only look. */
  readOnly: Schema.optionalKey(Schema.Boolean),
})
/** How a host runs an extension. */
export type Spec = typeof spec.Type

/** A script a host runs apart from itself (scripts.ts): set anew, a new `gen`. */
export const scriptSpec = Schema.Struct({
  id: Schema.String,
  gen: Schema.Number,
  name: Schema.String,
  run: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  /** It ended on its own: its log is kept, and it isn't run again. */
  ended: Schema.optionalKey(Schema.Boolean),
  /** This run's pid as last reported, once it was started. */
  pid: Schema.optionalKey(Schema.Number),
  /** Times this run was started again after a stop. */
  restarts: Schema.optionalKey(Schema.Number),
})
export type ScriptSpec = typeof scriptSpec.Type

const message = Schema.Record(Schema.String, Schema.Unknown)
/** Part of an extension's folder as a gzipped tar, base64; the last says whether all of it came. */
const piece = { data: Schema.String, done: Schema.Boolean, ok: Schema.Boolean }
const at = { extension: Schema.String, run: Schema.Number }

// Agent turns the core runs on this host's machine: each process by the core's id for it.
const proc = { id: Schema.String }
const fsOp = Schema.Literals(["write", "exists", "realpath"])

const toHost = Schema.Union([
  /** Everything this host should run; anything else it stops. */
  Schema.Struct({ t: Schema.Literal("want"), extensions: Schema.Array(spec) }),
  /** Every script this host should run or keep the log of; any other it stops and clears. */
  Schema.Struct({ t: Schema.Literal("scripts"), scripts: Schema.Array(scriptSpec) }),
  /** A script's last lines of output, answered by `tailed` with the same id. */
  Schema.Struct({
    t: Schema.Literal("tail"),
    id: Schema.String,
    script: Schema.String,
    lines: Schema.Number,
  }),
  Schema.Struct({ t: Schema.Literal("rpc"), ...at, message }),
  /** An extension moving away: its folder, stopped already, sent back in `packed` pieces. */
  Schema.Struct({ t: Schema.Literal("pack"), id: Schema.String, extension: Schema.String }),
  /** An extension moving here: its folder in pieces, in place of what's here once `done`. */
  Schema.Struct({
    t: Schema.Literal("unpack"),
    id: Schema.String,
    extension: Schema.String,
    ...piece,
  }),
  /** The core is done with this run's session: what it asked is cancelled. */
  Schema.Struct({ t: Schema.Literal("close"), ...at }),
  Schema.Struct({ t: Schema.Literal("beat") }),
  /**
   * Said first on every link: the core's release (null in dev), and each target's build it carries,
   * by its SHA-256 (null: a signed bundle, checked by its signature). release.ts.
   */
  Schema.Struct({
    t: Schema.Literal("release"),
    release: Schema.NullOr(Schema.String),
    builds: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
  /** A release on its way, its builds as `release`'s: fetched ahead; `now`, it's going in. */
  Schema.Struct({
    t: Schema.Literal("next"),
    release: Schema.String,
    builds: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
    now: Schema.Boolean,
  }),
  Schema.Struct({
    t: Schema.Literal("spawn"),
    ...proc,
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
    /** A login's token, read once by the process on fd 3: never in its environment or arguments. */
    secret: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ t: Schema.Literal("stdin"), ...proc, data: Schema.String }),
  Schema.Struct({ t: Schema.Literal("eof"), ...proc }),
  Schema.Struct({ t: Schema.Literal("signal"), ...proc, signal: Schema.String }),
  Schema.Struct({
    t: Schema.Literal("fs"),
    ...proc,
    op: fsOp,
    file: Schema.String,
    text: Schema.optionalKey(Schema.String),
    /** A write only its owner reads. */
    secret: Schema.optionalKey(Schema.Boolean),
  }),
])
export type ToHost = typeof toHost.Type

/** A login on the host's machine that can take turns. */
export const login = Schema.Struct({
  id: Schema.String,
  provider: Schema.optionalKey(Schema.Literals(SUBSCRIPTIONS)),
  configDir: Schema.optionalKey(Schema.String),
  acp: Schema.optionalKey(InstalledAgent),
})

const toCore = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("hello"),
    machine: Schema.String,
    os: Schema.String,
    /** What its build is for, as release.ts's TARGET: a release carries a build for each. */
    target: Schema.optionalKey(Schema.String),
    provides: Schema.Array(Schema.String),
    /** Turns it can run: its home, environment, logins and, on the user's laptop, its guard. */
    turns: Schema.optionalKey(
      Schema.Struct({
        home: Schema.String,
        /** Its state folder, where accounts lent to it keep their homes. */
        dir: Schema.optionalKey(Schema.String),
        env: Schema.Record(Schema.String, Schema.String),
        logins: Schema.Array(login),
        guard: Schema.optionalKey(
          Schema.Struct({ hook: Schema.String, bin: Schema.String, envFile: Schema.String }),
        ),
      }),
    ),
  }),
  Schema.Struct({ t: Schema.Literal("up"), ...at }),
  Schema.Struct({ t: Schema.Literal("down"), ...at, reason: Schema.String }),
  Schema.Struct({ t: Schema.Literal("rpc"), ...at, message }),
  Schema.Struct({ t: Schema.Literal("beat") }),
  Schema.Struct({ t: Schema.Literal("started"), ...proc, pid: Schema.Number }),
  Schema.Struct({
    t: Schema.Literal("out"),
    ...proc,
    fd: Schema.Literals([1, 2]),
    data: Schema.String,
  }),
  Schema.Struct({ t: Schema.Literal("exit"), ...proc, code: Schema.Number }),
  /** Where a script stands: running as `pid`, started again `restarts` times; ended with `code`. */
  Schema.Struct({
    t: Schema.Literal("script"),
    id: Schema.String,
    gen: Schema.Number,
    pid: Schema.Number,
    restarts: Schema.Number,
    code: Schema.optionalKey(Schema.Number),
    tail: Schema.optionalKey(Schema.String),
  }),
  /** A process of an agent's it stopped for outgrowing half its machine's memory (runaway.ts). */
  Schema.Struct({
    t: Schema.Literal("runaway"),
    pid: Schema.Number,
    command: Schema.String,
    /** Its footprint when stopped, and the machine's memory, in bytes. */
    bytes: Schema.Number,
    total: Schema.Number,
    /** How long it ran, in seconds. */
    ran: Schema.Number,
    /** Its marks: the work it ran for, or the extension. */
    work: Schema.optionalKey(Schema.String),
    extension: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ t: Schema.Literal("packed"), id: Schema.String, ...piece }),
  Schema.Struct({ t: Schema.Literal("unpacked"), id: Schema.String, ok: Schema.Boolean }),
  Schema.Struct({
    t: Schema.Literal("tailed"),
    id: Schema.String,
    text: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("fsDone"),
    ...proc,
    value: Schema.Union([Schema.String, Schema.Boolean, Schema.Null]),
  }),
])
export type ToCore = typeof toCore.Type

export const decodeToHost = Schema.decodeUnknownOption(Schema.fromJsonString(toHost))
export const decodeToCore = Schema.decodeUnknownOption(Schema.fromJsonString(toCore))

/**
 * A link heard nothing from this long is dead, on either end: Switchboard's bound, its core's and
 * its clients' alike (crates/core/src/ws.rs `SILENT_FOR`, crates/sb/src/client.rs).
 */
export const SILENT_MS = 75_000

/** One host's link, as the core holds it. */
export interface Link {
  readonly send: (m: ToHost) => void
  readonly receive: Stream.Stream<ToCore>
}
