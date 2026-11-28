// Who may connect, and to what. Two gates, in order:
// 1. The network: this machine, or a Tailscale peer as Tailscale itself names it (`tailscale whois`).
//    The direct peer is checked, never a forwarded header.
// 2. A credential (credentials.ts): `Authorization: Bearer <token>`, or `?token=` where a header
//    can't be set. Each route wants a scope. A process on this machine that isn't a web page (no
//    `Origin`) needs none: it could read the brain's file anyway. While the move to credentials
//    lasts (a week from the first start), a request without one keeps its old access, and every
//    pairing is approved at once, so the apps and hosts move over on their own.
import { existsSync } from "node:fs"
import { Brain, defineRead } from "@switch/brain"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { CoreConfig } from "./config.ts"
import {
  byHash,
  byId,
  hashOf,
  listed,
  newCode,
  newId,
  newToken,
  offerByHash,
  PAIRING_MS,
  replaced,
  extensionOf,
  generationOf,
  scriptOf,
  tailnetMade,
} from "./credentials.ts"
import type { Credential, Kind } from "./credentials.ts"
import { getScript } from "./scripts.ts"

const CLI = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].find((p) => existsSync(p))

const ALLOW_MS = 10 * 60_000
const DENY_MS = 60_000
/** How long a tailnet peer keeps its old access once credentials arrive. */
const MOVE_MS = 7 * 24 * 3_600_000
const OFFER_MS = 10 * 60_000
/** A test copy's credential lapses within this. */
const TRIAL_MS = 7 * 24 * 3_600_000
/** How often a credential's use is noted, at most. */
const SEEN_MS = 10 * 60_000
/**
 * What the deploy asks of the core on its own machine (scripts/ship.sh; move-core.sh's scripts), and
 * redaction's sweep.
 */
const DEPLOY = new Set(["/pause", "/backup", "/scripts", "/hosts/next", "/redactions/sweep"])
/** A host's link, and its release's build (release.ts). */
const HOSTS = new Set(["/hosts", "/hosts/build"])
/**
 * Routes that want one thing each: whether a credential is good (any), other agents' MCP server
 * (peer.ts), and a script's own events, with the credential its host gave it (scripts.ts).
 */
const FIXED: Readonly<Record<string, string>> = {
  "/auth/self": "any",
  "/peer": "peer",
  "/events": "script",
}

const loopback = (ip: string) =>
  ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")

const cache = new Map<string, { readonly ok: boolean; readonly until: number }>()

const whois = (ip: string) =>
  Effect.promise(async () => {
    if (CLI === undefined) {
      return false
    }
    const proc = Bun.spawn([CLI, "whois", "--json", ip.replace(/^::ffff:/u, "")], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await proc.exited) === 0
  })

const onTailnet = (ip: string) =>
  Effect.suspend(() => {
    const hit = cache.get(ip)
    if (hit !== undefined && hit.until > Date.now()) {
      return Effect.succeed(hit.ok)
    }
    return whois(ip).pipe(
      Effect.tap((ok) =>
        Effect.sync(() => {
          cache.set(ip, { ok, until: Date.now() + (ok ? ALLOW_MS : DENY_MS) })
        }),
      ),
    )
  })

/** Who's asking: a credential, this machine, or the tailnet while the move lasts. */
export interface Caller {
  readonly id: string
  readonly kind: Kind | "local" | "script"
  readonly scopes: readonly string[]
}

const LOCAL: Caller = {
  id: "local",
  kind: "local",
  scopes: ["admin", "client", "host", "peer", "extension:*"],
}

const grants = (c: Caller, need: string) =>
  c.scopes.includes(need) ||
  (need.startsWith("extension:") &&
    (c.scopes.includes("extension:*") || c.scopes.includes("admin")))

/**
 * What a route wants: a scope; `open` for pairing and CORS preflights (which carry no credential);
 * `any` for any credential; `shared` for what the apps and extensions both
 * use (files, widgets' tools, old appendages' queries).
 */
const needOf = (method: string, pathname: string, params: URLSearchParams) => {
  // Delegation checks its own per-thread token.
  if (
    method === "OPTIONS" ||
    pathname === "/pair" ||
    pathname.startsWith("/pair/") ||
    pathname === "/delegate" ||
    // A published page: the token in its link is what lets it in.
    pathname.startsWith("/p/") ||
    // The live view's page, with no data in it: its stream wants a client's credential.
    pathname === "/portal"
  ) {
    return "open"
  }
  const fixed = FIXED[pathname]
  if (fixed !== undefined) {
    return fixed
  }
  if (pathname.startsWith("/auth") || DEPLOY.has(pathname)) {
    return "admin"
  }
  if (HOSTS.has(pathname)) {
    return "host"
  }
  if (pathname === "/extensions") {
    return `extension:${params.get("name") ?? ""}`
  }
  if (pathname === "/apps" || pathname === "/connections/token") {
    return "extension:*"
  }
  // An agent session elsewhere comes with its machine's credential, as an extension does.
  if (pathname.startsWith("/hooks/")) {
    return "extension:*"
  }
  if (pathname.startsWith("/blobs") || pathname.startsWith("/widgets") || pathname === "/query") {
    return "shared"
  }
  return "client"
}

const tokenOf = (request: HttpServerRequest.HttpServerRequest, params: URLSearchParams) => {
  const header = request.headers.authorization ?? ""
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim()
  }
  return params.get("token") ?? ""
}

const live = (c: Credential | null, now: number) =>
  c !== null && c.status === "active" && (c.until === null || c.until > now)

const asCaller = (c: Credential): Caller => ({ id: c.id, kind: c.kind, scopes: c.scopes })

// ——— The reads (reads.ts), run in a reader thread ———

/**
 * The extension a token is signed for, by its generation, else null. Its key is read (made, the
 * first time) in the reader too, as it was where the generation is read.
 */
const extensionRead = defineRead("core/auth/extension", (db, dir: string, token: string) =>
  extensionOf(dir, token, (name) => generationOf(db, name)),
)

/** A credential by id, else null. */
const byIdRead = defineRead("core/auth/by-id", (db, id: string) => byId(db, id))

/** A credential by its token's hash, else null. */
const byHashRead = defineRead("core/auth/by-hash", (db, hash: string) => byHash(db, hash))

/** A pairing offer by its code's hash, else null. */
const offerRead = defineRead("core/auth/offer", (db, hash: string) => offerByHash(db, hash))

/** What clients list as of `now`. */
const listedRead = defineRead("core/auth/listed", (db, now: number) => listed(db, now))

/** An extension's token generation. */
export const generationRead = defineRead("core/auth/generation", (db, name: string) =>
  generationOf(db, name),
)

/** A script by id, else null. */
const scriptRead = defineRead("core/auth/script", (db, id: string) => getScript(db, id))

/** Whether the tailnet's credential was made. */
const tailnetMadeRead = defineRead("core/auth/tailnet-made", (db) => tailnetMade(db))
/** The credentials a device's new one replaces: its earlier ones, still good. */
const replacedRead = defineRead("core/auth/replaced", (db, id: string) => {
  const c = byId(db, id)
  return c === null ? [] : replaced(db, c)
})

/** The caller a request's credential names: null without one, "bad" for one that's no good. */
const fromToken = (dir: string, token: string) =>
  Effect.gen(function* resolving() {
    const brain = yield* Brain
    const now = Date.now()
    const extension = yield* brain.read(extensionRead, dir, token)
    if (extension !== null) {
      const revoked = yield* brain.read(byIdRead, `extension:${extension}`)
      return revoked?.status === "revoked"
        ? "bad"
        : ({
            id: `extension:${extension}`,
            kind: "extension",
            scopes: [`extension:${extension}`],
          } satisfies Caller)
    }
    // A script's holds while it runs.
    const script = scriptOf(dir, token)
    if (script !== null) {
      const s = yield* brain.read(scriptRead, script)
      return s?.status === "running"
        ? ({
            id: `script:${script}`,
            kind: "script",
            scopes: [`script:${script}`],
          } satisfies Caller)
        : "bad"
    }
    const c = yield* brain.read(byHashRead, hashOf(token))
    return c !== null && live(c, now) ? asCaller(c) : "bad"
  })

const tailnetGrant = Effect.gen(function* granting() {
  const brain = yield* Brain
  const t = yield* brain.read(byIdRead, "tailnet")
  return t !== null && live(t, Date.now()) ? asCaller(t) : null
})

// Open sockets by credential: revoking one closes them.
const open = new Map<string, Set<Deferred.Deferred<boolean>>>()

const cut = (id: string) =>
  Effect.forEach(open.get(id) ?? [], (d) => Deferred.succeed(d, true), { discard: true })

const held = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* holding() {
    const done = yield* Deferred.make<boolean>()
    const set = open.get(id) ?? new Set()
    set.add(done)
    open.set(id, set)
    return yield* Effect.raceFirst(
      effect,
      Deferred.await(done).pipe(
        Effect.as(HttpServerResponse.text("Revoked", { status: 401 })),
        Effect.map((r): A | HttpServerResponse.HttpServerResponse => r),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          set.delete(done)
        }),
      ),
    )
  })

// When each credential was last noted as used, in ms: noted again only after SEEN_MS.
const noted = new Map<string, number>()

const noteSeen = (caller: Caller) =>
  Effect.gen(function* noting() {
    const now = Date.now()
    if (caller.kind === "extension" || caller.kind === "script" || caller.kind === "local") {
      return
    }
    if ((noted.get(caller.id) ?? 0) > now - SEEN_MS) {
      return
    }
    noted.set(caller.id, now)
    const brain = yield* Brain
    yield* brain
      .dispatch({
        id: crypto.randomUUID(),
        type: "credential.see",
        source: "auth",
        payload: { id: caller.id },
      })
      .pipe(Effect.ignore, Effect.forkDetach)
  })

const deny = (status: number, why: string) =>
  HttpServerResponse.text(why, { status, headers: { "access-control-allow-origin": "*" } })

export const authLayer = HttpRouter.middleware(
  Effect.gen(function* making() {
    const brain = yield* Brain
    const c = yield* CoreConfig
    return (httpEffect) =>
      Effect.gen(function* guarding() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const ip = Option.getOrElse(request.peerAddress, () => "")
        const local = loopback(ip)
        if (ip === "" || !(local || (yield* onTailnet(ip)))) {
          return deny(403, "Not on this tailnet")
        }
        const url = new URL(request.url, "http://core")
        const need = needOf(request.method, url.pathname, url.searchParams)
        if (need === "open") {
          return yield* httpEffect
        }
        const token = tokenOf(request, url.searchParams)
        let caller: Caller | null = null
        if (token !== "") {
          const found = yield* fromToken(c.dir, token).pipe(Effect.provideService(Brain, brain))
          if (found === "bad") {
            return deny(401, "Not paired")
          }
          caller = found
        } else if (local && request.headers.origin === undefined) {
          caller = LOCAL
        } else {
          caller = yield* tailnetGrant.pipe(Effect.provideService(Brain, brain))
        }
        if (caller === null) {
          return deny(401, "Not paired")
        }
        const extension = caller.scopes.some((s) => s.startsWith("extension:"))
        const ok =
          need === "any" ||
          grants(caller, need) ||
          (need === "extension:*" && extension) ||
          (need === "shared" && (extension || grants(caller, "client"))) ||
          (need === "script" && caller.scopes.some((s) => s.startsWith("script:")))
        if (!ok) {
          return deny(403, `Needs ${need}`)
        }
        if (token !== "") {
          yield* noteSeen(caller).pipe(Effect.provideService(Brain, brain))
        }
        return yield* held(caller.id, httpEffect)
      })
  }),
  { global: true },
)

/** The caller of a request that already passed the gate. */
const callerOf = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* finding() {
    const c = yield* CoreConfig
    const url = new URL(request.url, "http://core")
    const token = tokenOf(request, url.searchParams)
    if (token === "") {
      return null
    }
    const found = yield* fromToken(c.dir, token)
    return found === "bad" ? null : found
  })

// Routes.

// The desktop's view calls /auth from its own origin, its credential in the address.
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "access-control-allow-origin": "*" },
  })

const bodyOf = <A, I>(request: HttpServerRequest.HttpServerRequest, schema: Schema.Codec<A, I>) =>
  request.text.pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(t)),
    Effect.option,
    Effect.map(Option.getOrNull),
  )

/** An id a device keeps for itself: the one it pairs again under replaces its last credential. */
const Device = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
)

const PairAsked = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: Schema.Literals(["device", "host"]),
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  device: Device,
})

/** What each kind may ask for. Another agent's is minted, never paired. */
const ALLOWED: Readonly<Record<"device" | "host" | "peer", readonly string[]>> = {
  device: ["client", "admin"],
  host: ["host"],
  peer: ["peer"],
}

const dispatch = (type: string, payload: unknown) =>
  Effect.gen(function* dispatching() {
    const brain = yield* Brain
    return yield* brain.dispatch({ id: crypto.randomUUID(), type, source: "auth", payload })
  })

/** A device's credential, good now, replaces the device's last: those are revoked. */
const replacing = (id: string) =>
  Effect.gen(function* replacingOld() {
    const brain = yield* Brain
    const old = yield* brain.read(replacedRead, id)
    yield* Effect.forEach(
      old,
      (o) => dispatch("credential.revoke", { id: o }).pipe(Effect.andThen(cut(o)), Effect.ignore),
      { discard: true },
    )
  })

/** POST /pair: a code for the user to approve, and the token it will make good. */
const pair = HttpRouter.add("POST", "/pair", (request) =>
  Effect.gen(function* pairing() {
    const asked = yield* bodyOf(request, PairAsked)
    if (asked === null) {
      return deny(400, "Bad pairing")
    }
    const want = asked.scopes ?? ALLOWED[asked.kind].slice(0, 1)
    if (want.length === 0 || want.some((s) => !ALLOWED[asked.kind].includes(s))) {
      return deny(400, "Bad scopes")
    }
    const id = newId()
    const token = newToken()
    const code = newCode()
    const asking = yield* dispatch("credential.request", {
      id,
      name: asked.name,
      kind: asked.kind,
      scopes: want,
      hash: hashOf(token),
      code,
      ...(asked.device === undefined ? {} : { device: asked.device }),
    }).pipe(Effect.option)
    if (Option.isNone(asking)) {
      return deny(429, "Too many pairings waiting")
    }
    // While the move to credentials lasts, a tailnet peer is the user's own: approved at once.
    if ((yield* tailnetGrant) !== null) {
      yield* dispatch("credential.approve", { id }).pipe(Effect.ignore)
      yield* replacing(id)
    }
    return json({ pairing: id, token, code })
  }),
)

/** GET /pair/<id>, with its token: waiting, approved, denied, or gone. */
const pairStatus = HttpRouter.add("GET", "/pair/:id", (request) =>
  Effect.gen(function* polling() {
    const brain = yield* Brain
    const url = new URL(request.url, "http://core")
    const id = url.pathname.split("/").at(-1) ?? ""
    const token = tokenOf(request, url.searchParams)
    const c = yield* brain.read(byIdRead, id)
    const gone = json({ status: "gone" }, 404)
    if (c === null || token === "" || (yield* brain.read(byHashRead, hashOf(token)))?.id !== id) {
      return gone
    }
    if (c.status === "active") {
      return json({ status: "approved" })
    }
    if (c.status === "pending") {
      return c.at > Date.now() - PAIRING_MS ? json({ status: "waiting" }) : gone
    }
    return json(
      { status: c.status === "denied" ? "denied" : "gone" },
      c.status === "denied" ? 403 : 404,
    )
  }),
)

const Redeem = Schema.Struct({
  offer: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  device: Device,
})

/** POST /pair/redeem: a desktop's one-time offer (its QR) for a credential, at once. */
const redeem = HttpRouter.add("POST", "/pair/redeem", (request) =>
  Effect.gen(function* redeeming() {
    const brain = yield* Brain
    const asked = yield* bodyOf(request, Redeem)
    if (asked === null) {
      return deny(400, "Bad offer")
    }
    const offer = yield* brain.read(offerRead, hashOf(asked.offer))
    if (offer === null || offer.used !== 0 || offer.until < Date.now()) {
      return json({ status: "gone" }, 404)
    }
    const id = newId()
    const token = newToken()
    const issued = yield* dispatch("credential.issue", {
      id,
      name: asked.name,
      kind: "device",
      scopes: offer.scopes,
      hash: hashOf(token),
      offer: offer.id,
      ...(asked.device === undefined ? {} : { device: asked.device }),
    }).pipe(Effect.option)
    if (Option.isNone(issued)) {
      return json({ status: "gone" }, 404)
    }
    yield* replacing(id)
    return json({ token, credential: id })
  }),
)

const Offer = Schema.Struct({ scopes: Schema.optionalKey(Schema.Array(Schema.String)) })

/** POST /auth/offer: a one-time code for a QR that pairs a device at once. */
const offer = HttpRouter.add("POST", "/auth/offer", (request) =>
  Effect.gen(function* offering() {
    const asked = (yield* bodyOf(request, Offer)) ?? {}
    const scopes = asked.scopes ?? ["client"]
    if (scopes.some((s) => !ALLOWED.device.includes(s))) {
      return deny(400, "Bad scopes")
    }
    const code = newToken()
    const until = Date.now() + OFFER_MS
    yield* dispatch("credential.offer", { id: newId(), hash: hashOf(code), scopes, until })
    // Where a phone reaches this core: its tailnet name when it listens everywhere.
    const c = yield* CoreConfig
    const host = c.host === "0.0.0.0" || c.host === "::" ? c.machine : c.host
    return json({ offer: code, until, core: `http://${host}:${c.port}` })
  }),
)

const Which = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
})

/** The pending pairing an approve or deny names, by id or by its code. */
const pendingOf = (asked: typeof Which.Type) =>
  Effect.gen(function* finding() {
    const brain = yield* Brain
    const now = Date.now()
    const all = yield* brain.read(listedRead, now)
    const code = asked.code?.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "")
    return (
      all.find(
        (c) =>
          c.status === "pending" &&
          (c.id === asked.id || (code !== undefined && c.code?.replace("-", "") === code)),
      ) ?? null
    )
  })

const decide = (verb: "approve" | "deny") =>
  HttpRouter.add("POST", `/auth/${verb}`, (request) =>
    Effect.gen(function* deciding() {
      const asked = yield* bodyOf(request, Which)
      const c = asked === null ? null : yield* pendingOf(asked)
      if (c === null) {
        return deny(404, "No such pairing")
      }
      yield* dispatch(`credential.${verb}`, { id: c.id })
      if (verb === "approve") {
        yield* replacing(c.id)
      }
      return json({ id: c.id, name: c.name, status: verb === "approve" ? "approved" : "denied" })
    }),
  )

const Revoke = Schema.Struct({ id: Schema.String })

const revokeId = (id: string) =>
  dispatch("credential.revoke", { id }).pipe(
    Effect.andThen(cut(id)),
    Effect.as(json({ id, status: "revoked" })),
    Effect.catchTag("Rejected", (r) => Effect.succeed(deny(404, r.reason))),
  )

/** POST /auth/revoke: a device's, a host's, an extension's (`extension:<name>`), or the tailnet's. */
const revoke = HttpRouter.add("POST", "/auth/revoke", (request) =>
  Effect.gen(function* revoking() {
    const asked = yield* bodyOf(request, Revoke)
    return asked === null ? deny(400, "Bad revoke") : yield* revokeId(asked.id)
  }),
)

const Rotate = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^extension:[a-z0-9][a-z0-9-]{0,80}$/u)),
})

/** POST /auth/rotate: an extension's (`extension:<name>`) next token; the last one stops working. Its
 * host is sent the new one, and restarts it. */
const rotate = HttpRouter.add("POST", "/auth/rotate", (request) =>
  Effect.gen(function* rotating() {
    const asked = yield* bodyOf(request, Rotate)
    if (asked === null) {
      return deny(400, "Bad rotate")
    }
    const name = asked.id.slice("extension:".length)
    yield* dispatch("credential.issue", {
      id: asked.id,
      name,
      kind: "extension",
      scopes: [asked.id],
      hash: "",
    })
    yield* cut(asked.id)
    const brain = yield* Brain
    return json({ id: asked.id, generation: yield* brain.read(generationRead, name) })
  }),
)

/** GET /auth/self: whether this credential is still good, and what it may do. */
const whoami = HttpRouter.add("GET", "/auth/self", (request) =>
  Effect.gen(function* asking() {
    const caller = yield* callerOf(request)
    return json(caller ?? { id: "", kind: "none", scopes: [] })
  }),
)

/** DELETE /auth/self: unpairing, from the device itself. */
const self = HttpRouter.add("DELETE", "/auth/self", (request) =>
  Effect.gen(function* unpairing() {
    const caller = yield* callerOf(request)
    return caller === null || caller.kind === "extension"
      ? deny(400, "Nothing to unpair")
      : yield* revokeId(caller.id)
  }),
)

const Mint = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  kind: Schema.Literals(["device", "host", "peer"]),
  scopes: Schema.Array(Schema.String),
  device: Device,
  /** A test copy's: it lapses this long from now, in ms (at most TRIAL_MS). */
  lapses: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
})

/** POST /auth/mint: a credential straight away, for this machine's apps, the CLI and other agents. A
 * test copy's lapses, and the copy revokes it when it's done (`DELETE /auth/self`). */
const mint = HttpRouter.add("POST", "/auth/mint", (request) =>
  Effect.gen(function* minting() {
    const asked = yield* bodyOf(request, Mint)
    if (asked === null || asked.scopes.some((s) => !ALLOWED[asked.kind].includes(s))) {
      return deny(400, "Bad mint")
    }
    const id = newId()
    const token = newToken()
    yield* dispatch("credential.issue", {
      id,
      name: asked.name,
      kind: asked.kind,
      scopes: asked.scopes,
      hash: hashOf(token),
      ...(asked.device === undefined ? {} : { device: asked.device }),
      ...(asked.lapses === undefined
        ? {}
        : { until: Date.now() + Math.min(asked.lapses, TRIAL_MS) }),
    })
    yield* replacing(id)
    return json({ token, credential: id })
  }),
)

/** GET /auth: every credential and waiting pairing. */
const list = HttpRouter.add(
  "GET",
  "/auth",
  Effect.gen(function* listing() {
    const brain = yield* Brain
    const now = Date.now()
    return json(yield* brain.read(listedRead, now))
  }),
)

export const authRoutes = Layer.mergeAll(
  pair,
  pairStatus,
  redeem,
  offer,
  decide("approve"),
  decide("deny"),
  revoke,
  rotate,
  whoami,
  self,
  mint,
  list,
)

/** Once, the first time credentials run: the tailnet keeps its old access for a while. */
export const layerMove = Layer.effectDiscard(
  Effect.gen(function* moving() {
    const brain = yield* Brain
    if (yield* brain.read(tailnetMadeRead)) {
      return
    }
    yield* dispatch("credential.issue", {
      id: "tailnet",
      name: "Tailnet",
      kind: "tailnet",
      scopes: ["client", "host", "extension:*"],
      hash: "",
      until: Date.now() + MOVE_MS,
    })
  }),
)
