// Connections: accounts the user connects for extensions. Extensions declare what they need (provider,
// scopes, one or many, and how it's connected); one connection per provider account carries every
// extension's scopes, merged as more are asked for. By kind:
// - oauth: PKCE in the core; the client receives and relays its own registered redirect.
// - key: a sealed ask. The user's client seals what they type to a one-time key, and only this
//   core opens it (`answer`), straight into the Keychain: never the agent, a chat or the brain.
//   A key the agent gets itself (one a page shows, kept to a file) goes in from that file (`save`),
//   as Switchboard's browser kept one: only how many characters it held comes back.
// - session: the extension holds the sign-in itself and adopts it; the ask says which extension.
// Tokens and keys stay in this Mac's Keychain under the connection's id; the brain holds only who
// is connected with which scopes. Extensions get short-lived access tokens over loopback.
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  callerOf,
  fieldsOf,
  gate,
  gave,
  items,
  ItemClosed,
  OpenItem,
  ReviseItem,
} from "@switch/autonomy"
import {
  allConnections,
  Brain,
  BYPASS,
  Bypass,
  ConnectionAdded,
  ConnectionRemoved,
  ConnectionScopesChanged,
  ConnectionsMigrated,
  EventId,
  HOME,
  installedExtensions,
  prefs,
  ItemId,
  spaceFor,
  SpaceId,
} from "@switch/brain"
import type { Connection } from "@switch/brain"
import { Caller, defineApp, openSealed, sealedKey, tool } from "switch-ext-kit"
import type { Need } from "switch-ext-kit"
import type { ExtensionConnections } from "@switch/gateway"
import type { Models } from "@switch/models"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

// The Keychain

const SERVICE = process.env.SWITCH_KEYCHAIN ?? "switch-connections"

const run = (argv: readonly string[], stdin?: string) => {
  const r = Bun.spawnSync([...argv], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
  })
  return { ok: r.exitCode === 0, code: r.exitCode, out: r.stdout.toString().trim() }
}

/** `security`'s exit when no item matches (errSecItemNotFound). */
const NOT_FOUND = 44

const keychain = {
  read: (service: string, account: string): string | null => {
    const r = run(["security", "find-generic-password", "-s", service, "-a", account, "-w"])
    return r.ok && r.out !== "" ? r.out : null
  },
  /** Through `security`'s stdin, as hex: the secret is never in an argument list. */
  write: (account: string, value: string) => {
    const hex = Buffer.from(value, "utf-8").toString("hex")
    const r = run(
      ["security", "-i"],
      `add-generic-password -U -s ${SERVICE} -a "${account}" -X ${hex}\n`,
    )
    if (!r.ok) {
      throw new Error("Can't write the Keychain")
    }
  },
  /** Whether this core's item exists, read without its secret; null when the Keychain can't say. */
  has: (account: string): boolean | null => {
    const r = run(["security", "find-generic-password", "-s", SERVICE, "-a", account])
    if (r.ok) {
      return true
    }
    return r.code === NOT_FOUND ? false : null
  },
  remove: (account: string) => {
    run(["security", "delete-generic-password", "-s", SERVICE, "-a", account])
  },
  removeFrom: (service: string, account: string) => {
    run(["security", "delete-generic-password", "-s", service, "-a", account])
  },
  /** Every item's account name in a service. */
  accounts: (service: string): string[] => {
    const dump = run(["security", "dump-keychain"]).out
    const out: string[] = []
    for (const block of dump.split("keychain: ")) {
      const svce = /"svce"<blob>="(?<v>[^"]*)"/u.exec(block)?.groups?.v
      const acct = /"acct"<blob>="(?<v>[^"]*)"/u.exec(block)?.groups?.v
      if (svce === service && acct !== undefined) {
        out.push(acct)
      }
    }
    return out
  },
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const parseJson = (text: string | null): Record<string, unknown> => {
  if (text === null) {
    return {}
  }
  try {
    const v: unknown = JSON.parse(text)
    return isRecord(v) ? v : {}
  } catch {
    return {}
  }
}

// Providers

interface Provider {
  readonly name: string
  readonly label: string
  readonly auth: string
  readonly token: string
  readonly revoke?: string
  /** Asked for every time, to learn who it is; not kept among its scopes. */
  readonly identity: readonly string[]
  readonly extra: Readonly<Record<string, string>>
  /** This provider defines an omitted token-response scope as the original authorization request. */
  readonly scopeWhenOmitted?: "requested"
  /** Without OpenID, who signed in: this URL's JSON, read with the new access token, names the account in `field`. */
  readonly profile?: { readonly url: string; readonly field: string }
}

const PROVIDERS: readonly Provider[] = [
  {
    name: "google",
    label: "Google",
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    identity: ["openid", "email"],
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  {
    name: "microsoft",
    label: "Microsoft",
    scopeWhenOmitted: "requested",
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    identity: ["openid", "email", "offline_access"],
    extra: { prompt: "select_account" },
  },
  {
    // No OpenID: the account is the user's Spotify id, from /v1/me. Its PKCE clients have no secret.
    name: "spotify",
    label: "Spotify",
    auth: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    identity: ["user-read-private"],
    extra: {},
    profile: { url: "https://api.spotify.com/v1/me", field: "id" },
  },
]

const providerOf = (name: string) => {
  const p = PROVIDERS.find((x) => x.name === name)
  if (p === undefined) {
    throw new Error(`No provider ${name}`)
  }
  return p
}

const grantedScopes = (
  provider: Provider,
  response: Readonly<Record<string, unknown>>,
  requested: readonly string[],
) => {
  const granted =
    provider.scopeWhenOmitted === "requested" && !Object.hasOwn(response, "scope")
      ? requested
      : str(response.scope).split(" ")
  return granted.filter((scope) => scope !== "" && !provider.identity.includes(scope)).toSorted()
}

interface Client {
  readonly key: string
  readonly id: string
  readonly secret: string
  readonly kind: "installed" | "web" | "flat"
  readonly redirects: readonly string[]
}

/** An OAuth client, kept as data: Keychain `client:<name>`, a provider's download or `{client_id, client_secret}`. */
const clientOf = (key: string): Client => {
  const c = parseJson(keychain.read(SERVICE, `client:${key}`))
  let inner = c
  let kind: Client["kind"] = "flat"
  if (isRecord(c.installed)) {
    inner = c.installed
    kind = "installed"
  } else if (isRecord(c.web)) {
    inner = c.web
    kind = "web"
  }
  if (str(inner.client_id) === "") {
    throw new Error(`No ${key} client`)
  }
  return {
    key,
    id: str(inner.client_id),
    secret: str(inner.client_secret),
    kind,
    redirects: Array.isArray(inner.redirect_uris)
      ? inner.redirect_uris.filter((v): v is string => typeof v === "string")
      : [],
  }
}

const refreshGrant = (provider: Provider, client: Client, refresh: string) =>
  Effect.gen(function* refreshingGrant() {
    const res = yield* Effect.tryPromise(
      async () =>
        await fetch(provider.token, {
          method: "POST",
          body: new URLSearchParams({
            client_id: client.id,
            ...(client.secret === "" ? {} : { client_secret: client.secret }),
            refresh_token: refresh,
            grant_type: "refresh_token",
          }),
        }),
    )
    const body = parseJson(yield* Effect.promise(async () => await res.text()))
    if (!res.ok || str(body.access_token) === "") {
      return yield* Effect.fail(new Error("Account authorization could not be refreshed"))
    }
    return {
      token: str(body.access_token),
      expires: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
      /** A provider that rotates refresh tokens (Spotify's PKCE, Microsoft) sends the next one; "" when it keeps the old. */
      refresh: str(body.refresh_token),
      scopes: str(body.scope)
        .split(" ")
        .filter((scope) => scope !== "" && !provider.identity.includes(scope))
        .toSorted(),
    }
  }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

/** A provider's client download's inner client id, if it's one. */
const clientIn = (raw: string) => {
  const c = parseJson(raw)
  if (isRecord(c.installed)) {
    return str(c.installed.client_id)
  }
  return isRecord(c.web) ? str(c.web.client_id) : ""
}

const clientIdOf = (raw: string) => clientIn(raw) || str(parseJson(raw).client_id)

/** A grant's OAuth client, kept under the usual key, or beside another client already there. */
const keepClient = (provider: string, kind: string, raw: string) => {
  const usual = `${provider}-${kind}`
  const kept = keychain.read(SERVICE, `client:${usual}`)
  const ours = clientIdOf(raw)
  const key =
    kept === null || clientIdOf(kept) === ours
      ? usual
      : `${usual}-${createHash("sha256").update(ours).digest("hex").slice(0, 8)}`
  if (keychain.read(SERVICE, `client:${key}`) === null) {
    keychain.write(`client:${key}`, raw)
  }
  return key
}

/** The JWT's claims, unverified: it came straight from the provider over TLS. */
const claims = (jwt: string): Record<string, unknown> => {
  const part = jwt.split(".")[1] ?? ""
  return parseJson(Buffer.from(part, "base64url").toString("utf-8"))
}

/**
 * Who signed in, from a token response: its ID token's email or username, or for a provider
 * without OpenID, its profile read with the new access token. "" when neither says.
 */
const accountOf = (p: Provider, t: Readonly<Record<string, unknown>>) => {
  const who = claims(str(t.id_token))
  const named = str(who.email) || str(who.preferred_username)
  const { profile } = p
  if (named !== "" || profile === undefined) {
    return Effect.succeed(named)
  }
  return Effect.tryPromise(async () => {
    const res = await fetch(profile.url, {
      headers: { Authorization: `Bearer ${str(t.access_token)}` },
    })
    return str(parseJson(await res.text())[profile.field])
  }).pipe(Effect.orElseSucceed(() => ""))
}

const base64url = (b: Buffer) => b.toString("base64url")

/** The pending ask for a key: its one-time key's private half and whose key it is. */
const pending = (item: string) => {
  const held = parseJson(keychain.read(SERVICE, `ask:${item}`))
  return str(held.secretKey) === "" || str(held.provider) === ""
    ? null
    : { secretKey: str(held.secretKey), provider: str(held.provider), account: str(held.account) }
}

/** The account a Connect ask names: its Connect key's, or its sealed key's; "" for none. */
const askedFor = (item: {
  readonly id: string
  readonly action?: { readonly args?: Readonly<Record<string, unknown>> }
}) => str(item.action?.args?.account) || (pending(item.id)?.account ?? "")

const MINUTE = 60_000
const WAIT = 10 * MINUTE

// The service

const none = (): readonly (Need & { readonly app: string })[] => []

export interface ConnectionView extends Connection {
  /** Scopes an extension needs that it hasn't granted. */
  readonly missing: readonly string[]
}

export type Kind = "oauth" | "key" | "session"

export interface ProviderNeed {
  readonly provider: string
  readonly label: string
  /** OAuth, a key the user gives, or a session an extension holds. */
  readonly kind: Kind
  readonly scopes: readonly string[]
  readonly multiple: boolean
  readonly apps: readonly string[]
  readonly sessions?: readonly {
    readonly app: string
    readonly signIn: string
    readonly status: string
  }[]
}

const unavailableSession: SessionCall = (app) => {
  throw new Error(`Can't reach ${app}`)
}

type SessionCall = (app: string, tool: string, args: Record<string, unknown>) => Promise<unknown>

const sessionResult = Schema.decodeUnknownSync(
  Schema.Struct({
    accounts: Schema.Array(Schema.Struct({ account: Schema.String })),
  }),
)

export interface ConnectionsShape {
  readonly recover: (
    provider: string,
    account?: string,
  ) => Effect.Effect<{ readonly connected: boolean; readonly blocked?: string }, Error>
  readonly readiness: (provider: string) => Effect.Effect<
    {
      readonly clients: readonly {
        readonly key: string
        readonly kind: Client["kind"]
        readonly redirects: readonly string[]
      }[]
    },
    Error
  >
  readonly finish: (input: {
    readonly state: string
    readonly code?: string
    readonly error?: string
  }) => Effect.Effect<{ readonly connected: true; readonly id: string }, Error>
  readonly sessionsFrom: (call: SessionCall) => void
  readonly verify: (
    provider: string,
    account?: string,
  ) => Effect.Effect<{ readonly connected: boolean }, Error>
  readonly repair: Effect.Effect<void, Error>
  /** Where the needs come from: the gateway, once it's up. */
  readonly needsFrom: (f: () => readonly (Need & { readonly app: string })[]) => void
  readonly needs: () => readonly ProviderNeed[]
  /** Needs that name a Keychain service their accounts were kept in before. */
  readonly legacy: () => readonly {
    readonly provider: string
    readonly kind: Kind
    readonly legacy: string
  }[]
  /** A provider as extensions declare it (or Switch knows it): its name to the user and its kind. */
  readonly provider: (name: string) => Effect.Effect<ProviderNeed, Error>
  /** Asks the user to connect it: by its kind, a Connect key, a sealed field, or its extension's sign-in. */
  readonly ask: (input: {
    readonly provider: string
    readonly account?: string
    readonly space?: SpaceId
  }) => Effect.Effect<{ readonly opened: boolean; readonly id: string }, Error>
  /** A sealed key the user gave for an ask: opened here, into the Keychain. */
  readonly answer: (input: {
    readonly item: string
    readonly status?: string
    readonly use?: string
    readonly enc?: string
    readonly ct?: string
  }) => Effect.Effect<{ readonly ok: boolean; readonly id?: string }, Error>
  readonly list: Effect.Effect<readonly ConnectionView[]>
  /**
   * Starts a consent in the system browser (it finishes in the background, into the brain), or
   * for a key, the sealed ask the user types it into.
   */
  readonly connect: (
    provider: string,
    account?: string,
    redirectUri?: string,
  ) => Effect.Effect<unknown, Error>
  readonly disconnect: (id: string) => Effect.Effect<void, Error>
  /**
   * A grant an extension kept itself before connections, taken in once: a refresh token and its
   * OAuth client, a key's secret, or a session's account. Kept in the Keychain, never in the brain.
   */
  readonly adopt: (
    need: Need,
    account: string,
    grant: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<string, Error>
  /**
   * A key from a file on this Mac that holds it alone, into its connection's Keychain item: only
   * how many characters it held comes back. Its asks stay open for whoever sees it work to close.
   */
  readonly save: (input: {
    readonly provider: string
    readonly account?: string
    readonly file: string
  }) => Effect.Effect<
    { readonly id: string; readonly characters: number; readonly asks: readonly string[] },
    Error
  >
  /** A fresh access token, or a key's secret: for extensions, over loopback or their gateway. */
  readonly token: (
    id: string,
  ) => Effect.Effect<{ readonly token: string; readonly expires: number }, Error>
}

export class Connections extends Context.Service<Connections, ConnectionsShape>()(
  "switch/Connections",
) {
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* making() {
      const brain = yield* Brain
      let source: () => readonly (Need & { readonly app: string })[] = none
      let sessionCall: SessionCall = unavailableSession
      const authorizations = new Map<
        string,
        {
          readonly provider: Provider
          readonly client: Client
          readonly verifier: string
          readonly redirect: string
          readonly required: readonly string[]
          readonly account?: string
          readonly until: number
        }
      >()
      const cache = new Map<string, { readonly token: string; readonly expires: number }>()
      // The brain first, then the Keychain: a crash between leaves a connection with no secret,
      // which repair records gone, never a secret no connection names. One at a time, and repair
      // with them, so it never reads a connection whose secret is still being written.
      const secrets = Semaphore.makeUnsafe(1)
      /** Connections whose secret repair found since this core started. */
      const present = new Set<string>()

      const needs = (): ProviderNeed[] => {
        const by = new Map<string, ProviderNeed>()
        for (const n of source()) {
          const label = PROVIDERS.find((p) => p.name === n.provider)?.label ?? n.label ?? n.provider
          const had = by.get(n.provider)
          by.set(n.provider, {
            provider: n.provider,
            label,
            kind: n.kind ?? had?.kind ?? "oauth",
            scopes: [...new Set([...(had?.scopes ?? []), ...n.scopes])].toSorted(),
            multiple: (had?.multiple ?? false) || n.multiple,
            apps: [...new Set([...(had?.apps ?? []), n.app])],
            sessions: [
              ...(had?.sessions ?? []),
              ...(n.session === undefined ? [] : [{ app: n.app, ...n.session }]),
            ],
          })
        }
        return [...by.values()]
      }

      const connected = brain.read((db) => allConnections(db))
      const declined = (provider: string, account?: string) =>
        brain.read((db) => prefs(db)[`connections.allowed.${provider}:${account ?? ""}`] === false)

      const clientsFor = (provider: string) =>
        Effect.gen(function* findingClients() {
          const kept = (yield* connected)
            .filter((connection) => connection.provider === provider)
            .map((connection) => str(parseJson(keychain.read(SERVICE, connection.id)).client))
          const keys = [
            ...new Set([
              provider,
              `${provider}-desktop`,
              `${provider}-installed`,
              `${provider}-web`,
              ...kept,
            ]),
          ].filter((key) => key !== "")
          return keys.flatMap((key) => {
            try {
              return [clientOf(key)]
            } catch {
              return []
            }
          })
        })

      const readiness = (provider: string) =>
        clientsFor(provider).pipe(
          Effect.map((clients) => ({
            clients: clients.map(({ key, kind, redirects }) => ({ key, kind, redirects })),
          })),
        )

      const list = Effect.gen(function* listing() {
        const all = yield* connected
        const wanted = needs()
        return all.map((c): ConnectionView => {
          const n = wanted.find((x) => x.provider === c.provider)
          // A key or a session has no scopes to grant.
          const want = n?.kind === "oauth" ? n.scopes : []
          return { ...c, missing: want.filter((x) => !c.scopes.includes(x)) }
        })
      })

      /** What installed extensions declare in their manifests: known whether or not they run. */
      const installedNeed = (name: string) =>
        brain
          .read((db) => installedExtensions(db))
          .pipe(
            Effect.map((extensions): Option.Option<ProviderNeed> => {
              const found = extensions.flatMap((s) =>
                (s.manifest.connections ?? [])
                  .filter((n) => n.provider === name)
                  .map((n) => ({ n, extension: s.extension })),
              )
              const [first] = found
              if (first === undefined) {
                return Option.none()
              }
              return Option.some({
                provider: name,
                label: PROVIDERS.find((p) => p.name === name)?.label ?? first.n.label ?? name,
                kind: first.n.kind ?? "oauth",
                scopes: [...new Set(found.flatMap((f) => f.n.scopes))].toSorted(),
                multiple: found.some((f) => f.n.multiple),
                apps: [...new Set(found.map((f) => f.extension))],
                sessions: found.flatMap((f) =>
                  f.n.session === undefined ? [] : [{ app: f.extension, ...f.n.session }],
                ),
              })
            }),
          )

      const declared = (name: string) =>
        Effect.gen(function* declaring() {
          const need = needs().find((n) => n.provider === name)
          if (need !== undefined) {
            return need
          }
          const installed = yield* installedNeed(name)
          if (Option.isSome(installed)) {
            return installed.value
          }
          const known = PROVIDERS.find((p) => p.name === name)
          return known === undefined
            ? yield* Effect.fail(new Error(`No extension needs ${name}`))
            : ({
                provider: name,
                label: known.label,
                kind: "oauth",
                scopes: [],
                multiple: false,
                apps: [],
              } satisfies ProviderNeed)
        })

      const ingest = (type: string, payload: unknown) =>
        brain
          .ingest([{ id: EventId.make(crypto.randomUUID()), type, source: "connections", payload }])
          .pipe(Effect.orDie)

      /**
       * A connection's secret kept: what the brain learns of it first (the connection, else its
       * scopes changed from `had`'s), then the Keychain. One the Keychain refuses is taken back.
       */
      const keep = (value: string, had: Connection | undefined, next: Connection) =>
        secrets.withPermit(
          Effect.gen(function* keeping() {
            const { id } = next
            const rescoped = had !== undefined && had.scopes.join(" ") !== next.scopes.join(" ")
            if (had === undefined) {
              yield* ingest(ConnectionAdded.type, next)
            } else if (rescoped) {
              yield* ingest(ConnectionScopesChanged.type, { id, scopes: next.scopes })
            }
            const wrote = yield* Effect.result(
              Effect.try(() => {
                keychain.write(id, value)
              }),
            )
            if (wrote._tag === "Success") {
              present.add(id)
              return id
            }
            if (had === undefined) {
              yield* ingest(ConnectionRemoved.type, { id })
            } else if (rescoped) {
              yield* ingest(ConnectionScopesChanged.type, { id, scopes: had.scopes })
            }
            return yield* Effect.fail(new Error("Can't write the Keychain"))
          }),
        )

      /** The open asks an account answers: its own and those naming no account. */
      const asksFor = (provider: string, account: string) =>
        brain
          .read((db) => items(db, { status: "open" }))
          .pipe(
            Effect.map((open) =>
              open.filter(
                (x) =>
                  x.id.startsWith(`connect-${provider}-`) && [account, ""].includes(askedFor(x)),
              ),
            ),
          )

      /** A verified account closes the asks it answers. */
      const closeAsks = (provider: string, account: string, except = "") =>
        Effect.gen(function* closing() {
          const need = yield* declared(provider)
          const actual = (yield* connected).find(
            (c) => c.provider === provider && c.account === account,
          )
          if (
            need?.kind === "oauth" &&
            (actual === undefined || need.scopes.some((scope) => !actual.scopes.includes(scope)))
          ) {
            return
          }
          for (const i of (yield* asksFor(provider, account)).filter((x) => x.id !== except)) {
            keychain.remove(`ask:${i.id}`)
            yield* ingest(ItemClosed.type, {
              id: i.id,
              status: "resolved",
              why: "Connection verified",
            })
          }
        })

      /** The code back from the browser: tokens to the Keychain, the connection to the brain. */
      const finish = (
        p: Provider,
        client: Client,
        code: string,
        verifier: string,
        redirect: string,
        requested: readonly string[],
        expected?: string,
      ) =>
        Effect.gen(function* finishing() {
          const res = yield* Effect.tryPromise(
            async () =>
              await fetch(p.token, {
                method: "POST",
                body: new URLSearchParams({
                  client_id: client.id,
                  ...(client.secret === "" ? {} : { client_secret: client.secret }),
                  code,
                  code_verifier: verifier,
                  grant_type: "authorization_code",
                  redirect_uri: redirect,
                }),
              }),
          )
          const t = parseJson(yield* Effect.promise(async () => await res.text()))
          if (!res.ok) {
            return yield* Effect.fail(new Error(str(t.error) || "Refused"))
          }
          const account = yield* accountOf(p, t)
          if (account === "") {
            return yield* Effect.fail(new Error("No account"))
          }
          if (expected !== undefined && account.toLowerCase() !== expected.toLowerCase()) {
            return yield* Effect.fail(new Error("A different account signed in"))
          }
          const id = `${p.name}:${account}`
          const held = parseJson(keychain.read(SERVICE, id))
          const refresh =
            str(t.refresh_token) || (held.client === client.key ? str(held.refresh_token) : "")
          if (refresh === "") {
            return yield* Effect.fail(new Error("No refresh token"))
          }
          const scopes = grantedScopes(p, t, requested)
          const was = (yield* connected).find((connection) => connection.id === id)
          const required = [
            ...requested,
            ...(was?.scopes ?? []),
            ...(needs().find((need) => need.provider === p.name)?.scopes ?? []),
          ]
          if (required.some((scope) => !p.identity.includes(scope) && !scopes.includes(scope))) {
            return yield* Effect.fail(
              new Error("Permissions incomplete. Connect again and allow all requested access."),
            )
          }
          if (str(t.access_token) === "") {
            return yield* Effect.fail(new Error("No access token"))
          }
          yield* keep(JSON.stringify({ client: client.key, refresh_token: refresh }), was, {
            id,
            provider: p.name,
            account,
            scopes,
          })
          cache.set(id, {
            token: str(t.access_token),
            expires: Date.now() + (typeof t.expires_in === "number" ? t.expires_in : 3600) * 1000,
          })
          yield* closeAsks(p.name, account)
          return id
        })

      const ask = (input: {
        readonly provider: string
        readonly account?: string
        readonly space?: SpaceId
        readonly blocked?: string
      }) =>
        Effect.gen(function* asking() {
          if (yield* declined(input.provider, input.account)) {
            return yield* Effect.fail(new Error("The user declined connecting this account"))
          }
          const p = yield* declared(input.provider)
          const open = yield* brain.read((db) => items(db, { status: "open" }))
          // An oauth ask is a Connect key; a key's is sealed and opens only with its own private half.
          // One ask per account for a provider that supports several accounts.
          const wanted = p.kind === "key" ? (input.account ?? "default") : (input.account ?? "")
          const already = open.find(
            (i) =>
              i.id.startsWith(`connect-${p.provider}-`) &&
              (p.kind !== "key" || pending(i.id) !== null) &&
              (!p.multiple || askedFor(i) === wanted),
          )
          if (already !== undefined) {
            if (input.blocked !== undefined) {
              yield* brain
                .dispatch({
                  id: crypto.randomUUID(),
                  type: ReviseItem.type,
                  source: "connections",
                  payload: {
                    ...fieldsOf(already),
                    body: `${already.title}: ${input.blocked.replaceAll("_", " ")}`,
                    completion: "owner",
                  },
                })
                .pipe(Effect.mapError((e) => new Error(String(e))))
            }
            return { opened: false, id: already.id }
          }
          const id = ItemId.make(
            `connect-${p.provider}-${String(Date.now())}-${crypto.randomUUID().slice(0, 6)}`,
          )
          const named = input.account === undefined ? "" : ` ${input.account}`
          const base = {
            id,
            space: input.space ?? HOME,
            decision: "connections",
          }
          let payload: typeof OpenItem.payload.Type
          if (p.kind === "key") {
            const pair = yield* Effect.promise(sealedKey)
            keychain.write(
              `ask:${id}`,
              JSON.stringify({
                secretKey: pair.secretKey,
                provider: p.provider,
                account: input.account ?? "default",
              }),
            )
            const title = `${p.label} key${named}`
            payload = {
              ...base,
              title,
              body: title,
              kind: "sealed",
              app: "connections",
              answerTo: "answer",
              sealed: { key: pair.key, use: `${p.label} key` },
            }
          } else if (p.kind === "session") {
            const title = `Sign in to ${p.label}${named}`
            payload = {
              ...base,
              title,
              body: title,
              app: "connections",
              completion: "owner",
              action: {
                label: "Sign in",
                app: "connections",
                tool: "connect",
                args: {
                  provider: p.provider,
                  ...(input.account === undefined ? {} : { account: input.account }),
                },
              },
            }
          } else {
            const title = `Connect ${p.label}${named}`
            payload = {
              ...base,
              title,
              body:
                input.blocked === undefined
                  ? title
                  : `${title}: ${input.blocked.replaceAll("_", " ")}`,
              app: "connections",
              completion: "owner",
              action: {
                label: "Connect",
                app: "connections",
                tool: "connect",
                args: {
                  provider: p.provider,
                  ...(input.account === undefined ? {} : { account: input.account }),
                },
              },
            }
          }
          yield* brain
            .dispatch({
              id: crypto.randomUUID(),
              type: OpenItem.type,
              source: "connections",
              payload,
            })
            .pipe(Effect.mapError((e) => new Error(String(e))))
          return { opened: true, id }
        })

      const answer = (input: {
        readonly item: string
        readonly status?: string
        readonly use?: string
        readonly enc?: string
        readonly ct?: string
      }) =>
        Effect.gen(function* answering() {
          const waiting = pending(input.item)
          if (waiting === null) {
            return { ok: false }
          }
          if (input.enc === undefined || input.ct === undefined) {
            // Closed without a key: dismissed or done by hand.
            if (input.status !== undefined && input.status !== "answered") {
              keychain.remove(`ask:${input.item}`)
            }
            return { ok: false }
          }
          const sealed = { enc: input.enc, ct: input.ct }
          const p = yield* declared(waiting.provider)
          const secret = yield* Effect.tryPromise(
            async () =>
              await openSealed(
                waiting.secretKey,
                input.item,
                input.use ?? `${p.label} key`,
                sealed,
              ),
          ).pipe(Effect.mapError(() => new Error("Can't open it")))
          const trimmed = secret.trim()
          if (trimmed === "") {
            return yield* Effect.fail(new Error("No key"))
          }
          const id = yield* adopt(
            { provider: p.provider, scopes: [], multiple: p.multiple, kind: "key" },
            waiting.account,
            { secret: trimmed },
          )
          // The ask answered is left for whoever answers it to close.
          yield* closeAsks(p.provider, waiting.account, input.item)
          keychain.remove(`ask:${input.item}`)
          return { ok: true, id }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      const connect = (name: string, account?: string, redirectUri?: string) =>
        Effect.gen(function* connecting() {
          if (yield* declined(name, account)) {
            return yield* Effect.fail(new Error("The user declined connecting this account"))
          }
          const wanted = yield* declared(name)
          if (wanted.kind === "key") {
            const asked = yield* ask({
              provider: name,
              ...(account === undefined ? {} : { account }),
            })
            return { item: asked.id }
          }
          if (wanted.kind === "session") {
            const session = wanted.sessions?.[0]
            if (session === undefined) {
              return yield* Effect.fail(
                new Error(`${wanted.label} extension has no sign-in action`),
              )
            }
            const result = yield* Effect.tryPromise(async () => {
              const value = await sessionCall(
                session.app,
                session.signIn,
                account === undefined ? {} : { account },
              )
              return value
            })
            yield* verify(name, account)
            return result
          }
          return yield* oauth(name, account, redirectUri)
        })

      const verify = (name: string, account?: string) =>
        Effect.gen(function* verifying() {
          const wanted = yield* declared(name)
          if (wanted.kind !== "session") {
            return {
              connected: (yield* list).some(
                (c) =>
                  c.provider === name &&
                  (account === undefined || c.account === account) &&
                  c.missing.length === 0,
              ),
            }
          }
          const sessions = wanted.sessions ?? []
          if (sessions.length === 0) {
            return yield* Effect.fail(new Error(`${wanted.label} extension has no session check`))
          }
          const results = yield* Effect.forEach(
            sessions,
            (session) =>
              Effect.tryPromise(async () =>
                sessionResult(
                  await sessionCall(
                    session.app,
                    session.status,
                    account === undefined ? {} : { account },
                  ),
                ),
              ),
            { concurrency: 1 },
          )
          const accounts = [
            ...new Set(
              results.flatMap((r) => r.accounts.map((a) => a.account)).filter((who) => who !== ""),
            ),
          ]
          const matched = accounts.filter((who) => account === undefined || who === account)
          for (const who of matched) {
            yield* adopt(
              { provider: name, kind: "session", scopes: [], multiple: wanted.multiple },
              who,
              {},
            )
            yield* closeAsks(name, who)
          }
          for (const c of (yield* connected).filter(
            (entry) =>
              entry.provider === name &&
              (account === undefined || entry.account === account) &&
              !matched.includes(entry.account),
          )) {
            yield* ingest(ConnectionRemoved.type, { id: c.id })
          }
          return { connected: matched.length > 0 }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      const recoverSession = (
        session: { readonly app: string; readonly signIn: string },
        account?: string,
      ) =>
        Effect.tryPromise(
          async () =>
            await sessionCall(
              session.app,
              session.signIn,
              account === undefined ? {} : { account },
            ),
        )

      /** Refresh first, then let the declaring extension recover its authorization privately. */
      const recover = (provider: string, account?: string) =>
        Effect.gen(function* recovering() {
          if (yield* declined(provider, account)) {
            return { connected: false, blocked: "declined" }
          }
          const wanted = yield* declared(provider)
          if (wanted.kind === "session") {
            const current = yield* Effect.result(verify(provider, account))
            if (current._tag === "Success" && current.success.connected) {
              return current.success
            }
          }
          const ready = (yield* list).filter(
            (c) =>
              c.provider === provider &&
              (account === undefined || c.account === account) &&
              c.missing.length === 0 &&
              wanted.scopes.every((scope) => c.scopes.includes(scope)),
          )
          for (const connection of ready) {
            const valid = yield* Effect.result(token(connection.id))
            if (
              valid._tag === "Success" &&
              (yield* list).some(
                (current) =>
                  current.id === connection.id &&
                  wanted.scopes.every((scope) => current.scopes.includes(scope)),
              )
            ) {
              yield* closeAsks(provider, connection.account)
              return { connected: true }
            }
          }
          let blocked: string | undefined
          for (const session of wanted.sessions ?? []) {
            const result = yield* recoverSession(session, account)
            const reported = Schema.decodeUnknownOption(
              Schema.Struct({
                blocked: Schema.optionalKey(
                  Schema.String.check(Schema.isPattern(/^[a-z_]{1,80}$/u)),
                ),
              }),
            )(result)
            if (Option.isSome(reported)) {
              ;({ blocked } = reported.value)
            }
            const status = yield* verify(provider, account)
            if (status.connected) {
              for (const connection of (yield* list).filter(
                (c) =>
                  c.provider === provider &&
                  (account === undefined || c.account === account) &&
                  c.missing.length === 0,
              )) {
                const checked = yield* Effect.result(token(connection.id))
                if (
                  checked._tag === "Success" &&
                  (yield* list).some(
                    (current) =>
                      current.id === connection.id &&
                      wanted.scopes.every((scope) => current.scopes.includes(scope)),
                  )
                ) {
                  yield* closeAsks(provider, connection.account)
                  return { connected: true }
                }
              }
              if (wanted.kind === "session") {
                return status
              }
            }
          }
          return { connected: false, ...(blocked === undefined ? {} : { blocked }) }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      const repair = Effect.gen(function* repairing() {
        const open = yield* brain.read((db) => items(db, { status: "open" }))
        for (const i of open.filter(
          (entry) =>
            entry.id.startsWith("connect-") &&
            entry.completion !== "owner" &&
            (entry.kind ?? "task") === "task",
        )) {
          const wanted = needs().find(
            (n) => i.id.startsWith(`connect-${n.provider}-`) && n.kind !== "key",
          )
          if (wanted === undefined) {
            continue
          }
          const account = askedFor(i)
          yield* brain
            .dispatch({
              id: crypto.randomUUID(),
              type: ReviseItem.type,
              source: "connections",
              payload: {
                id: i.id,
                space: i.space,
                title: i.title,
                body: i.title,
                decision: i.decision,
                app: "connections",
                completion: "owner",
                action: {
                  label: "Sign in",
                  app: "connections",
                  tool: "connect",
                  args: { provider: wanted.provider, ...(account === "" ? {} : { account }) },
                },
              },
            })
            .pipe(Effect.mapError((e) => new Error(String(e))))
        }
        for (const n of needs().filter(
          (need) =>
            need.kind === "session" &&
            (need.sessions?.length ?? 0) > 0 &&
            open.some((i) => i.id.startsWith(`connect-${need.provider}-`)),
        )) {
          const accounts = [
            ...new Set(
              open.filter((item) => item.id.startsWith(`connect-${n.provider}-`)).map(askedFor),
            ),
          ]
          for (const account of accounts) {
            yield* verify(n.provider, account === "" ? undefined : account).pipe(Effect.ignore)
          }
        }
        // A connection whose secret is gone (a crash after it was recorded, or the item deleted by
        // hand) can't answer, yet reads as connected, so nothing asks for it again: recorded gone.
        // Only when the Keychain says it has no such item; a session's secret is the extension's.
        yield* secrets.withPermit(
          Effect.gen(function* checking() {
            for (const c of yield* connected) {
              if (present.has(c.id)) {
                continue
              }
              const need = yield* Effect.option(declared(c.provider))
              if (Option.isNone(need) || need.value.kind === "session") {
                continue
              }
              const has = keychain.has(c.id)
              if (has === true) {
                present.add(c.id)
              } else if (has === false) {
                cache.delete(c.id)
                yield* ingest(ConnectionRemoved.type, { id: c.id })
                yield* Effect.logWarning(`connections: ${c.id} had no secret; recorded gone`)
              }
            }
          }),
        )
      })

      const oauth = (provider: string, account?: string, redirectUri?: string) =>
        Effect.gen(function* consenting() {
          const p = yield* Effect.try(() => providerOf(provider))
          if (redirectUri === undefined) {
            return yield* Effect.fail(
              new Error("Open sign-in from a client with an OAuth callback"),
            )
          }
          const redirect = yield* Effect.try(() => new URL(redirectUri))
          const loopback =
            redirect.protocol === "http:" &&
            redirect.hostname === "127.0.0.1" &&
            redirect.port !== "" &&
            redirect.pathname === "/oauth/callback" &&
            redirect.search === "" &&
            redirect.hash === "" &&
            redirect.username === "" &&
            redirect.password === ""
          const clients = yield* clientsFor(provider)
          const client =
            clients.find((c) => c.kind === "installed" && loopback) ??
            clients.find(
              (c) => (c.kind === "web" || c.kind === "flat") && c.redirects.includes(redirectUri),
            )
          if (client === undefined) {
            return yield* Effect.fail(new Error(`No compatible ${p.label} OAuth client`))
          }
          const had = (yield* connected).find(
            (c) => c.provider === provider && c.account === account,
          )
          const want = needs().find((n) => n.provider === provider)?.scopes ?? []
          const scopes = [...new Set([...p.identity, ...(had?.scopes ?? []), ...want])]
          const verifier = base64url(randomBytes(48))
          const state = base64url(randomBytes(24))
          const challenge = base64url(createHash("sha256").update(verifier).digest())
          const url = new URL(p.auth)
          for (const [k, v] of Object.entries({
            client_id: client.id,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: scopes.join(" "),
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            ...p.extra,
            ...(account === undefined ? {} : { login_hint: account }),
          })) {
            url.searchParams.set(k, v)
          }
          for (const [key, consent] of authorizations) {
            if (consent.until <= Date.now()) {
              authorizations.delete(key)
            }
          }
          authorizations.set(state, {
            provider: p,
            client,
            verifier,
            redirect: redirectUri,
            required: scopes.filter((scope) => !p.identity.includes(scope)),
            until: Date.now() + WAIT,
            ...(account === undefined ? {} : { account }),
          })
          return { kind: "oauth", url: url.toString() }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      const finishConsent = (input: {
        readonly state: string
        readonly code?: string
        readonly error?: string
      }) =>
        Effect.gen(function* completing() {
          const consent = authorizations.get(input.state)
          authorizations.delete(input.state)
          if (consent === undefined || consent.until <= Date.now()) {
            return yield* Effect.fail(new Error("Sign-in expired; try again"))
          }
          if (input.error !== undefined || input.code === undefined || input.code === "") {
            return yield* Effect.fail(new Error("Sign-in was not completed"))
          }
          const id = yield* finish(
            consent.provider,
            consent.client,
            input.code,
            consent.verifier,
            consent.redirect,
            consent.required,
            consent.account,
          )
          return { connected: true as const, id }
        })

      const disconnect = (id: string) =>
        Effect.gen(function* disconnecting() {
          const c = (yield* connected).find((x) => x.id === id)
          if (c === undefined) {
            return yield* Effect.fail(new Error(`No connection ${id}`))
          }
          const p = PROVIDERS.find((x) => x.name === c.provider)
          const held = parseJson(keychain.read(SERVICE, id))
          // Recorded gone before its secret goes: a crash between leaves only an item nothing reads.
          const gone = yield* secrets.withPermit(
            Effect.gen(function* removing() {
              const seq = yield* ingest(ConnectionRemoved.type, { id })
              keychain.remove(id)
              present.delete(id)
              return seq
            }),
          )
          cache.delete(id)
          if (p?.revoke !== undefined && str(held.refresh_token) !== "") {
            const { revoke } = p
            yield* Effect.promise(
              async () =>
                await fetch(revoke, {
                  method: "POST",
                  body: new URLSearchParams({ token: str(held.refresh_token) }),
                }).catch(() => null),
            )
          }
          return gone
        })

      // One refresh at a time: a rotated refresh token works once, so two at once would spend it twice.
      const refreshes = Semaphore.makeUnsafe(1)
      const token = (id: string) =>
        Effect.gen(function* refreshing() {
          const hit = cache.get(id)
          if (hit !== undefined && hit.expires > Date.now() + MINUTE) {
            return hit
          }
          const c = (yield* connected).find((x) => x.id === id)
          const held = parseJson(keychain.read(SERVICE, id))
          if (c !== undefined && held.kind === "key" && str(held.secret) !== "") {
            return { token: str(held.secret), expires: Date.now() + 60 * MINUTE }
          }
          if (c === undefined || str(held.refresh_token) === "") {
            return yield* Effect.fail(new Error(`${id} isn't connected`))
          }
          const p = yield* Effect.try(() => providerOf(c.provider))
          const client = yield* Effect.try(() => clientOf(str(held.client) || c.provider))
          const fresh = yield* refreshGrant(p, client, str(held.refresh_token))
          if (fresh.scopes.length > 0 && fresh.scopes.join(" ") !== c.scopes.join(" ")) {
            yield* ingest(ConnectionScopesChanged.type, { id, scopes: fresh.scopes })
          }
          if (fresh.refresh !== "" && fresh.refresh !== str(held.refresh_token)) {
            keychain.write(id, JSON.stringify({ ...held, refresh_token: fresh.refresh }))
          }
          const out = { token: fresh.token, expires: fresh.expires }
          cache.set(id, out)
          return out
        }).pipe(
          (refresh) => refreshes.withPermit(refresh),
          Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
        )

      /** A grant into the Keychain and its connection into the brain; its asks are the caller's to close. */
      const adopt = (n: Need, account: string, grant: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* adopting() {
          if (account === "") {
            return yield* Effect.fail(new Error("No account"))
          }
          const id = `${n.provider}:${account}`
          const kind = n.kind ?? "oauth"
          const had = (yield* connected).find((c) => c.id === id)
          const named = { id, provider: n.provider, account }
          if (kind === "key") {
            if (str(grant.secret) === "") {
              return yield* Effect.fail(new Error("No key"))
            }
            yield* keep(JSON.stringify({ kind: "key", secret: str(grant.secret) }), had, {
              ...named,
              scopes: had?.scopes ?? [],
            })
          } else if (kind === "oauth") {
            const refresh = str(grant.refresh_token)
            const raw = isRecord(grant.client) ? JSON.stringify(grant.client) : str(grant.client)
            if (refresh === "" || clientIdOf(raw) === "") {
              return yield* Effect.fail(new Error("No refresh token or client"))
            }
            const clientKey = keepClient(n.provider, str(grant.client_kind) || "web", raw)
            const p = yield* Effect.try(() => providerOf(n.provider))
            const client = yield* Effect.try(() => clientOf(clientKey))
            const fresh = yield* refreshGrant(p, client, refresh)
            const scopes =
              fresh.scopes.length > 0
                ? fresh.scopes
                : str(grant.scope)
                    .split(" ")
                    .filter((scope) => scope !== "" && !p.identity.includes(scope))
                    .toSorted()
            // Preserve a working broader grant; validate a replacement before publishing it.
            const expands =
              had === undefined ||
              (scopes.length > had.scopes.length &&
                had.scopes.every((scope) => scopes.includes(scope)))
            const kept = expands ? null : yield* Effect.result(token(id))
            if (kept?._tag !== "Success") {
              yield* keep(
                JSON.stringify({ client: clientKey, refresh_token: fresh.refresh || refresh }),
                had,
                { ...named, scopes },
              )
              cache.set(id, { token: fresh.token, expires: fresh.expires })
            }
          } else if (had === undefined) {
            // A session: the extension holds the sign-in, and the Keychain nothing.
            yield* ingest(ConnectionAdded.type, { ...named, scopes: [] })
          }
          return id
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      const save = (input: {
        readonly provider: string
        readonly account?: string
        readonly file: string
      }) =>
        Effect.gen(function* saving() {
          if (yield* declined(input.provider, input.account)) {
            return yield* Effect.fail(new Error("The user declined connecting this account"))
          }
          const p = yield* declared(input.provider)
          if (p.kind !== "key") {
            return yield* Effect.fail(new Error(`${p.label} isn't connected with a key`))
          }
          const { file } = input
          const full = file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : file
          const key = yield* Effect.try({
            try: () => readFileSync(full, "utf-8").trim(),
            catch: () => new Error(`Can't read ${file}`),
          })
          if (key === "") {
            return yield* Effect.fail(new Error(`${file} is empty`))
          }
          const account = input.account ?? "default"
          const id = yield* adopt(
            { provider: p.provider, scopes: [], multiple: p.multiple, kind: "key" },
            account,
            { secret: key },
          )
          const asks = yield* asksFor(p.provider, account)
          return { id, characters: key.length, asks: asks.map((i) => i.id) }
        }).pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))))

      return {
        readiness,
        recover,
        finish: finishConsent,
        sessionsFrom: (call) => {
          sessionCall = call
        },
        verify,
        repair,
        adopt: (n, account, grant) =>
          Effect.tap(adopt(n, account, grant), () => closeAsks(n.provider, account)),
        save,
        answer,
        ask,
        provider: declared,
        needsFrom: (f) => {
          source = f
        },
        needs,
        legacy: () =>
          source().flatMap((n) =>
            n.legacy === undefined
              ? []
              : [{ provider: n.provider, kind: n.kind ?? "oauth", legacy: n.legacy }],
          ),
        list,
        connect,
        disconnect,
        token,
      }
    }),
  )
}

/** The user's connections as an extension reaches them through its gateway: only its own provider's. */
export const extensionConnections = Connections.pipe(
  Effect.map((c): ExtensionConnections => ({
    list: (provider) =>
      c.list.pipe(
        Effect.map((all) =>
          all
            .filter((x) => x.provider === provider)
            .map((x) => ({ account: x.account, scopes: x.scopes })),
        ),
      ),
    token: (provider, account) => c.token(`${provider}:${account}`),
    adopt: (_, need, account, grant) => c.adopt(need, account, grant),
  })),
)

/** A legacy item's grant: an OAuth refresh token, or for a key need, its secret. */
const legacyGrant = (kind: Kind, raw: string | null) => {
  if (raw === null) {
    return null
  }
  const held = parseJson(raw)
  if (str(held.refresh_token) !== "") {
    return {
      kind: "oauth" as const,
      refresh: str(held.refresh_token),
      client: str(held.client) || "web",
      scope: str(held.scope),
    }
  }
  // An older keeper's bare refresh token, granted through its `oauth-client`: its scopes are
  // learned on the first refresh.
  if (kind === "oauth") {
    const bare = Object.keys(held).length === 0 ? raw.trim() : ""
    return bare === "" || bare.startsWith("{")
      ? null
      : { kind: "oauth" as const, refresh: bare, client: "web", scope: "" }
  }
  let plain = ""
  if (Object.keys(held).length === 0) {
    try {
      const v: unknown = JSON.parse(raw)
      plain = str(v)
    } catch {
      plain = raw
    }
  }
  const secret =
    str(held.secret) ||
    str(held.key) ||
    str(held.api_key) ||
    str(held.apiKey) ||
    str(held.token) ||
    plain.trim()
  return secret === "" ? null : { kind: "key" as const, secret }
}

export type Migrated = "retry" | "done"

/**
 * An extension's accounts from before connections, in its own Keychain service (`legacy` in what it
 * needs): each item holding `{client, refresh_token, scope}`, or a key (`{secret}`, `{key}`,
 * `{api_key}`, `{token}` or the bare value) for a key need, becomes a connection; an OAuth client
 * (`oauth-client[-<kind>]`) is kept as `client:<provider>-<kind>`. Once every one answers through
 * its connection (a refresh, or the key read back), `connection.migrated` records it. The old
 * items are copied, never removed: what kept them before (an older core, the extension run elsewhere)
 * may still read them.
 */
export const migrate = (service: string, provider: string, kind: Kind) =>
  Effect.gen(function* migrating() {
    const brain = yield* Brain
    const connections = yield* Connections
    // Moved once something was: a mark with none (what it held couldn't be read then) counts not.
    const at = yield* brain.read(
      (db) =>
        db
          .query<{ time: number }, [string, string]>(
            "SELECT time FROM events WHERE type = ? AND json_extract(payload, '$.service') = ? AND json_array_length(payload, '$.ids') > 0",
          )
          .get(ConnectionsMigrated.type, service)?.time ?? null,
    )
    const grants = keychain
      .accounts(service)
      .filter((a) => !a.startsWith("oauth-client") && !a.startsWith("client:"))
      .flatMap((account) => {
        const g = legacyGrant(kind, keychain.read(service, account))
        return g === null ? [] : [{ account, id: `${provider}:${account}`, grant: g }]
      })
    const answers = (id: string) =>
      Effect.result(connections.token(id)).pipe(Effect.map((r) => r._tag === "Success"))

    if (at !== null || grants.length === 0) {
      return "done" satisfies Migrated
    }
    const have = new Set((yield* brain.read((db) => allConnections(db))).map((c) => c.id))
    for (const { account, id, grant } of grants) {
      if (have.has(id)) {
        continue
      }
      let scopes: string[] = []
      if (grant.kind === "oauth") {
        const oldClient = grant.client === "web" ? "oauth-client" : `oauth-client-${grant.client}`
        const clientKey = `${provider}-${grant.client}`
        if (keychain.read(SERVICE, `client:${clientKey}`) === null) {
          const raw = keychain.read(service, oldClient)
          if (raw === null) {
            yield* Effect.logWarning(`connections: ${service} has no ${oldClient}`)
            return "retry" satisfies Migrated
          }
          keychain.write(`client:${clientKey}`, raw)
        }
        scopes = grant.scope.split(" ").filter(Boolean).toSorted()
      }
      // The brain first, then the Keychain (as Connections keeps a secret); repair and this run
      // in turn, so repair never reads it between the two.
      const event = (type: string, payload: unknown) =>
        brain
          .ingest([{ id: EventId.make(crypto.randomUUID()), type, source: "connections", payload }])
          .pipe(Effect.orDie)
      yield* event(ConnectionAdded.type, { id, provider, account, scopes })
      const value =
        grant.kind === "oauth"
          ? { client: `${provider}-${grant.client}`, refresh_token: grant.refresh }
          : { kind: "key", secret: grant.secret }
      const wrote = yield* Effect.result(
        Effect.try(() => {
          keychain.write(id, JSON.stringify(value))
        }),
      )
      // Read back: a key counts once its new home holds exactly it.
      if (
        wrote._tag !== "Success" ||
        (grant.kind !== "oauth" &&
          str(parseJson(keychain.read(SERVICE, id)).secret) !== grant.secret)
      ) {
        keychain.remove(id)
        yield* event(ConnectionRemoved.type, { id })
        yield* Effect.logWarning(`connections: ${id} didn't keep; ${service} unchanged`)
        return "retry" satisfies Migrated
      }
    }
    for (const { id } of grants) {
      if (!(yield* answers(id))) {
        yield* Effect.logWarning(`connections: ${id} didn't answer; ${service} unchanged`)
        return "retry" satisfies Migrated
      }
    }
    yield* brain
      .ingest([
        {
          id: EventId.make(`connection.migrated:${service}:moved`),
          type: ConnectionsMigrated.type,
          source: "connections",
          payload: { service, provider, ids: grants.map((g) => g.id) },
        },
      ])
      .pipe(Effect.orDie)
    yield* Effect.logInfo(`connections: ${String(grants.length)} from ${service}`)
    return "done" satisfies Migrated
  })

/** Watches what extensions need for accounts kept the old way, and moves each service in. */
export const migrations = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.gen(function* watching() {
      const connections = yield* Connections
      // When each service is looked at again: after a failure, soon.
      const next = new Map<string, number>()
      for (;;) {
        yield* connections.repair.pipe(Effect.ignore)
        for (const n of connections.legacy()) {
          if ((next.get(n.legacy) ?? 0) <= Date.now()) {
            const got = yield* migrate(n.legacy, n.provider, n.kind).pipe(
              Effect.catchCause((cause) => Effect.as(Effect.logWarning(cause), "retry" as const)),
            )
            const wait = got === "done" ? Number.POSITIVE_INFINITY : 10 * MINUTE
            next.set(n.legacy, Date.now() + wait)
          }
        }
        yield* Effect.sleep("30 seconds")
      }
    }),
  ),
)

// The app: what the agent and the client call

const list = tool(
  "list",
  {
    description:
      "Accounts the user connected, each with its scopes and any an extension needs but lacks, and what extensions need per provider.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const c = yield* Connections
      return { connections: yield* c.list, needs: c.needs() }
    }),
)

const request = tool(
  "request",
  {
    description:
      'Ask the user to connect an account an extension needs (or to grant one more scopes): an action item, by the need\'s kind a Connect button (oauth), a sealed field the user types a key into that goes straight to the Keychain (key; account names it, else "default"), or a sign-in through the extension that holds the session (session). Existing grants and declared sign-in recovery are attempted first. Complete authorized routine sign-in and consent yourself; never ask for a key or verification code in text.',
    input: Schema.Struct({
      provider: Schema.String,
      /** An account already connected that lacks scopes, or the name a key is kept under. */
      account: Schema.optionalKey(Schema.String),
      space: Schema.optionalKey(SpaceId),
      bypass: Bypass,
    }),
  },
  ({ bypass, ...input }) =>
    Effect.gen(function* asking() {
      const c = yield* Connections
      const recovered = yield* c.recover(input.provider, input.account)
      if (recovered.connected) {
        return recovered
      }
      if (recovered.blocked === "declined") {
        return { ...recovered, suppressed: true }
      }
      // An ask like any other: the gate first, as Switchboard's gates read every ask it made.
      const need = yield* c.provider(input.provider)
      const named = input.account === undefined ? "" : ` ${input.account}`
      const titles = {
        key: `${need.label} key${named}`,
        session: `Sign in to ${need.label}${named}`,
        oauth: `Connect ${need.label}${named}`,
      }
      // Where it's asked: the space given, else the asking work's, else Home (spaceFor).
      const caller = yield* Caller
      const brain = yield* Brain
      const space = yield* brain.read((db) => spaceFor(db, input.space, caller.space))
      // Keyed by the asking work, as Switchboard's gates were (kernels/gates.rs:648).
      const asker = yield* callerOf("connections_request", gave("provider", input.provider))
      const verdict = yield* gate("item", {
        key: `item:${asker ?? "nowhere"}`,
        space,
        text: titles[need.kind],
        context: "",
        bypass,
        work: asker ?? space,
      }).pipe(Effect.orElseSucceed(() => ({ pass: true, reasons: [] })))
      if (!verdict.pass) {
        return { opened: false, connected: false, why: `${verdict.reasons.join(" ")} ${BYPASS}` }
      }
      const asked = yield* c.ask({
        ...input,
        space,
        ...(recovered.blocked === undefined ? {} : { blocked: recovered.blocked }),
      })
      return {
        ...asked,
        connected: false,
        ...(recovered.blocked === undefined ? {} : { blocked: recovered.blocked }),
      }
    }),
)

const save = tool(
  "save",
  {
    description:
      "Connect a key from a file on this Mac that holds it alone, straight into the Keychain: only how many characters it held comes back. Its asks stay open: close them once the extension that uses it works, and delete the file.",
    input: Schema.Struct({
      provider: Schema.String,
      /** The name the key is kept under; else "default". */
      account: Schema.optionalKey(Schema.String),
      file: Schema.String,
    }),
  },
  (input) =>
    Effect.gen(function* saving() {
      const c = yield* Connections
      return yield* c.save(input)
    }),
)

const answer = tool(
  "answer",
  {
    description: "A sealed key's answer, from the core, or an ask closing.",
    appOnly: true,
    input: Schema.Struct({
      item: Schema.String,
      status: Schema.optionalKey(Schema.String),
      use: Schema.optionalKey(Schema.String),
      enc: Schema.optionalKey(Schema.String),
      ct: Schema.optionalKey(Schema.String),
      answer: Schema.optionalKey(Schema.Unknown),
    }),
  },
  (input) =>
    Effect.gen(function* answering() {
      const c = yield* Connections
      return yield* c.answer(input)
    }),
)

const connect = tool(
  "connect",
  {
    description:
      "Open the provider's consent in the system browser; for a key, the sealed ask it's typed into.",
    appOnly: true,
    input: Schema.Struct({
      provider: Schema.String,
      account: Schema.optionalKey(Schema.String),
      redirectUri: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* connecting() {
      const c = yield* Connections
      return yield* c.connect(input.provider, input.account, input.redirectUri)
    }),
)

const recoverAuthorization = tool(
  "recover",
  {
    description:
      "Refresh and verify existing grants, then run the declaring extension's private sign-in recovery. Use before asking the user to connect. Routine authorized consent and fresh inbox/text challenges are handled by the extension; no credentials are returned.",
    input: Schema.Struct({ provider: Schema.String, account: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* recovering() {
      const connections = yield* Connections
      return yield* connections.recover(input.provider, input.account)
    }),
)

const disconnect = tool(
  "disconnect",
  {
    description: "Revoke a connection and forget its tokens.",
    appOnly: true,
    input: Schema.Struct({ id: Schema.String }),
  },
  (input) =>
    Effect.gen(function* removing() {
      const c = yield* Connections
      yield* c.disconnect(input.id)
      return { removed: input.id }
    }),
)

const verify = tool(
  "verify",
  {
    description:
      "Check the extension's actual session and close its connection ask once signed in.",
    appOnly: true,
    input: Schema.Struct({ provider: Schema.String, account: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* verifying() {
      const c = yield* Connections
      return yield* c.verify(input.provider, input.account)
    }),
)

const readiness = tool(
  "readiness",
  {
    description: "OAuth client kinds and registered redirect URIs, never credentials.",
    readOnly: true,
    input: Schema.Struct({ provider: Schema.String }),
  },
  (input) =>
    Effect.gen(function* inspecting() {
      const c = yield* Connections
      return yield* c.readiness(input.provider)
    }),
)

const oauthClient = tool(
  "client",
  {
    description:
      "Keep the OAuth client the user registered for a provider: its client id, public, for PKCE on a loopback redirect (http://127.0.0.1/oauth/callback, any port). Then request the connection.",
    input: Schema.Struct({ provider: Schema.String, client_id: Schema.String }),
  },
  (input) =>
    Effect.gen(function* keeping() {
      yield* Effect.try(() => providerOf(input.provider))
      if (input.client_id.trim() === "") {
        return yield* Effect.fail(new Error("No client id"))
      }
      keychain.write(
        `client:${input.provider}`,
        JSON.stringify({ installed: { client_id: input.client_id.trim() } }),
      )
      return { kept: `client:${input.provider}` }
    }),
)

const finishConsent = tool(
  "finish",
  {
    description:
      "Relay a provider's callback from the user's client directly to its pending PKCE flow.",
    appOnly: true,
    input: Schema.Struct({
      state: Schema.String,
      code: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* finishing() {
      const c = yield* Connections
      return yield* c.finish(input)
    }),
)

export const connectionsApp = defineApp<Connections | Brain | Models>({
  name: "connections",
  version: "1",
  instructions:
    "Accounts for extensions. Recover existing grants and authorized routine sign-in before asking the user. request attempts recovery first; only irreducible human challenges belong in their queue: a key you can make or find yourself goes in with save. Never put passwords or verification codes in chat.",
  tools: [
    list,
    request,
    save,
    recoverAuthorization,
    connect,
    disconnect,
    answer,
    verify,
    readiness,
    oauthClient,
    finishConsent,
  ],
})

/** `/connections/token?id=`: an access token, for extensions on this machine only. */
export const tokenRoute = HttpRouter.add(
  "GET",
  "/connections/token",
  Effect.gen(function* serving() {
    const asked = yield* HttpServerRequest.HttpServerRequest
    const ip = Option.getOrElse(asked.peerAddress, () => "")
    const local = ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")
    if (!local) {
      return HttpServerResponse.text("Local only", { status: 403 })
    }
    const id = new URL(asked.url, "http://x").searchParams.get("id") ?? ""
    const c = yield* Connections
    return yield* c.token(id).pipe(
      Effect.map((t) => HttpServerResponse.jsonUnsafe(t)),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 404 })),
      ),
    )
  }),
)
