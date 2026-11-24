// The daemon as layers, composed and launched the way T3 Code's apps/server does: config, the
// services, routes on one HttpRouter served by the platform's HTTP server, and workers as scoped
// layers. One port carries client sync, commands, the apps' tools and delegation.
import type { Database } from "bun:sqlite"
import path from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import type { Machine, Memory, Thread, Triage } from "@switch/agent"
import {
  cliDirectory,
  agentConfig,
  clocksConfig,
  getThread,
  Hosts,
  hostsOf,
  localMachine,
  Reports,
  Sessions,
} from "@switch/agent"
import {
  agentRoute,
  brainApp,
  extensionFailingConfig,
  Gateway,
  inboxApp,
  inProcess,
  makeIphone,
  Pages,
  pagesConfig,
  pagesRoute,
  Preview,
  widgetRoute,
} from "@switch/gateway"
import { PERSONAL } from "switch-ext-kit"
import {
  Abilities,
  DraftCopies,
  autonomyApp,
  autonomyConfig,
  autonomyMemory,
  autonomyReports,
  autonomyTriage,
  autonomyWorkers,
  Images,
  dialOf,
  hooks,
  hookSettings,
  placeOf,
  rulesAboutLayer,
  ownerOf,
  spaceOfWork,
} from "@switch/autonomy"
import {
  BLOB_MAX,
  Blobs,
  Brain,
  connectionsConfig,
  coversConfig,
  foldersOf,
  membershipConfig,
  messagesConfig,
  placementConfig,
  userConfig,
  spacesConfig,
  syncLayer,
  tagger,
  widgetsConfig,
  layoutsConfig,
  prefsConfig,
  reactorsConfig,
  bypassConfig,
} from "@switch/brain"
import type { CommandDef, EventDef, Projection, SpaceId, Upcast } from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { authLayer, authRoutes, layerMove } from "./auth.ts"
import { Accounts } from "./account-service.ts"
import { accountsRoute } from "./account-routes.ts"
import { accountsApp } from "./accounts.ts"
import { appAsks, asksWorker, draftsRoute, outboundGuard, sealedRoute } from "./asks.ts"
import { blobsRoute } from "./blobs.ts"
import { queryRoute } from "./query.ts"
import { chatLayer, triageLayer } from "./chat.ts"
import { clocksWorker } from "./clocks.ts"
import { limitTold, limitsWorker } from "./limits.ts"
import { claudeCodeLayer, LateSessions } from "./claude-code.ts"
import {
  Connections,
  connectionsApp,
  migrations,
  extensionConnections,
  tokenRoute,
} from "./connections.ts"
import { CoreConfig, osName } from "./config.ts"
import { credentialsConfig, extensionToken, generationOf } from "./credentials.ts"
import { IDENTITY, line, makeContext, spaceOf, threadOf } from "./context.ts"
import { findConfig, historyApp } from "./find.ts"
import { guardHook, guardOf } from "./guard.ts"
import { makeHost } from "./host.ts"
import { notifier, notifyConfig } from "./notify.ts"
import { reportsConfig } from "./reports.ts"
import { scriptsApp } from "./scripts-app.ts"
import { eventsRoute, scriptsConfig, scriptsRetire } from "./scripts.ts"
import { itemChecks } from "./item-checks.ts"
import { takeInLayer } from "./take-in.ts"
import { enrich } from "./outbound.ts"
import { peerRoute } from "./peer.ts"
import { portalPageRoute, portalRoute } from "./portal.ts"
import { buildRoute } from "./release.ts"
import { hostsRoute, nextRoute, Runtime, runtimeLayer, extensionsRoute } from "./runtime.ts"
import { extensionRunsConfig } from "./extension-runs.ts"
import { steerConfig } from "./steer.ts"
import { skillsApp, skillsLine } from "./skills.ts"
import { profilesConfig } from "./profiles.ts"
import { registryRoutes } from "./provider-registry.ts"
import { loadLogins } from "./logins.ts"
import { Profiles, modelsRoute } from "./model-catalog.ts"
import { systemConfig } from "./system.ts"
import { clientView, openLine, openLines, viewConfig } from "./view.ts"
import { web } from "./web.ts"
import { backupRoute, backupWorker } from "./backup.ts"

/** Everything the core's brain knows, for any process that opens the same file. */
export const brainParts: readonly {
  readonly events: readonly EventDef[]
  readonly projections: readonly Projection[]
  readonly commands: readonly CommandDef[]
  readonly upcasts?: readonly Upcast[]
}[] = [
  spacesConfig,
  coversConfig,
  membershipConfig,
  messagesConfig,
  agentConfig,
  clocksConfig,
  steerConfig,
  widgetsConfig,
  layoutsConfig,
  prefsConfig,
  reactorsConfig,
  bypassConfig,
  placementConfig,
  userConfig,
  autonomyConfig,
  connectionsConfig,
  viewConfig,
  credentialsConfig,
  reportsConfig,
  systemConfig,
  extensionRunsConfig,
  extensionFailingConfig,
  findConfig,
  profilesConfig,
  pagesConfig,
  scriptsConfig,
  notifyConfig,
]

const layerBrain = Layer.unwrap(
  CoreConfig.pipe(
    Effect.map((c) =>
      Brain.layer({
        path: c.brain,
        events: brainParts.flatMap((p) => p.events),
        projections: brainParts.flatMap((p) => p.projections),
        commands: brainParts.flatMap((p) => p.commands),
        upcasts: brainParts.flatMap((p) => p.upcasts ?? []),
      }),
    ),
  ),
)

const layerBlobs = Layer.unwrap(CoreConfig.pipe(Effect.map((c) => Blobs.layer(c.blobs))))
// The browser a page is previewed in, fetched once into the core's folder.
const layerPreview = Layer.unwrap(
  CoreConfig.pipe(Effect.map((c) => Preview.layer({ dir: path.join(c.dir, "preview") }))),
)

// Where pages' links lead, and the key their tokens are made with.
const layerPages = Layer.unwrap(
  CoreConfig.pipe(Effect.map((c) => Pages.layer({ dir: c.dir, base: c.pagesUrl }))),
)

/** `switch prepare`: the brain's schema, indexes and projections brought up to this build, then
 * done. The deploy runs it before the new core starts, so the core serves at once. */
export const prepare = Layer.build(layerBrain).pipe(
  Effect.scoped,
  Effect.provide(CoreConfig.layer),
  Effect.asVoid,
)

// The core's logins, as the brain records them (logins.ts).
const layerHosts = Layer.unwrap(
  Effect.gen(function* hosting() {
    const c = yield* CoreConfig
    const guard = guardOf(path.join(c.dir, "host"), c.provides)
    const local = localMachine(c.dir, {
      id: c.machine,
      provides: c.provides,
      ...(guard && { guard }),
    })
    const machine = {
      ...local,
      env: { ...local.env, PATH: `${local.env.PATH ?? ""}:${cliDirectory(c.dir)}` },
    }
    return Hosts.layer(hostsOf(yield* loadLogins(c), machine))
  }),
)

/** The project folders of the space a thread works in (a task, the one it's filed in, else its
 * parent's), by machine. */
const foldersOfThread = (db: Database, t: Thread) => {
  const filed = db.query<{ home: SpaceId | null }, [string]>(
    "SELECT home FROM thread_spaces WHERE thread = ?",
  )
  let at: Thread | null = t
  let space: SpaceId | null = null
  const seen = new Set<string>()
  while (at !== null && !seen.has(at.thread)) {
    seen.add(at.thread)
    space = spaceOf(at.thread) ?? filed.get(at.thread)?.home ?? null
    if (space !== null || at.parent === null) {
      break
    }
    at = getThread(db, at.parent)
  }
  return space === null ? new Map<string, string>() : foldersOf(db, space)
}

const layerSessions = Layer.unwrap(
  Effect.gen(function* sessions() {
    const c = yield* CoreConfig
    const brain = yield* Brain
    const hosts = yield* Hosts
    const modelProfiles = yield* Profiles
    const context = yield* makeContext(modelProfiles.current)
    const reports = yield* Reports
    // A session on another machine reaches the core by this machine's name on the tailnet, with
    // that machine's agent credential (here, as a process of this machine, it needs none).
    const base = (m: Machine) => (m.id === c.machine ? c.local : `http://${c.machine}:${c.port}`)
    // brain.read is synchronous; the sessions want these URLs as plain strings.
    const query = (m: Machine) => {
      const name = `agent-${m.id.toLowerCase()}`
      return m.id === c.machine
        ? ""
        : `?token=${Effect.runSync(brain.read((db) => extensionToken(c.dir, name, generationOf(db, name))))}`
    }
    // Where heavy work goes instead of the user's laptop: the other machines that take turns.
    const elsewhere = () => [
      ...new Set(
        hosts.all
          .map((h) => h.machine)
          .filter((m) => !m.provides.includes(PERSONAL))
          .map((m) => m.id),
      ),
    ]
    return Sessions.layer({
      system: brain.read((db) => `${String(dialOf(db, "identity")) || IDENTITY}\n\n${skillsLine}`),
      cwd: c.cwd,
      delegateUrl: (m) => `${base(m)}/delegate`,
      appsUrl: (m) => `${base(m)}/apps${query(m)}`,
      stable: context.stable,
      delta: context.delta,
      settings: (m) =>
        hookSettings(
          `${base(m)}/hooks`,
          m.guard ? [guardHook(m.guard, elsewhere())] : [],
          query(m),
        ),
      folders: (t) => brain.read((db) => foldersOfThread(db, t)),
      recover: !c.canary,
      effort: brain.read((db) => String(dialOf(db, "effort.default"))),
      profile: modelProfiles.current,
      report: reports.read,
      waiting: (thread, resetAt, partway, key) =>
        limitTold(thread, resetAt, partway, key).pipe(
          Effect.provideService(Brain, brain),
          Effect.provideService(Hosts, hosts),
          Effect.ignore({ log: "Warn" }),
        ),
    })
  }),
)

const layerModels = Layer.unwrap(
  Effect.gen(function* models() {
    const profiles = yield* Profiles
    return Models.layer(profiles.current)
  }),
)

// The iPhone's tools run here, where the push key and the pass certificate are.
let iphoneMade: ReturnType<typeof makeIphone> | undefined
const iphone = Effect.gen(function* phone() {
  const c = yield* CoreConfig
  const blobs = yield* Blobs
  iphoneMade ??= makeIphone({ dir: c.dir, blobs })
  return iphoneMade
})

// Extensions run on hosts, as placed: this machine's is in this process.
const layerGateway = Layer.unwrap(
  Effect.gen(function* gateway() {
    const autonomy = yield* inProcess(autonomyApp)
    const connections = yield* inProcess(connectionsApp)
    const logins = yield* inProcess(accountsApp)
    const skills = yield* inProcess(skillsApp)
    const phone = yield* iphone
    const plug = yield* inProcess(phone.app)
    const inbox = yield* inProcess(inboxApp)
    const history = yield* inProcess(historyApp)
    const brain = yield* Brain
    return Gateway.layer({
      plugs: [autonomy, connections, logins, skills, plug, inbox, history],
      enrich: yield* enrich,
      // Every call that speaks for the user, an agent's or an extension's, through the outbound
      // gate.
      guard: yield* outboundGuard,
      connections: yield* extensionConnections,
      spaceOf: async (thread) =>
        await Effect.runPromise(brain.read((db) => placeOf(db, thread).space)),
    })
  }),
)

// The brain's app reads the gateway, so it plugs in once the gateway is up.
const layerBrainApp = Layer.effectDiscard(
  Effect.gen(function* brainPlug() {
    const gateway = yield* Gateway
    yield* Effect.forkScoped(gateway.keep(yield* inProcess(brainApp)))
  }),
)

// The scripts' tools read logs from the hosts.
const layerScriptsApp = Layer.effectDiscard(
  Effect.gen(function* scriptsPlug() {
    const gateway = yield* Gateway
    const runtime = yield* Runtime
    const app = yield* inProcess(scriptsApp).pipe(Effect.provideService(Runtime, runtime))
    yield* Effect.forkScoped(gateway.keep(app))
  }),
)

// The gates learn what the agent can do from the gateway, once it's up.
const layerAbilities = Layer.effectDiscard(
  Effect.gen(function* abilities() {
    const gateway = yield* Gateway
    const able = yield* Abilities
    able.from(gateway.able)
  }),
)

// A draft's copy (an email draft) is read and written through its extension, once the gateway is up.
const layerDraftCopies = Layer.effectDiscard(
  Effect.gen(function* draftCopies() {
    const gateway = yield* Gateway
    const copies = yield* DraftCopies
    copies.from(async (name, args) => {
      const result = await gateway.call(name, args)
      if (result.isError === true) {
        throw new TypeError(`${name} failed`)
      }
      return result.structuredContent
    })
  }),
)

// Connections learn what extensions need from the gateway.
const layerNeeds = Layer.effectDiscard(
  Effect.gen(function* needs() {
    const gateway = yield* Gateway
    const connections = yield* Connections
    connections.needsFrom(gateway.needs)
    connections.sessionsFrom(async (app, tool, args) => {
      const result = await gateway.call(`${app}_${tool}`, args)
      if (result.isError === true) {
        throw new TypeError(`Can't sign in through ${app}`)
      }
      if (result.structuredContent !== undefined) {
        return result.structuredContent
      }
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
      const value: unknown = JSON.parse(text)
      return value
    })
  }),
)

const layerIphonePushes = Layer.effectDiscard(
  Effect.gen(function* pushes() {
    const phone = yield* iphone
    yield* Effect.forkScoped(
      phone.pushes.pipe(Effect.ignore({ log: "Warn", message: "iPhone pushes stopped" })),
    )
  }),
)

const layerRuntime = Layer.unwrap(
  CoreConfig.pipe(
    Effect.map((c) =>
      runtimeLayer({
        apps: c.apps,
        extensionOptions: c.extensionOptions,
        dir: c.dir,
        readOnly: c.readOnly,
        extensions: !c.canary,
        machine: c.machine,
        // Turns elsewhere reach the core over the tailnet, so only when it listens there.
        away: !c.host.startsWith("127.") && c.host !== "localhost" && c.host !== "::1",
      }),
    ),
  ),
)

const layerLocalHost = Layer.effectDiscard(
  Effect.gen(function* localHost() {
    const c = yield* CoreConfig
    const runtime = yield* Runtime
    const host = yield* makeHost({
      dir: c.dir,
      machine: c.machine,
      os: osName(),
      provides: c.provides,
      core: c.local,
    })
    yield* Effect.forkScoped(
      Effect.scoped(host.connect.pipe(Effect.flatMap((link) => runtime.serve(link)))),
    )
  }),
)

const passesRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const phone = yield* iphone
    const brain = yield* Brain
    return HttpRouter.add(
      "GET",
      "/passes/:serial",
      web(
        async (request) =>
          await Effect.runPromise(phone.passes(request).pipe(Effect.provideService(Brain, brain))),
      ),
    )
  }),
)

// The agent's tools: each call that speaks for the user goes through the gateway's guard.
const appsRoute = Layer.unwrap(
  agentRoute.pipe(Effect.map((fetch) => HttpRouter.add("*", "/apps", web(fetch)))),
)
// Widgets for clients: the list, and each one's A2UI messages.
const widgetsRoute = Layer.unwrap(
  widgetRoute.pipe(
    Effect.map((fetch) =>
      Layer.mergeAll(
        HttpRouter.add("GET", "/widgets", web(fetch)),
        HttpRouter.add("GET", "/widgets/:app/:name", web(fetch)),
        HttpRouter.add("POST", "/widgets/:app/:name", web(fetch)),
      ),
    ),
  ),
)
// Published pages, on the core's port for the private network, and alone on a port of their own
// for a public proxy (not in a canary, which runs beside the live core).
const publishedRoute = Layer.unwrap(
  pagesRoute.pipe(Effect.map((fetch) => HttpRouter.add("GET", "/p/*", web(fetch)))),
)
const layerPagesListener = Layer.effectDiscard(
  Effect.gen(function* listening() {
    const c = yield* CoreConfig
    const fetch = yield* pagesRoute
    if (c.pagesPort === null || c.canary) {
      return
    }
    const port = c.pagesPort
    yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port, fetch })),
      (server) =>
        Effect.promise(async () => {
          await server.stop(true)
        }),
    )
  }),
)
// Other agents' MCP server.
const peersRoute = Layer.unwrap(
  peerRoute.pipe(Effect.map((fetch) => HttpRouter.add("*", "/peer", web(fetch)))),
)
const delegateRoute = Layer.unwrap(
  Sessions.pipe(Effect.map((s) => HttpRouter.add("*", "/delegate", web(s.delegation)))),
)

// The deploy (scripts/ship.sh), on this machine just before it restarts the core: every running
// turn paused for the update, which the next core carries on. Admin only (auth.ts).
const pauseRoute = Layer.unwrap(
  Sessions.pipe(
    Effect.map((s) =>
      HttpRouter.add(
        "POST",
        "/pause",
        s.pause.pipe(Effect.map((paused) => HttpServerResponse.text(String(paused)))),
      ),
    ),
  ),
)

// Claude Code's hooks: triggered memories before a tool call, the reply gate before a stop.
const hooksRoute = Layer.unwrap(
  Effect.gen(function* hooking() {
    const fetch = yield* hooks(spaceOf)
    return Layer.mergeAll(
      HttpRouter.add("POST", "/hooks/pre-tool", web(fetch)),
      HttpRouter.add("POST", "/hooks/stop", web(fetch)),
    )
  }),
)

const layerRoutes = HttpRouter.serve(
  Layer.mergeAll(
    authLayer,
    authRoutes,
    syncLayer(clientView),
    appsRoute,
    widgetsRoute,
    delegateRoute,
    peersRoute,
    pauseRoute,
    backupRoute,
    hooksRoute,
    hostsRoute,
    buildRoute,
    nextRoute,
    passesRoute,
    publishedRoute,
    tokenRoute,
    sealedRoute,
    draftsRoute,
    portalPageRoute,
    portalRoute,
    extensionsRoute,
    blobsRoute,
    queryRoute,
    eventsRoute,
    modelsRoute,
    accountsRoute,
    registryRoutes,
  ),
  {
    disableLogger: true,
  },
)

// Asked to stop, the core lets go of every link at once, as Switchboard's did (crates/core/src/main.rs,
// `stop.asked()`): hosts and apps relink to the next core as soon as it listens. Waiting out its open
// links (Effect's default, 20 s) held each host to a core whose apps were already gone.
const layerHttpServer = Layer.unwrap(
  CoreConfig.pipe(
    Effect.map((c) =>
      BunHttpServer.layer({
        hostname: c.host,
        port: c.port,
        maxRequestBodySize: BLOB_MAX,
        gracefulShutdownTimeout: 0,
      }),
    ),
  ),
)

const layerNotify = Layer.unwrap(iphone.pipe(Effect.map((phone) => notifier(phone))))

// A job's records go to the space of the work that started it.
const layerTagger = Layer.effectDiscard(
  Effect.forkScoped(
    tagger(line, (db, e) => {
      const owner = ownerOf(db, e)
      return owner === null ? null : spaceOfWork(db, owner)
    }),
  ),
)

const autonomy = { line, threadOf, openLine, openLines }
const layerMemory = Layer.unwrap(Profiles.pipe(Effect.map((p) => autonomyMemory(p.current))))
const layerReports = Layer.unwrap(Profiles.pipe(Effect.map((p) => autonomyReports(p.current))))
const layerTriage = Layer.unwrap(
  Profiles.pipe(Effect.map((p) => autonomyTriage({ ...autonomy, profile: p.current }))),
)

// What acts on its own: none of it in a canary.
const layerWorkers = Layer.unwrap(
  CoreConfig.pipe(
    Effect.map((c) =>
      c.canary
        ? Layer.empty
        : Layer.mergeAll(
            triageLayer,
            layerTagger,
            takeInLayer,
            layerIphonePushes,
            asksWorker,
            appAsks,
            autonomyWorkers(autonomy),
            layerNotify,
            layerMove,
            migrations,
            scriptsRetire,
            itemChecks,
            limitsWorker,
            clocksWorker,
            backupWorker,
          ),
    ),
  ),
)

/** Memory and triage are autonomy's; pass its layers to replace the defaults. */
export const layerServer = (
  slots: {
    readonly memory?: Layer.Layer<Memory>
    readonly triage?: Layer.Layer<Triage>
    readonly reports?: Layer.Layer<Reports>
  } = {},
) =>
  Layer.mergeAll(
    layerRoutes,
    chatLayer,
    layerLocalHost,
    layerNeeds,
    layerAbilities,
    layerDraftCopies,
    layerBrainApp,
    layerScriptsApp,
    layerWorkers,
    layerPagesListener,
    LateSessions.fill,
  ).pipe(
    Layer.provide(layerHttpServer),
    Layer.provideMerge(layerRuntime),
    Layer.provideMerge(layerGateway),
    Layer.provideMerge(Layer.mergeAll(Abilities.layer, DraftCopies.layer, rulesAboutLayer)),
    Layer.provideMerge(Images.layer),
    Layer.provideMerge(Connections.layer),
    Layer.provideMerge(layerModels),
    Layer.provideMerge(layerSessions),
    Layer.provideMerge(Accounts.layer),
    Layer.provide(slots.triage ?? layerTriage),
    Layer.provide(slots.reports ?? layerReports),
    Layer.provide(slots.memory ?? layerMemory),
    Layer.provideMerge(Layer.provideMerge(claudeCodeLayer, LateSessions.layer)),
    Layer.provideMerge(Profiles.layer),
    Layer.provideMerge(layerHosts),
    Layer.provideMerge(layerPreview),
    Layer.provideMerge(layerPages),
    Layer.provideMerge(layerBlobs),
    Layer.provideMerge(layerBrain),
    Layer.provideMerge(CoreConfig.layer),
  )
