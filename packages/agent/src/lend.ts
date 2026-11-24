// An account added at the core is everyone's: a turn on another machine runs on its login there,
// lent by the core. Each account's tokens are refreshed in one place only, its home at the core, so
// a refresh token, good once, is never spent by two (both CLIs rotate them on refresh). A machine
// it's lent to gets an access token and nothing to refresh it with.
//
// Claude Code: the core refreshes the login itself (Claude Code's own refresh, against its token
// endpoint) and writes it back where the CLI keeps it, the Keychain item for its CLAUDE_CONFIG_DIR
// (`security`, as Claude Code writes it) or `.credentials.json`; every session on it, at home and
// away, gets the access token on fd 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), so no CLI ever
// refreshes it. Codex: its home refreshes itself (`account/read` with refreshToken asks it to,
// early); a machine it's lent to gets its auth.json without the refresh token, in a home of its own.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Effect, Option, Redacted, Schema, Semaphore } from "effect"

import { DROP as CODEX_DROP } from "./codex.ts"
import { guarded, providerOf } from "./hosts.ts"
import type { Credential, Host, Machine } from "./hosts.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** A Claude access token is refreshed with less than this left: it lasts about 8 hours. */
const CLAUDE_REFRESH_BEFORE = 4 * HOUR
/** A Codex home is asked to refresh with less than this left of its access token (about 10 days). */
const CODEX_REFRESH_BEFORE = 48 * HOUR

// Claude Code's own OAuth client and token endpoint.
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

const Json = Schema.Record(Schema.String, Schema.Unknown)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Json))
const ClaudeOauth = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeOauth = Schema.decodeUnknownOption(ClaudeOauth)
const Refreshed = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Number,
  refresh_token_expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
})

const locks = new Map<string, Semaphore.Semaphore>()
const locked = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => {
  let semaphore = locks.get(key)
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1)
    locks.set(key, semaphore)
  }
  return semaphore.withPermit(effect)
}

const run = (argv: readonly string[], input?: string) =>
  Effect.promise(async () => {
    const child = Bun.spawn([...argv], {
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (input !== undefined && child.stdin) {
      void child.stdin.write(input)
      void child.stdin.end()
    }
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { out: out.trim(), code }
  })

/** The Keychain item Claude Code keeps a CLAUDE_CONFIG_DIR's login in. */
const claudeService = (configDir: string) =>
  `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`

interface Stored {
  readonly where: "keychain" | "file"
  readonly whole: typeof Json.Type
  /** `claudeAiOauth` whole, and what's read of it. */
  readonly inner: typeof Json.Type
  readonly oauth: typeof ClaudeOauth.Type
}
const decodeObject = Schema.decodeUnknownOption(Json)

const parseStored = (raw: string, where: Stored["where"]): Stored | null => {
  const whole = Option.orElse(decodeJson(raw), () =>
    /^[0-9a-f]+$/u.test(raw)
      ? decodeJson(Buffer.from(raw, "hex").toString("utf-8"))
      : Option.none(),
  )
  if (Option.isNone(whole)) {
    return null
  }
  const inner = decodeObject(whole.value.claudeAiOauth)
  const oauth = decodeOauth(whole.value.claudeAiOauth)
  return Option.isSome(inner) && Option.isSome(oauth)
    ? { where, whole: whole.value, inner: inner.value, oauth: oauth.value }
    : null
}

const readClaude = (configDir: string) =>
  Effect.gen(function* reading() {
    if (process.platform === "darwin") {
      const said = yield* run([
        "/usr/bin/security",
        "find-generic-password",
        "-a",
        userInfo().username,
        "-s",
        claudeService(configDir),
        "-w",
      ])
      if (said.code === 0 && said.out !== "") {
        return parseStored(said.out, "keychain")
      }
    }
    const file = path.join(configDir, ".credentials.json")
    return existsSync(file) ? parseStored(readFileSync(file, "utf-8"), "file") : null
  })

const writeClaude = (configDir: string, where: Stored["where"], whole: typeof Json.Type) =>
  Effect.gen(function* writing() {
    const text = JSON.stringify(whole)
    if (where === "file") {
      writeFileAtomic(path.join(configDir, ".credentials.json"), text, { mode: 0o600 })
      return true
    }
    // On stdin, as Claude Code writes it: never on a command line.
    const hex = Buffer.from(text, "utf-8").toString("hex")
    const said = yield* run(
      ["/usr/bin/security", "-i"],
      `add-generic-password -U -a "${userInfo().username}" -s "${claudeService(configDir)}" -X "${hex}"\n`,
    )
    return said.code === 0
  })

const refreshClaude = (oauth: typeof ClaudeOauth.Type) =>
  Effect.tryPromise(async () => {
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        ...(oauth.scopes !== undefined && { scope: oauth.scopes.join(" ") }),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`Claude token refresh: ${response.status}`)
    }
    return Schema.decodeUnknownSync(Refreshed)(await response.json())
  })

/**
 * A refreshed login the Keychain didn't take, kept beside its CLAUDE_CONFIG_DIR until it does: the
 * refresh rotated its token, so it's the only copy of the login, and a restart mustn't lose it.
 */
const heldFile = (configDir: string) => path.join(configDir, ".credentials.held.json")

const Held = Schema.Struct({ where: Schema.Literals(["keychain", "file"]), whole: Json })
const decodeHeld = Schema.decodeUnknownOption(Schema.fromJsonString(Held))

/** The login held for `configDir`, if one is; one that won't parse is left where it is. */
const heldOf = (configDir: string) =>
  Effect.gen(function* reading() {
    const file = heldFile(configDir)
    if (!existsSync(file)) {
      return null
    }
    const h = decodeHeld(readFileSync(file, "utf-8"))
    const stored = Option.isSome(h)
      ? parseStored(JSON.stringify(h.value.whole), h.value.where)
      : null
    if (stored === null) {
      yield* Effect.logError(`Claude login: ${file} doesn't parse`)
    }
    return stored
  })

const hold = (configDir: string, kept: Stored) => {
  writeFileAtomic(heldFile(configDir), JSON.stringify({ where: kept.where, whole: kept.whole }), {
    mode: 0o600,
  })
}

const release = (configDir: string) => {
  rmSync(heldFile(configDir), { force: true })
}

const credentialOf = (oauth: typeof ClaudeOauth.Type): Credential => ({
  secret: Redacted.make(oauth.accessToken),
  until: oauth.expiresAt,
})

/**
 * A Claude login's access token, refreshed first when it has under four hours left; null when the
 * login has none, or it lapses within minutes and can't be refreshed now.
 */
export const claudeCredential = (configDir: string) =>
  locked(
    configDir,
    Effect.gen(function* refreshing() {
      // A refresh the Keychain didn't take is still the login: it's saved before anything else.
      const unsaved = yield* heldOf(configDir)
      if (unsaved !== null && (yield* writeClaude(configDir, unsaved.where, unsaved.whole))) {
        release(configDir)
      }
      const stored = (yield* heldOf(configDir)) ?? (yield* readClaude(configDir))
      if (stored === null) {
        return null
      }
      const now = Date.now()
      if (stored.oauth.expiresAt - now > CLAUDE_REFRESH_BEFORE) {
        return credentialOf(stored.oauth)
      }
      const fresh = yield* Effect.option(refreshClaude(stored.oauth))
      if (Option.isNone(fresh)) {
        yield* Effect.logWarning("Claude login: refresh failed")
        return stored.oauth.expiresAt - now > 5 * MINUTE ? credentialOf(stored.oauth) : null
      }
      const r = fresh.value
      const oauth = {
        ...stored.inner,
        accessToken: r.access_token,
        refreshToken: r.refresh_token ?? stored.oauth.refreshToken,
        expiresAt: now + r.expires_in * 1000,
        ...(r.refresh_token_expires_in !== undefined && {
          refreshTokenExpiresAt: now + r.refresh_token_expires_in * 1000,
        }),
        ...(r.scope !== undefined && { scopes: r.scope.split(" ").filter((s) => s !== "") }),
      }
      // Written back only over the login it was refreshed from.
      const again = (yield* heldOf(configDir)) ?? (yield* readClaude(configDir))
      if (again?.oauth.refreshToken === stored.oauth.refreshToken) {
        const whole = { ...again.whole, claudeAiOauth: oauth }
        let saved = yield* writeClaude(configDir, again.where, whole)
        for (let tries = 1; !saved && tries < 3; tries += 1) {
          yield* Effect.sleep("1 second")
          saved = yield* writeClaude(configDir, again.where, whole)
        }
        const kept = parseStored(JSON.stringify(whole), again.where)
        if (saved) {
          release(configDir)
        } else if (kept !== null) {
          yield* Effect.logError("Claude login: refreshed but not saved; held beside it")
          yield* Effect.ignore(
            Effect.try(() => {
              hold(configDir, kept)
            }),
            { log: "Error", message: "Claude login: couldn't hold it" },
          )
        }
      }
      return { secret: Redacted.make(r.access_token), until: oauth.expiresAt }
    }),
  )

/** When a JWT lapses, in ms; 0 when it doesn't say. */
const expiryOf = (jwt: string) => {
  const payload = decodeJson(Buffer.from(jwt.split(".").at(1) ?? "", "base64url").toString("utf-8"))
  const exp = Option.isSome(payload) ? payload.value.exp : undefined
  return typeof exp === "number" ? exp * 1000 : 0
}

const readCodex = (home: string) => {
  const file = path.join(home, "auth.json")
  if (!existsSync(file)) {
    return null
  }
  const whole = decodeJson(readFileSync(file, "utf-8"))
  if (Option.isNone(whole)) {
    return null
  }
  const tokens = decodeObject(whole.value.tokens)
  const access = Option.isSome(tokens) ? tokens.value.access_token : undefined
  return Option.isSome(tokens) && typeof access === "string"
    ? { whole: whole.value, tokens: tokens.value, until: expiryOf(access) }
    : null
}

/** Codex refreshes its login at home, through its own app server, as `account/read` asks. */
const refreshCodex = (owner: Host, home: string) =>
  Effect.gen(function* asking() {
    const proc = yield* owner.machine.spawn(["codex", "app-server"], {
      cwd: home,
      env: { ...guarded(owner.machine, CODEX_DROP), CODEX_HOME: home },
    })
    const done = (async () => {
      let pending = ""
      for await (const chunk of proc.stdout) {
        pending += new TextDecoder().decode(chunk)
        const rows = pending.split("\n")
        pending = rows.pop() ?? ""
        for (const row of rows) {
          const frame = decodeJson(row)
          const id = Option.isSome(frame) ? frame.value.id : undefined
          if (id === 1) {
            proc.write(`${JSON.stringify({ method: "initialized" })}\n`)
            proc.write(
              `${JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: true } })}\n`,
            )
          }
          if (id === 2) {
            return
          }
        }
      }
    })()
    proc.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "switch", version: "0.0.0" } } })}\n`,
    )
    yield* Effect.promise(async () => {
      await done
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
        }),
      ),
    )
  })

/** A Codex login's auth.json to lend: its access token without the refresh token. */
const codexAuth = (owner: Host, home: string) =>
  locked(
    home,
    Effect.gen(function* lending() {
      let auth = readCodex(home)
      if (auth !== null && auth.until - Date.now() < CODEX_REFRESH_BEFORE) {
        yield* refreshCodex(owner, home)
        auth = readCodex(home)
      }
      if (auth === null || auth.until - Date.now() < HOUR) {
        return null
      }
      return JSON.stringify({
        ...auth.whole,
        tokens: { ...auth.tokens, refresh_token: "" },
        last_refresh: new Date().toISOString(),
      })
    }),
  )

/** A login the core keeps, as its host at home: a Claude one runs on the token the core keeps fresh. */
export const ownedHost = (host: Host): Host =>
  providerOf(host) === "claude" && host.configDir !== undefined
    ? { ...host, token: claudeCredential(host.configDir) }
    : host

/** `owner`'s account lent to `machine`, in a home of its own there; null for a provider that isn't. */
export const lentHost = (owner: Host, machine: Machine): Host | null => {
  const provider = providerOf(owner)
  const { configDir } = owner
  if (configDir === undefined || (provider !== "claude" && provider !== "codex")) {
    return null
  }
  const home = path.join(
    machine.dir ?? path.join(machine.home, ".switch"),
    "accounts",
    provider,
    owner.id,
  )
  const lent = {
    id: `${machine.id}:${owner.id}`,
    provider,
    configDir: home,
    account: owner.id,
    lent: true,
  } as const
  if (provider === "claude") {
    return { ...lent, machine, token: claudeCredential(configDir) }
  }
  // Each process there starts on the login as it stands now.
  const provision = Effect.gen(function* provisioning() {
    const text = yield* codexAuth(owner, configDir)
    if (text !== null) {
      yield* machine.writeFile(path.join(home, "auth.json"), text, true)
    }
  })
  return {
    ...lent,
    machine: {
      ...machine,
      spawn: (argv, options) => Effect.andThen(provision, machine.spawn(argv, options)),
    },
  }
}
