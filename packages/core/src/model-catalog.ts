import { spawnProbe, cursorProbe, acpProbe, readProbe } from "@switch/agent/provider-probe"
// Read the installed harnesses' advertised models on each account's actual host. Never expose auth.
import path from "node:path"
import { homeEnv, Hosts, museEnv, providerOf } from "@switch/agent"
import type { Host } from "@switch/agent"
import { Brain, EventId } from "@switch/brain"
import { defaultProfiles } from "@switch/models"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { CoreConfig } from "./config.ts"
import {
  CatalogUpdated,
  currentProfile,
  ProfileSaved,
  ProfileSelected,
  profilesState,
} from "./profiles.ts"

/** JSON with every object's keys in order: the same catalog reads the same however it was built. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    typeof x === "object" && x !== null && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).toSorted(([a], [b]) => a.localeCompare(b)))
      : x,
  )

const CodexModels = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  ),
})
const CodexAccount = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      account: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ email: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
})
const ClaudeStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const FxModels = Schema.Struct({ ids: Schema.Array(Schema.String) })
const FxStatus = Schema.Struct({ auth: Schema.String })
const read = (host: Host, args: readonly string[]) =>
  Effect.gen(function* reading() {
    const proc = yield* spawnProbe(
      {
        ...host,
        machine: {
          ...host.machine,
          env: {
            ...(host.configDir === undefined ? host.machine.env : homeEnv(host.machine.env)),
            ...(host.configDir !== undefined && {
              FX_HOME: host.configDir,
              CODEX_HOME: host.configDir,
              CLAUDE_CONFIG_DIR: host.configDir,
            }),
            FX_PROVIDER: "gateway",
            FX_SOUND: "off",
          },
        },
      },
      args,
    )
    proc.end()
    return yield* Effect.gen(function* collecting() {
      const [stdout, stderr, code] = yield* Effect.promise(
        async () =>
          await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]),
      )
      if (code !== 0) {
        return ""
      }
      return stdout === "" ? stderr : stdout
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
        }),
      ),
    )
  })
/** Codex's models, and the email its login reports, from its app server. */
const codexModels = (host: Host) =>
  Effect.gen(function* listing() {
    const proc = yield* spawnProbe(
      {
        ...host,
        machine: {
          ...host.machine,
          env: {
            ...host.machine.env,
            ...(host.configDir !== undefined && { CODEX_HOME: host.configDir }),
          },
        },
      },
      ["codex", "app-server"],
    )
    const got = Promise.withResolvers<{ models: string[]; email: string }>()
    let models: string[] = []
    const consume = (async () => {
      let pending = ""
      for await (const chunk of proc.stdout) {
        pending += new TextDecoder().decode(chunk)
        const rows = pending.split("\n")
        pending = rows.pop() ?? ""
        for (const row of rows) {
          let v: unknown
          try {
            v = JSON.parse(row)
          } catch {
            continue
          }
          const frame = Schema.decodeUnknownOption(
            Schema.Struct({ id: Schema.optionalKey(Schema.Number) }),
          )(v)
          if (frame._tag === "Some" && frame.value.id === 1) {
            proc.write(`${JSON.stringify({ method: "initialized" })}\n`)
            proc.write(`${JSON.stringify({ id: 2, method: "model/list", params: {} })}\n`)
          }
          if (frame._tag === "Some" && frame.value.id === 2) {
            models = Schema.decodeUnknownSync(CodexModels)(v).result?.data.map((m) => m.id) ?? []
            proc.write(`${JSON.stringify({ id: 3, method: "account/read", params: {} })}\n`)
          }
          if (frame._tag === "Some" && frame.value.id === 3) {
            const account = Schema.decodeUnknownOption(CodexAccount)(v)
            const email = account._tag === "Some" ? account.value.result?.account?.email : ""
            got.resolve({ models, email: email ?? "" })
            return
          }
        }
      }
      got.resolve({ models, email: "" })
    })()
    proc.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "switch", version: "0.0.0" } } })}\n`,
    )
    return yield* Effect.promise(async () => await got.promise).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => ({ models, email: "" })),
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
          void consume
        }),
      ),
    )
  })
const probeOtherAcp = (host: Host, provider: string) => {
  const commands: Readonly<Record<string, string>> = { kiro: "kiro-cli" }
  const argumentsByProvider: Readonly<Record<string, readonly string[]>> = {
    grok: ["--permission-mode", "default", "agent", "stdio"],
    kiro: ["acp", "--agent-engine=v3", "--auth-method=cli"],
  }
  const launch = provider === "acp" ? host.acp : undefined
  return acpProbe(
    host,
    launch?.command ?? commands[provider] ?? provider,
    launch?.args ?? argumentsByProvider[provider] ?? ["acp"],
    launch?.env ?? {},
  )
}
/** Whether `claude auth status` says signed in, and the email it reports then. */
const claudeLogin = (status: string) => {
  if (status === "") {
    return { available: false, email: "" }
  }
  const { loggedIn, email } = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeStatus))(status)
  return { available: loggedIn, email: loggedIn ? (email ?? "") : "" }
}
export const probeAccount = (host: Host) =>
  Effect.gen(function* probing() {
    const provider = host.provider ?? "claude"
    let models: string[] = []
    let available = false
    let completion = false
    let email = ""
    if (provider === "claude") {
      ;({ available, email } = claudeLogin(yield* read(host, ["claude", "auth", "status"])))
      models = ["opus", "sonnet", "haiku"]
      completion = available
    } else if (provider === "codex") {
      const status = yield* read(host, ["codex", "login", "status"])
      const codex = yield* codexModels(host)
      ;({ models } = codex)
      available = status.includes("Logged in") && models.length > 0
      email = available ? codex.email : ""
      completion = available
    } else if (provider === "fx") {
      const status = yield* read(host, ["fx", "status", "--json"])
      const auth =
        status === ""
          ? "missing"
          : Schema.decodeUnknownSync(Schema.fromJsonString(FxStatus))(status).auth
      available = auth !== "missing"
      completion = auth === "AI_GATEWAY_API_KEY"
      const raw = yield* read(host, ["fx", "models", "--json"])
      models =
        raw === ""
          ? []
          : ["default", ...Schema.decodeUnknownSync(Schema.fromJsonString(FxModels))(raw).ids]
    } else if (provider === "cursor") {
      const state = yield* cursorProbe(host)
      return { host: host.id, provider, ...state }
    } else if (["grok", "kiro", "opencode", "acp"].includes(provider)) {
      const state = yield* probeOtherAcp(host, provider)
      return { host: host.id, provider, ...state }
    } else if (provider === "muse" || provider === "pi") {
      yield* provider === "muse"
        ? readProbe(
            {
              ...host,
              machine: { ...host.machine, env: { ...host.machine.env, ...museEnv(host) } },
            },
            ["muse", "usage", "--json"],
          )
        : read(host, [provider, "--version"])
      return {
        host: host.id,
        provider,
        available: true,
        models: ["default"],
        problem: "Sign-in unchecked",
      }
    }
    return {
      host: host.id,
      provider,
      available,
      completion,
      models,
      problem: available ? "" : "Not connected",
      ...(email !== "" && { email }),
    }
  }).pipe(
    Effect.catchTag("ProbeUnavailable", (e) =>
      Effect.succeed({
        host: host.id,
        provider: host.provider ?? "claude",
        available: false,
        models: [] as string[],
        problem: e.problem,
      }),
    ),
    Effect.timeout("20 seconds"),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      const code: unknown =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : ""
      if (
        !cause.reasons.every(Cause.isFailReason) &&
        code !== "ENOENT" &&
        code !== "EACCES" &&
        code !== "ENOEXEC"
      ) {
        return Effect.failCause(cause).pipe(Effect.orDie)
      }
      return Effect.succeed({
        host: host.id,
        provider: host.provider ?? "claude",
        available: false,
        models: [],
        problem: "Can't reach provider",
      })
    }),
  )

/**
 * Logins of one account, by host id: each the account's id. One account per email a provider's
 * login reports, wherever it's signed in. Its id is the login the core keeps (added at the core,
 * so it's lent everywhere), else the core machine's provider's own, else another of the core's,
 * else another machine's.
 */
const sameLogins = (
  probed: readonly {
    readonly host: string
    readonly provider: string
    readonly available: boolean
    readonly email?: string
  }[],
  all: readonly Host[],
  c: { readonly dir: string; readonly machine: string },
) => {
  const owned = path.join(c.dir, "logins") + path.sep
  const rank = (h: Host | undefined) => {
    if (h === undefined || h.machine.id !== c.machine) {
      return 3
    }
    if (h.configDir?.startsWith(owned) === true) {
      return 0
    }
    return h.id === providerOf(h) ? 1 : 2
  }
  const groups = new Map<string, string[]>()
  for (const a of probed) {
    if (a.available && a.email !== undefined && a.email !== "") {
      const key = `${a.provider}\n${a.email.toLowerCase()}`
      groups.set(key, [...(groups.get(key) ?? []), a.host])
    }
  }
  const same = new Map<string, string>()
  for (const ids of groups.values()) {
    const [first, ...rest] = ids.toSorted(
      (x, y) =>
        rank(all.find((h) => h.id === x)) - rank(all.find((h) => h.id === y)) || x.localeCompare(y),
    )
    if (first !== undefined) {
      for (const id of rest) {
        same.set(id, first)
      }
    }
  }
  return same
}

export class Profiles extends Context.Service<
  Profiles,
  {
    readonly current: Effect.Effect<ReturnType<typeof currentProfile>>
    readonly refresh: Effect.Effect<void>
  }
>()("switch/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function* making() {
      const brain = yield* Brain
      const hosts = yield* Hosts
      const c = yield* CoreConfig
      // Every machine's own logins; what's lent is its account's at home.
      const refresh = Effect.gen(function* refreshing() {
        const probed = yield* Effect.all(
          hosts.all.filter((h) => h.lent !== true).map(probeAccount),
          { concurrency: 4 },
        )
        const same = sameLogins(probed, hosts.all, c)
        // A login that couldn't say who it is now (its machine away, its CLI not answering) stays
        // the account it was found to be.
        const known = new Set(
          probed.filter((a) => a.available && "email" in a && a.email !== "").map((a) => a.host),
        )
        for (const a of (yield* brain.read(profilesState)).accounts) {
          for (const from of a.same ?? []) {
            if (!known.has(from) && !same.has(a.host)) {
              same.set(from, a.host)
            }
          }
        }
        yield* hosts.merge(same)
        const accounts = probed
          .filter((a) => !same.has(a.host))
          .map((a) => {
            const others = [...same].filter(([, to]) => to === a.host).map(([from]) => from)
            return others.length > 0 ? { ...a, same: others } : a
          })
        // The catalog as it was read last is no news: a poll of /models records nothing.
        const was = (yield* brain.read(profilesState)).accounts
        if (canonical(was) === canonical(accounts)) {
          return
        }
        yield* brain
          .ingest([
            {
              id: EventId.make(`catalog:${crypto.randomUUID()}`),
              type: CatalogUpdated.type,
              source: "core",
              payload: { accounts },
            },
          ])
          .pipe(Effect.orDie)
      })
      const state = yield* brain.read(profilesState)
      // Logins found the same account before, until the catalog is read again.
      yield* hosts.merge(
        new Map(
          state.accounts.flatMap((a) => (a.same ?? []).map((from) => [from, a.host] as const)),
        ),
      )
      // A brain with no profiles is given the defaults, each by an id of its own, so once only.
      if (state.profiles.length === 0) {
        yield* brain
          .ingest(
            defaultProfiles.map((p) => ({
              id: EventId.make(`profile:default:${p.name}`),
              type: ProfileSaved.type,
              source: "core",
              payload: { name: p.name, roles: p.roles },
            })),
          )
          .pipe(Effect.orDie)
      }
      if (state.active === "") {
        yield* brain
          .ingest([
            {
              id: EventId.make(`profile:initial:${crypto.randomUUID()}`),
              type: ProfileSelected.type,
              source: "core",
              payload: { name: c.profile },
            },
          ])
          .pipe(Effect.orDie)
      }
      // Read again whenever the logins change (a machine linking in, an account added or gone), so
      // a login of an account already here is one with it.
      let seen = ""
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* watching() {
            const ids = hosts.all
              .filter((h) => h.lent !== true)
              .map((h) => h.id)
              .toSorted()
              .join(" ")
            if (ids !== seen) {
              seen = ids
              yield* Effect.exit(refresh)
            }
            yield* Effect.sleep("1 minute")
          }),
        ),
      )
      return { current: brain.read(currentProfile), refresh }
    }),
  )
}
export const modelsRoute = Layer.unwrap(
  Effect.gen(function* routes() {
    const profiles = yield* Profiles
    const brain = yield* Brain
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/models",
        Effect.andThen(
          profiles.refresh,
          Effect.flatMap(brain.read(profilesState), (state) =>
            Effect.orDie(
              HttpServerResponse.json(state, {
                headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
              }),
            ),
          ),
        ),
      ),
    )
  }),
)
