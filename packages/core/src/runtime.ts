// The core's side of the extension hosts. Each machine's host links in (`/hosts`; the core's own
// machine through the host inside it) and says what it provides. Placement, brain state, says which
// machine runs each extension: the core tells every host its list and puts each running extension
// on the gateway, its MCP relayed over the link. An extension never placed goes to the first
// machine with what it needs. Extensions are installed from a git URL or package name: added once
// here, in a folder dropped after, to read its manifest and pin its version (as T3 Code's clone
// tracker drops a partial checkout); then each host running it adds the pinned source itself.
//
// A host whose link ends isn't gone until it's been silent as long as a dead link (SILENT_MS): its
// extensions stay placed and listed, their calls waiting, and a host that links again in time (a
// restart, a dropped connection) is as if it never left. As Switchboard's presence: a link is
// online until it's gone, and a core's restart records nothing (crates/core/src/ws.rs). The log
// says when an extension's run comes up or goes down only when that changes.
import { parseJSONRPCMessage } from "@modelcontextprotocol/server"
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server"
import type { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  Brain,
  EventId,
  installedExtensions,
  InstallExtension,
  knownExtensions,
  lacking,
  machines as knownMachines,
  PlaceExtension,
  Rejected,
  RemoveExtension,
  ReportMachine,
  ExtensionPlaced,
  extensionPlacements,
  ExtensionInstalled,
  ExtensionRemoved,
  ExtensionUpdated,
  UpdateExtension,
} from "@switch/brain"
import type { Installed } from "@switch/brain"
import { Hosts, hostsOf, Sessions } from "@switch/agent"
import { Gateway, inProcess } from "@switch/gateway"
import type { Plug } from "@switch/gateway"
import { defineApp, readManifest, tool } from "switch-ext-kit"
import type { Json } from "switch-ext-kit"
import { Context, Effect, FiberMap, Layer, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import type { Socket } from "effect/socket"

import { CoreConfig } from "./config.ts"
import type { App, ExtensionOptions } from "./config.ts"
import { CredentialIssued, extensionToken, generations } from "./credentials.ts"
import { addPackage } from "./host.ts"
import { decodeToCore, SILENT_MS } from "./link.ts"
import { ExtensionDown, ExtensionUp } from "./extension-runs.ts"
import type { Link, Spec, ToCore, ToHost } from "./link.ts"
import { packFolder } from "./pack.ts"
import { buildsOf, noteTarget, RELEASE_NAME, releaseOf } from "./release.ts"
import { remoteMachine } from "./remote.ts"
import { stoppedRunaway } from "./runaway.ts"
import type { Remote } from "./remote.ts"
import { reported, ScriptEnded, ScriptRetired, ScriptSet, scriptsFor } from "./scripts.ts"

interface Session {
  readonly run: number
  readonly transport: Transport
  /** Ends it: `tell` asks the host to cancel what it asked. */
  readonly end: (tell: boolean) => void
}

interface Connected {
  readonly machine: string
  readonly provides: readonly string[]
  readonly link: Link
  /** Each running extension's current run. */
  readonly runs: Map<string, number>
  readonly sessions: Map<string, Session>
  /** The placed extensions it was last told to run. */
  readonly sent: Set<string>
}

/** An extension's folder on its way from one host to another, by the carry's id. */
interface Carry {
  readonly extension: string
  readonly from: Connected
  readonly to: Connected
  /** When a piece last came: a host that says nothing for CARRY_QUIET_MS has let it drop. */
  heard: number
  readonly done: (ok: boolean) => void
}

const CARRY_QUIET_MS = 60_000
/** What the host it goes to has to unpack it in, once the last piece is sent. */
const UNPACK_MS = 10 * 60_000

interface Waiter {
  readonly machine: string
  readonly extension: string
  readonly done: (found: { readonly host: Connected; readonly run: number }) => void
}

export interface MachineView {
  readonly machine: string
  readonly os: string
  readonly provides: readonly string[]
  readonly online: boolean
  readonly extensions: readonly { readonly name: string; readonly running: boolean }[]
}

export class Runtime extends Context.Service<
  Runtime,
  {
    /** Serves one host's link until it ends. */
    readonly serve: (link: Link) => Effect.Effect<void>
    readonly machines: Effect.Effect<{
      readonly machines: readonly MachineView[]
      readonly installed: readonly Installed[]
      readonly unplaced: readonly { readonly name: string; readonly needs: readonly string[] }[]
    }>
    readonly install: (
      from: string,
      machine?: string,
      folder?: string,
    ) => Effect.Effect<Installed, Rejected>
    readonly update: (extension: string) => Effect.Effect<Installed, Rejected>
    readonly place: (extension: string, machine: string) => Effect.Effect<number, Rejected>
    readonly remove: (extension: string) => Effect.Effect<number, Rejected>
    /** An extension that dials in (a client), speaking MCP over `transport` until it closes. */
    readonly dialed: (name: string, transport: Transport) => Effect.Effect<void>
    /** A script's last lines of output, from the host on `machine`: null when it's offline. */
    readonly tail: (machine: string, script: string, lines: number) => Effect.Effect<string | null>
    /** Said to every host linked: how many. */
    readonly tell: (m: ToHost) => Effect.Effect<number>
  }
>()("switch/Runtime") {}

/** An extension the runtime can run: configured with a command, or installed. */
interface Runnable {
  readonly spec: Spec
  readonly needs: readonly string[]
  /** It runs on every machine with what it needs, as `<name>-<machine>`, never placed. */
  readonly every: boolean
}

const fromConfig = ({ needs, every, ...spec }: App): Runnable => ({
  spec,
  needs: needs ?? [],
  every: every === true,
})

const fromInstalled = (i: Installed, o: ExtensionOptions = {}): Runnable => ({
  spec: {
    ...(o.readOnly === true && { readOnly: true }),
    ...(o.env && { env: { ...o.env } }),
    name: i.extension,
    package: {
      source: i.source,
      name: i.package,
      ...(i.manifest.main !== undefined && { main: i.manifest.main }),
      ...(i.path !== undefined && { from: i.from, path: i.path }),
    },
    ...(i.manifest.command && { command: i.manifest.command }),
    ...(i.manifest.shim && { shim: i.manifest.shim }),
  },
  needs: i.manifest.needs ?? [],
  every: i.manifest.every === true,
})

/** An extension that runs on every machine with what it needs is named for each: `macos-<machine>`. */
const instanceOf = (extension: string, machine: string) => `${extension}-${machine}`

const fits = (a: Runnable, provides: readonly string[]) => lacking(a.needs, provides).length === 0

const command = (type: string, payload: unknown, source: string) =>
  Effect.gen(function* commanding() {
    const brain = yield* Brain
    const receipt = yield* brain.dispatch({ id: crypto.randomUUID(), type, source, payload })
    return receipt.seq
  })

const logRejected = <A, R>(e: Effect.Effect<A, Rejected, R>) =>
  e.pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))

const toJson = (m: JSONRPCMessage): Json => ({ ...m })

/** Where the log left each extension on each machine: its last `extension.up` or `.down`. */
const lastRuns = (db: Database) =>
  db
    .query<{ type: string; extension: string; machine: string }, []>(
      `SELECT replace(type, 'spur.', 'extension.') AS type,
         coalesce(json_extract(payload, '$.extension'), json_extract(payload, '$.spur')) AS extension,
         json_extract(payload, '$.machine') AS machine, max(seq)
       FROM events WHERE type IN ('extension.up', 'extension.down', 'spur.up', 'spur.down')
       GROUP BY 2, 3`,
    )
    .all()

const decodeDeps = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
  ),
)

/** What bun.lock pinned `name` to: `name@github:owner/repo#sha` or `name@1.2.3`. */
const pinnedIn = (lock: string, name: string) => {
  const at = lock.indexOf(`"${name}": ["`)
  const start = at + name.length + 6
  const pinned = lock.slice(start, lock.indexOf('"', start))
  return at === -1 || pinned === "" ? undefined : pinned
}

/**
 * Adds `from` (with `folder`, that folder of it packed) in a folder of its own under `dir`, removed
 * after: its package, manifest, version (with the commit, from git) and the source pinned to it.
 */
export const fetchExtension = (dir: string, from: string, folder?: string) =>
  Effect.scoped(
    Effect.gen(function* fetching() {
      const at = path.join(dir, "fetch", crypto.randomUUID())
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          mkdirSync(at, { recursive: true })
          writeFileSync(path.join(at, "package.json"), '{ "private": true }\n')
        }),
        () =>
          Effect.sync(() => {
            rmSync(at, { recursive: true, force: true })
          }),
      )
      const packed =
        folder === undefined
          ? null
          : yield* packFolder(dir, from, folder).pipe(
              Effect.mapError((reason) => new Rejected({ reason })),
            )
      yield* addPackage(at, packed?.pack ?? from).pipe(
        Effect.mapError((reason) => new Rejected({ reason })),
      )
      const deps = Option.getOrUndefined(
        decodeDeps(readFileSync(path.join(at, "package.json"), "utf-8")),
      )
      const [name] = Object.keys(deps?.dependencies ?? {})
      if (name === undefined) {
        return yield* Effect.fail(new Rejected({ reason: `Nothing in ${from}` }))
      }
      const read = readManifest(path.join(at, "node_modules", name))
      if ("error" in read) {
        return yield* Effect.fail(new Rejected({ reason: `${from}: ${read.error}` }))
      }
      // Every extension promises how often it says how it is, and is held to it (senses.ts), as a
      // Switchboard appendage promised at install (keeper/report.rs:1-8, sb/main.rs:1197).
      if (read.manifest.heartbeat === undefined) {
        return yield* Effect.fail(
          new Rejected({
            reason: `${from}: no heartbeat in its manifest (how often, at most ms apart, its heartbeats come)`,
          }),
        )
      }
      const pinned =
        pinnedIn(readFileSync(path.join(at, "bun.lock"), "utf-8"), name) ?? packed?.pack ?? from
      const commit = pinned.includes("#") ? pinned.slice(pinned.lastIndexOf("#")) : ""
      const found: Installed = {
        extension: read.manifest.name,
        from,
        ...(folder !== undefined && { path: folder }),
        source: pinned,
        package: read.package,
        version: `${read.version}${packed ? `#${packed.commit.slice(0, 7)}` : commit}`,
        manifest: read.manifest,
      }
      return found
    }),
  )

const runtimeApp = defineApp<Runtime>({
  name: "extensions",
  version: "1",
  instructions:
    "Extensions: installing them from a git URL or package name, and which machine runs each.",
  tools: [
    tool(
      "list",
      {
        description:
          "Installed extensions (source, version, manifest), and each machine: what it provides, whether it's online, its extensions and which run.",
        readOnly: true,
      },
      () =>
        Effect.gen(function* viewing() {
          const r = yield* Runtime
          return yield* r.machines
        }),
    ),
    tool(
      "install",
      {
        description:
          "Install an extension from a git URL (github:owner/repo, https://…, #commit to pin) or package name; an installed one moves to it. `path`: a folder of a monorepo `source`, installed alone. It runs on `machine`, else the first machine with what it needs.",
        input: Schema.Struct({
          source: Schema.String,
          path: Schema.optionalKey(Schema.String),
          machine: Schema.optionalKey(Schema.String),
        }),
      },
      (input) =>
        Effect.gen(function* installing() {
          const r = yield* Runtime
          return yield* r.install(input.source, input.machine, input.path)
        }),
    ),
    tool(
      "update",
      {
        description: "Update an extension to the latest of where it was installed from.",
        input: Schema.Struct({ extension: Schema.String }),
      },
      (input) =>
        Effect.gen(function* updating() {
          const r = yield* Runtime
          return yield* r.update(input.extension)
        }),
    ),
    tool(
      "remove",
      {
        description: "Uninstall an extension: stopped everywhere, its package removed.",
        input: Schema.Struct({ extension: Schema.String }),
      },
      (input) =>
        Effect.gen(function* removing() {
          const r = yield* Runtime
          return { seq: yield* r.remove(input.extension) }
        }),
    ),
    tool(
      "place",
      {
        description: "Run an extension on a machine instead of where it runs now.",
        input: Schema.Struct({ extension: Schema.String, machine: Schema.String }),
      },
      (input) =>
        Effect.gen(function* placing() {
          const r = yield* Runtime
          return { seq: yield* r.place(input.extension, input.machine) }
        }),
    ),
  ],
})

export const runtimeLayer = (options: {
  readonly apps: readonly App[]
  readonly extensionOptions: Readonly<Record<string, ExtensionOptions>>
  readonly dir: string
  /** The core's own machine: its turns run in this process, never over a link. */
  readonly machine: string
  /** Whether other machines' hosts take turns: the core listens beyond this machine. */
  readonly away: boolean
  /** The core sends nothing: every extension runs read-only, installed ones too. */
  readonly readOnly?: boolean
  /** Off: no extension runs at all. */
  readonly extensions: boolean
}) =>
  Layer.effect(
    Runtime,
    Effect.gen(function* making() {
      const brain = yield* Brain
      const gateway = yield* Gateway
      const turnHosts = yield* Hosts
      const sessions = yield* Sessions
      const hosts = new Map<string, Connected>()
      const waiters = new Set<Waiter>()
      /** Each host whose link ended, by machine: its "host gone", unless it links again first. */
      const leaving = yield* FiberMap.make<string>()
      /** What the log last said of each extension's run on each machine, by `machine/extension`. */
      const said = new Map(
        (yield* brain.read(lastRuns)).map((r) => [`${r.machine}/${r.extension}`, r.type]),
      )
      const plugs = yield* FiberMap.make<string>()
      const plugged = new Map<string, string>()
      const lock = Semaphore.makeUnsafe(1)
      const configured = options.apps.map(fromConfig)

      /** Everything it can run: configured, then installed. */
      const catalog = options.extensions
        ? brain
            .read(installedExtensions)
            .pipe(
              Effect.map((installed) => [
                ...configured,
                ...installed.map((i) => fromInstalled(i, options.extensionOptions[i.extension])),
              ]),
            )
        : Effect.succeed([])

      const wake = () => {
        for (const w of waiters) {
          const host = hosts.get(w.machine)
          const run = host?.runs.get(w.extension)
          if (host !== undefined && run !== undefined) {
            waiters.delete(w)
            w.done({ host, run })
          }
        }
      }

      const runOf = (machine: string, extension: string) =>
        Effect.callback<{ readonly host: Connected; readonly run: number }>((resume) => {
          const w: Waiter = {
            machine,
            extension,
            done: (found) => {
              resume(Effect.succeed(found))
            },
          }
          waiters.add(w)
          wake()
          return Effect.sync(() => {
            waiters.delete(w)
          })
        })

      /** An extension on a machine, for the gateway: each session is one run, waited for. */
      const remote = (machine: string, extension: string, name = extension): Plug => ({
        name,
        transport: Effect.gen(function* linking() {
          let { host, run } = yield* runOf(machine, extension)
          // The run it waited for may have stopped before this resumed: the session takes the one up now.
          while (host.runs.get(extension) !== run) {
            ;({ host, run } = yield* runOf(machine, extension))
          }
          let ended = false
          const transport: Transport = {
            start: async () => {
              await Promise.resolve()
            },
            send: async (message) => {
              host.link.send({ t: "rpc", extension, run, message: toJson(message) })
              await Promise.resolve()
            },
            close: async () => {
              session.end(true)
              await Promise.resolve()
            },
          }
          const session: Session = {
            run,
            transport,
            end: (tell) => {
              if (ended) {
                return
              }
              ended = true
              if (host.sessions.get(extension) === session) {
                host.sessions.delete(extension)
              }
              if (tell) {
                host.link.send({ t: "close", extension, run })
              }
              transport.onclose?.()
            },
          }
          host.sessions.get(extension)?.end(true)
          host.sessions.set(extension, session)
          return transport
        }),
      })

      const carries = new Map<string, Carry>()
      /** Carries `extension`'s folder from one host to the other: whether all of it got there. */
      const carry = (extension: string, from: Connected, to: Connected) =>
        Effect.gen(function* carrying() {
          const id = crypto.randomUUID()
          const ok = yield* Effect.callback<boolean>((resume) => {
            const quiet = setInterval(() => {
              if (Date.now() - (carries.get(id)?.heard ?? 0) > CARRY_QUIET_MS) {
                carries.get(id)?.done(false)
              }
            }, 5000)
            carries.set(id, {
              extension,
              from,
              to,
              heard: Date.now(),
              done: (v) => {
                clearInterval(quiet)
                carries.delete(id)
                resume(Effect.succeed(v))
              },
            })
            from.link.send({ t: "pack", id, extension })
          })
          yield* ok
            ? Effect.logInfo(`${extension}: its folder moved from ${from.machine} to ${to.machine}`)
            : Effect.logWarning(`${extension}: its folder stayed on ${from.machine}`)
        })

      const reconcile = lock.withPermit(
        Effect.gen(function* reconciling() {
          const where = new Map(
            (yield* brain.read(extensionPlacements)).map((p) => [p.extension, p.machine]),
          )
          const all = yield* catalog
          const generation = yield* brain.read(generations)
          const sendWants = (held: ReadonlySet<string>) => {
            for (const host of hosts.values()) {
              const extensions = all.filter((a) =>
                a.every
                  ? fits(a, host.provides)
                  : where.get(a.spec.name) === host.machine && !held.has(a.spec.name),
              )
              host.sent.clear()
              for (const a of extensions.filter((x) => !x.every)) {
                host.sent.add(a.spec.name)
              }
              // Each extension reaches the core with its own token, as the name it runs under.
              host.link.send({
                t: "want",
                extensions: extensions.map((a) => {
                  const name = a.every ? instanceOf(a.spec.name, host.machine) : a.spec.name
                  return {
                    ...a.spec,
                    ...(options.readOnly === true && { readOnly: true }),
                    env: {
                      ...a.spec.env,
                      SWITCH_TOKEN: extensionToken(options.dir, name, generation.get(name) ?? 0),
                    },
                  }
                }),
              })
            }
          }
          // One placed elsewhere than the online host running it moves with its folder: stopped
          // everywhere, carried over, then started there.
          const moves = all.flatMap((a) => {
            const to = hosts.get(where.get(a.spec.name) ?? "")
            const from = [...hosts.values()].find((h) => h !== to && h.sent.has(a.spec.name))
            return !a.every && to !== undefined && from !== undefined
              ? [{ extension: a.spec.name, from, to }]
              : []
          })
          if (moves.length > 0) {
            sendWants(new Set(moves.map((m) => m.extension)))
            for (const m of moves) {
              yield* carry(m.extension, m.from, m.to)
            }
          }
          sendWants(new Set())
          const names = new Set(
            all.flatMap((a) =>
              a.every
                ? [...hosts.values()]
                    .filter((h) => fits(a, h.provides))
                    .map((h) => instanceOf(a.spec.name, h.machine))
                : [a.spec.name],
            ),
          )
          for (const name of plugged.keys()) {
            if (!names.has(name)) {
              plugged.delete(name)
              yield* FiberMap.remove(plugs, name)
            }
          }
          for (const a of all.filter((x) => x.every)) {
            for (const host of hosts.values()) {
              const name = instanceOf(a.spec.name, host.machine)
              if (names.has(name) && !plugged.has(name)) {
                plugged.set(name, host.machine)
                yield* FiberMap.run(
                  plugs,
                  name,
                  gateway.keep(remote(host.machine, a.spec.name, name)),
                )
              }
            }
          }
          for (const a of all.filter((x) => !x.every)) {
            const { name } = a.spec
            const machine = where.get(name)
            const target = machine !== undefined && hosts.has(machine) ? machine : undefined
            if (plugged.get(name) === target) {
              continue
            }
            if (target === undefined) {
              plugged.delete(name)
              yield* FiberMap.remove(plugs, name)
            } else {
              plugged.set(name, target)
              yield* FiberMap.run(plugs, name, gateway.keep(remote(target, name)))
            }
          }
        }),
      )

      /** Each host's scripts, whenever one is set, retired or ends (not in a canary). */
      const sendScripts = (only?: Connected) =>
        Effect.gen(function* sending() {
          if (!options.extensions) {
            return
          }
          for (const host of only === undefined ? hosts.values() : [only]) {
            const list = yield* brain.read((db) => scriptsFor(db, host.machine, options.dir))
            host.link.send({ t: "scripts", scripts: list })
          }
        })

      // Tails asked of hosts, by request id.
      const tails = new Map<string, (text: string | null) => void>()

      /** Extensions never placed go to the first machine with what they need. */
      const suggest = (machine: string, provides: readonly string[]) =>
        Effect.gen(function* suggesting() {
          const known = yield* brain.read(knownExtensions)
          for (const a of yield* catalog) {
            const { needs } = a
            if (!a.every && !known.has(a.spec.name) && lacking(needs, provides).length === 0) {
              yield* command(
                PlaceExtension.type,
                { extension: a.spec.name, machine, needs, suggested: true },
                "runtime",
              ).pipe(Effect.provideService(Brain, brain), logRejected)
            }
          }
        })

      /** Each online machine in turn, for extensions never placed. */
      const suggestAll = Effect.gen(function* suggestingAll() {
        const found = yield* brain.read(knownMachines)
        for (const m of found) {
          if (hosts.has(m.machine)) {
            yield* suggest(m.machine, m.provides)
          }
        }
      })

      /** A piece of a folder on its way, passed on to where it goes; or word that it's there. */
      const carried = (host: Connected, m: Extract<ToCore, { t: "packed" | "unpacked" }>) => {
        const c = carries.get(m.id)
        if (m.t === "packed" && c?.from === host) {
          c.heard = Date.now() + (m.done ? UNPACK_MS : 0)
          c.to.link.send({ ...m, t: "unpack", extension: c.extension })
        } else if (m.t === "unpacked" && c?.to === host) {
          c.done(m.ok)
        }
      }

      const route = (host: Connected, m: ToCore) => {
        if (m.t === "up") {
          host.runs.set(m.extension, m.run)
          wake()
        } else if (m.t === "down") {
          if (host.runs.get(m.extension) === m.run) {
            host.runs.delete(m.extension)
          }
          const session = host.sessions.get(m.extension)
          if (session?.run === m.run) {
            session.end(false)
          }
        } else if (m.t === "rpc") {
          const session = host.sessions.get(m.extension)
          if (session?.run !== m.run) {
            return
          }
          try {
            session.transport.onmessage?.(parseJSONRPCMessage(m.message))
          } catch {
            // Not JSON-RPC: an extension's word is never more than that.
          }
        } else if (m.t === "beat") {
          host.link.send({ t: "beat" })
        } else if (m.t === "tailed") {
          tails.get(m.id)?.(m.text)
          tails.delete(m.id)
        } else if (m.t === "packed" || m.t === "unpacked") {
          carried(host, m)
        }
      }

      const closeAll = (host: Connected) => {
        for (const session of host.sessions.values()) {
          session.end(false)
        }
      }

      // A run's up or down, when it changes what the log says of that extension there: a run that
      // comes up where the last word was up (the core restarted, its host linked again or restarted)
      // and a host's down after a down are said already.
      const ran = (
        linked: string,
        machine: string,
        extension: string,
        n: number,
        t: "up" | "down",
        reason: string | undefined,
      ) => {
        const type = t === "up" ? ExtensionUp.type : ExtensionDown.type
        const key = `${machine}/${extension}`
        if (said.get(key) === type) {
          return Effect.void
        }
        said.set(key, type)
        return Effect.ignore(
          brain.ingest([
            {
              id: EventId.make(`extension-${t}:${machine}:${extension}:${n}:${linked}`),
              type,
              source: "runtime",
              payload: { extension, machine, run: n, ...(reason !== undefined && { reason }) },
            },
          ]),
        )
      }

      /** A host that didn't link again in time: the runs it had when its link ended went with it. */
      const gone = (was: Connected, runs: readonly (readonly [string, number])[], linked: string) =>
        Effect.suspend(() => {
          if (hosts.get(was.machine) !== was) {
            return Effect.void
          }
          hosts.delete(was.machine)
          return Effect.andThen(
            Effect.all(
              runs.map(([extension, n]) =>
                ran(linked, was.machine, extension, n, "down", "host gone"),
              ),
            ),
            Effect.andThen(Effect.logInfo(`${was.machine}: host gone`), reconcile),
          )
        })

      const serve = (link: Link) =>
        Effect.gen(function* serving() {
          const linked = crypto.randomUUID()
          let host: Connected | null = null
          let away: Remote | null = null
          let heard = Date.now()
          // A host that beats can go silent; the core's own, linked by queues, never does.
          let beats = false
          // Another machine's logins take turns there, placed by where they fit.
          const turnsThere = (m: Extract<ToCore, { t: "hello" }>) =>
            Effect.gen(function* attaching() {
              if (!options.away || m.turns === undefined || m.machine === options.machine) {
                return
              }
              away?.close()
              const r = remoteMachine(link, {
                id: m.machine,
                home: m.turns.home,
                ...(m.turns.dir !== undefined && { dir: m.turns.dir }),
                provides: m.provides,
                env: m.turns.env,
                ...(m.turns.guard && { guard: m.turns.guard }),
              })
              away = r
              const logins = m.turns.logins.map((l) => ({ ...l, id: `${m.machine}:${l.id}` }))
              yield* turnHosts.attach(r.machine, hostsOf(logins, r.machine))
            })
          const hello = (m: Extract<ToCore, { t: "hello" }>) =>
            Effect.gen(function* greeting() {
              yield* FiberMap.remove(leaving, m.machine)
              yield* turnsThere(m)
              const fresh: Connected = {
                machine: m.machine,
                provides: m.provides,
                link,
                runs: new Map(),
                sessions: new Map(),
                sent: new Set(),
              }
              const was = hosts.get(m.machine)
              if (was !== undefined) {
                closeAll(was)
              }
              hosts.set(m.machine, fresh)
              host = fresh
              yield* Effect.logInfo(`${m.machine}: host linked`)
              if (m.target !== undefined) {
                noteTarget(options.dir, m.target)
              }
              yield* command(
                ReportMachine.type,
                { machine: m.machine, os: m.os, provides: m.provides },
                m.machine,
              ).pipe(Effect.provideService(Brain, brain), logRejected)
              yield* suggest(m.machine, m.provides)
              yield* reconcile
              yield* sendScripts(fresh)
            })
          yield* link.receive.pipe(
            Stream.runForEach((m) => {
              heard = Date.now()
              if (m.t === "beat") {
                beats = true
              }
              if (m.t === "hello") {
                return hello(m)
              }
              if (away?.route(m) === true) {
                return Effect.void
              }
              const at: Connected | null = host
              if (at !== null && m.t === "script") {
                return reported(at.machine, m).pipe(Effect.provideService(Brain, brain))
              }
              if (at !== null && m.t === "runaway") {
                return stoppedRunaway(at.machine, m).pipe(
                  Effect.provideService(Brain, brain),
                  Effect.provideService(Sessions, sessions),
                  Effect.ignore({ log: "Warn", message: "A stopped runaway couldn't be raised" }),
                )
              }
              return Effect.andThen(
                Effect.sync(() => {
                  if (at !== null) {
                    route(at, m)
                  }
                }),
                at !== null && (m.t === "up" || m.t === "down")
                  ? ran(
                      linked,
                      at.machine,
                      m.extension,
                      m.run,
                      m.t,
                      m.t === "down" ? m.reason : undefined,
                    )
                  : Effect.void,
              )
            }),
            Effect.ensuring(
              Effect.suspend(() => {
                const r: Remote | null = away
                return r === null
                  ? Effect.void
                  : Effect.andThen(
                      Effect.sync(() => {
                        r.close()
                      }),
                      turnHosts.detach(r.machine),
                    )
              }),
            ),
            // Its sessions end now and their extensions wait for it, still placed; it's gone once it's
            // been silent SILENT_MS without linking again. A core stopping takes these waits with it,
            // so its restart records nothing.
            Effect.ensuring(
              Effect.suspend(() => {
                const was: Connected | null = host
                if (was === null || hosts.get(was.machine) !== was) {
                  return Effect.void
                }
                closeAll(was)
                for (const c of carries.values()) {
                  if (c.from === was || c.to === was) {
                    c.done(false)
                  }
                }
                const runs = [...was.runs]
                was.runs.clear()
                const wait = beats ? Math.max(0, heard + SILENT_MS - Date.now()) : SILENT_MS
                return Effect.asVoid(
                  FiberMap.run(
                    leaving,
                    was.machine,
                    Effect.andThen(Effect.sleep(wait), gone(was, runs, linked)),
                  ),
                )
              }),
            ),
          )
        })

      const head = yield* brain.read(
        (db) =>
          db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ??
          0,
      )
      yield* Effect.forkScoped(
        brain.changes(head).pipe(
          Stream.filter((e) =>
            new Set<string>([
              ExtensionPlaced.type,
              ExtensionInstalled.type,
              ExtensionUpdated.type,
              ExtensionRemoved.type,
              // An extension's new token goes to its host, which restarts it; others change nothing.
              CredentialIssued.type,
            ]).has(e.type),
          ),
          Stream.runForEach((e) =>
            e.type === ExtensionInstalled.type ? Effect.andThen(suggestAll, reconcile) : reconcile,
          ),
        ),
      )
      yield* Effect.forkScoped(
        brain.changes(head).pipe(
          Stream.filter((e) =>
            new Set<string>([ScriptSet.type, ScriptRetired.type, ScriptEnded.type]).has(e.type),
          ),
          Stream.runForEach(() => sendScripts()),
        ),
      )

      const dispatch = (type: string, payload: unknown) =>
        command(type, payload, "agent").pipe(Effect.provideService(Brain, brain))

      const place = (extension: string, machine: string) =>
        Effect.gen(function* placing() {
          const a = (yield* catalog).find((x) => x.spec.name === extension)
          if (!a) {
            return yield* Effect.fail(new Rejected({ reason: `No extension ${extension}` }))
          }
          if (a.every) {
            return yield* Effect.fail(
              new Rejected({ reason: `${extension} runs on every machine it can` }),
            )
          }
          return yield* dispatch(PlaceExtension.type, { extension, machine, needs: a.needs })
        })

      // Extensions that dial in: each name is kept on the gateway, its next session the next to
      // dial.
      const dialing = new Map<string, Queue.Queue<Transport>>()
      const dialed = (name: string, transport: Transport) =>
        Effect.gen(function* dialingIn() {
          let q = dialing.get(name)
          if (q === undefined) {
            const made = yield* Queue.unbounded<Transport>()
            q = made
            dialing.set(name, made)
            yield* FiberMap.run(
              plugs,
              `dialed:${name}`,
              gateway.keep({ name, transport: Queue.take(made) }),
            )
          }
          yield* Queue.offer(q, transport)
        })

      const shape: typeof Runtime.Service = {
        tell: (m) =>
          Effect.sync(() => {
            for (const host of hosts.values()) {
              host.link.send(m)
            }
            return hosts.size
          }),
        serve,
        dialed,
        tail: (machine, script, lines) =>
          Effect.callback<string | null>((resume) => {
            const host = hosts.get(machine)
            if (host === undefined) {
              resume(Effect.succeed(null))
              return Effect.void
            }
            const id = crypto.randomUUID()
            tails.set(id, (text) => {
              resume(Effect.succeed(text))
            })
            host.link.send({ t: "tail", id, script, lines })
            return Effect.sync(() => {
              tails.delete(id)
            })
          }).pipe(
            Effect.timeoutOption(TAIL_MS),
            Effect.map((found) => Option.getOrNull(found)),
          ),
        machines: Effect.gen(function* viewing() {
          const placed = yield* brain.read(extensionPlacements)
          const found = yield* brain.read(knownMachines)
          const installed = yield* brain.read(installedExtensions)
          const all = yield* catalog
          return {
            machines: found.map((m) => ({
              ...m,
              online: hosts.has(m.machine),
              // One on every machine runs where it fits, whatever placement an install once gave it.
              extensions: [
                ...placed
                  .filter(
                    (p) =>
                      p.machine === m.machine &&
                      !all.some((a) => a.every && a.spec.name === p.extension),
                  )
                  .map((p) => p.extension),
                ...all.filter((a) => a.every && fits(a, m.provides)).map((a) => a.spec.name),
              ].map((name) => ({
                name,
                running: hosts.get(m.machine)?.runs.has(name) === true,
              })),
            })),
            installed,
            unplaced: all
              .filter((a) => !a.every && !placed.some((p) => p.extension === a.spec.name))
              .map((a) => ({ name: a.spec.name, needs: a.needs })),
          }
        }),
        install: (from, machine, folder) =>
          Effect.gen(function* installing() {
            const found = yield* fetchExtension(options.dir, from, folder)
            if (machine !== undefined && found.manifest.every === true) {
              return yield* Effect.fail(
                new Rejected({ reason: `${found.extension} runs on every machine it can` }),
              )
            }
            if (machine !== undefined) {
              const there = (yield* brain.read(knownMachines)).find((m) => m.machine === machine)
              const missing = lacking(found.manifest.needs ?? [], there?.provides ?? [])
              if (!there || missing.length > 0) {
                return yield* Effect.fail(
                  new Rejected({
                    reason: there
                      ? `${machine} lacks ${missing.join(", ")}`
                      : `No machine ${machine}`,
                  }),
                )
              }
              yield* dispatch(PlaceExtension.type, {
                extension: found.extension,
                machine,
                needs: found.manifest.needs ?? [],
              })
            }
            // An installed extension from a new source (another commit): it moves there.
            const was = (yield* brain.read(installedExtensions)).some(
              (i) => i.extension === found.extension,
            )
            yield* dispatch(was ? UpdateExtension.type : InstallExtension.type, found)
            return found
          }),
        update: (extension) =>
          Effect.gen(function* updating() {
            const was = (yield* brain.read(installedExtensions)).find(
              (i) => i.extension === extension,
            )
            if (!was) {
              return yield* Effect.fail(new Rejected({ reason: `No extension ${extension}` }))
            }
            const found = yield* fetchExtension(options.dir, was.from, was.path)
            if (found.extension !== extension) {
              return yield* Effect.fail(
                new Rejected({ reason: `${was.from} is ${found.extension} now, not ${extension}` }),
              )
            }
            yield* dispatch(UpdateExtension.type, found)
            return found
          }),
        place,
        remove: (extension) => dispatch(RemoveExtension.type, { extension }),
      }
      const app = yield* inProcess(runtimeApp).pipe(Effect.provideService(Runtime, shape))
      yield* Effect.forkScoped(gateway.keep(app))
      return shape
    }),
  )

/** How long a host has to answer for a script's log. */
const TAIL_MS = 10_000

const text = new TextDecoder()

/** How often a host's link is checked for silence, as Switchboard's core checks (ws.rs). */
const CHECK_MS = 15_000

/** GET /hosts: a machine's extension host links in. One silent for SILENT_MS is dropped. */
export const hostsRoute = HttpRouter.add("GET", "/hosts", (request) =>
  Effect.gen(function* linking() {
    const runtime = yield* Runtime
    const c = yield* CoreConfig
    const socket: Socket.Socket = yield* request.upgrade
    yield* Effect.scoped(
      Effect.gen(function* streaming() {
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        const out = yield* Queue.unbounded<string>()
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(out), writer.write)))
        let heard = Date.now()
        const link: Link = {
          send: (m) => {
            Queue.offerUnsafe(out, JSON.stringify(m))
          },
          receive: Stream.fromEffectRepeat(
            reader.pull.pipe(
              Effect.map((frames) => {
                heard = Date.now()
                return frames.flatMap((f) =>
                  Option.toArray(decodeToCore(typeof f === "string" ? f : text.decode(f))),
                )
              }),
            ),
          ).pipe(Stream.flattenIterable, Stream.ignore),
        }
        const silent = Effect.gen(function* watching() {
          while (Date.now() - heard <= SILENT_MS) {
            yield* Effect.sleep(CHECK_MS)
          }
        })
        // Its release before anything else: a host on another takes it before its hello.
        link.send(releaseOf(c.dir))
        yield* Effect.raceFirst(runtime.serve(link), silent)
      }),
    ).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  }),
)

/**
 * POST /hosts/next?release=<sha>[&now=1]: the deploy (scripts/ship.sh) on this machine says which
 * release comes next, once its canary passes, and again as it puts it in; each host fetches it ahead,
 * then swaps it in (release.ts).
 */
export const nextRoute = HttpRouter.add("POST", "/hosts/next", (request) =>
  Effect.gen(function* telling() {
    const runtime = yield* Runtime
    const c = yield* CoreConfig
    const params = new URL(request.url, "http://core").searchParams
    const release = params.get("release") ?? ""
    if (!RELEASE_NAME.test(release)) {
      return HttpServerResponse.text("Bad release", { status: 400 })
    }
    const now = params.get("now") === "1"
    const told = yield* runtime.tell({ t: "next", release, builds: buildsOf(c.dir, release), now })
    return HttpServerResponse.text(String(told))
  }),
)

const NAME = /^[a-z][a-z0-9-]{0,40}$/u

/** GET /extensions?name=desktop: an extension that dials in, one JSON-RPC message a frame. */
export const extensionsRoute = HttpRouter.add("GET", "/extensions", (request) =>
  Effect.gen(function* linking() {
    const runtime = yield* Runtime
    const name = new URL(request.url, "http://core").searchParams.get("name") ?? ""
    if (!NAME.test(name)) {
      return HttpServerResponse.text("Bad name", { status: 400 })
    }
    const socket: Socket.Socket = yield* request.upgrade
    yield* Effect.scoped(
      Effect.gen(function* streaming() {
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        const out = yield* Queue.unbounded<string>()
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(out), writer.write)))
        let open = true
        const transport: Transport = {
          start: async () => {
            await Promise.resolve()
          },
          send: async (message) => {
            if (open) {
              Queue.offerUnsafe(out, JSON.stringify(message))
            }
            await Promise.resolve()
          },
          close: async () => {
            open = false
            transport.onclose?.()
            await Promise.resolve()
          },
        }
        yield* runtime.dialed(name, transport)
        yield* Effect.forever(
          reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.sync(() => {
                for (const f of frames) {
                  try {
                    transport.onmessage?.(
                      parseJSONRPCMessage(JSON.parse(typeof f === "string" ? f : text.decode(f))),
                    )
                  } catch {
                    // Not JSON-RPC.
                  }
                }
              }),
            ),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (open) {
                open = false
                transport.onclose?.()
              }
            }),
          ),
        )
      }),
    ).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  }),
)
