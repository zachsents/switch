// Accounts in the brain: each host's health and usage as `account.state`, so limits outlast a
// restart and the UI can show them. And the core's logins, as hosts: `account.added` and
// `account.removed` are the only record of which there are.
import type { Database } from "bun:sqlite"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Brain, EventId, defineEvent, on } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { isLoginProvider, LOGIN_PROVIDERS, SUBSCRIPTIONS } from "@switch/models"
import type { LoginProvider, Subscription } from "@switch/models"
import { Effect, Redacted, Schema } from "effect"

import type { Credential, Host, HostState, Machine } from "./hosts.ts"
import { providerOf } from "./hosts.ts"
import { ownedHost } from "./lend.ts"
import { InstalledAgent } from "./acp-install.ts"

const window = Schema.Struct({ name: Schema.String, used: Schema.Number, resetsAt: Schema.Number })

export const AccountState = defineEvent(
  "account.state",
  1,
  Schema.Struct({
    host: Schema.String,
    provider: Schema.Literals(SUBSCRIPTIONS),
    /** False while at a usage limit. */
    up: Schema.Boolean,
    /** ms; 0 when not limited. */
    limitedUntil: Schema.Number,
    /** Why it's down besides a usage limit: "Signed out". Empty when fine. */
    problem: Schema.String,
    /** The fullest window's share used, 0 to 1. */
    used: Schema.Number,
    windows: Schema.Array(window),
    running: Schema.Number,
  }),
)
export type Account = typeof AccountState.payload.Type

/** An account forgotten: it's no longer a host. */
export const AccountRemoved = defineEvent(
  "account.removed",
  1,
  Schema.Struct({ host: Schema.String }),
)

const login = Schema.Struct({
  host: Schema.String,
  provider: Schema.Literals(SUBSCRIPTIONS),
  /** Added at the core, in a home of its own there (`addedDir`): the core keeps it, and lends it. */
  owned: Schema.optionalKey(Schema.Boolean),
  configDir: Schema.optionalKey(Schema.String),
  /** A token login, by Keychain item. */
  keychain: Schema.optionalKey(Schema.Struct({ service: Schema.String, account: Schema.String })),
  acp: Schema.optionalKey(InstalledAgent),
})

/** A login of the core's: a host its turns can go to, until it's removed. */
export const AccountAdded = defineEvent("account.added", 1, login)

export const accountOf = (s: HostState): Account => ({
  host: s.account,
  provider: providerOf(s.host),
  up: s.up,
  limitedUntil: s.up ? 0 : s.limitedUntil,
  problem: s.problem,
  used: s.used,
  windows: s.windows,
  running: s.running,
})

interface Row {
  readonly state: string
}
const parseAccount: (json: string) => Account = JSON.parse

export const allAccounts = (db: Database) =>
  db
    .query<Row, []>("SELECT state FROM accounts ORDER BY host")
    .all()
    .map((r) => parseAccount(r.state))

const accountRow = (db: Database, host: string) => {
  const row = db.query<Row, [string]>("SELECT state FROM accounts WHERE host = ?").get(host)
  return row === null ? undefined : parseAccount(row.state)
}

/** Usage is news a step at a time, not each percent. */
const STEP = 0.05
const step = (used: number) => Math.floor(used / STEP + 1e-9)

/**
 * Whether an account's state is news against the last one logged: up or down, a problem, a
 * limit's end, a window added, gone or reset, or usage crossing a step. Sessions starting and
 * ending (`running`) and usage creeping within a step aren't: each event logged wakes triage.
 */
export const changed = (before: Account | undefined, after: Account) => {
  if (
    before === undefined ||
    before.provider !== after.provider ||
    before.up !== after.up ||
    before.problem !== after.problem ||
    before.limitedUntil !== after.limitedUntil ||
    step(before.used) !== step(after.used) ||
    before.windows.length !== after.windows.length
  ) {
    return true
  }
  return after.windows.some((w) => {
    const was = before.windows.find((b) => b.name === w.name)
    return was === undefined || was.resetsAt !== w.resetsAt || step(was.used) !== step(w.used)
  })
}

/** Logs an account's state when it's news against the last one logged; the only way it's logged. */
export const reportAccount = (account: Account) =>
  Effect.gen(function* reporting() {
    const brain = yield* Brain
    const before = yield* brain.read((db) => accountRow(db, account.host))
    if (!changed(before, account)) {
      return false
    }
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`account:${account.host}:${crypto.randomUUID()}`),
          type: AccountState.type,
          source: "agent",
          payload: account,
        },
      ]),
    )
    return true
  })

// `model.catalog` (the core's), read only for the logins it found to be another's account.
const decodeMerged = Schema.decodeUnknownSync(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({ same: Schema.optionalKey(Schema.Array(Schema.String)) }),
    ),
  }),
)

export const accounts: Projection = {
  name: "accounts",
  version: 2,
  tables: ["accounts"],
  create: "CREATE TABLE accounts (host TEXT PRIMARY KEY, state TEXT NOT NULL);",
  on: [
    on(AccountState, (db, p) => {
      db.query(
        "INSERT INTO accounts (host, state) VALUES (?, ?) ON CONFLICT (host) DO UPDATE SET state = excluded.state",
      ).run(p.host, JSON.stringify(p))
    }),
    on(AccountRemoved, (db, p) => {
      db.query("DELETE FROM accounts WHERE host = ?").run(p.host)
    }),
    // What was recorded of a login now another's account goes: it's that account's now. The login
    // itself stays.
    on({ type: "model.catalog", decode: decodeMerged }, (db, p) => {
      for (const a of p.accounts) {
        for (const from of a.same ?? []) {
          db.query("DELETE FROM accounts WHERE host = ?").run(from)
        }
      }
    }),
  ],
  snapshot: allAccounts,
}

const decodeLogin = Schema.decodeUnknownSync(Schema.fromJsonString(login))

/** The core's logins, as their `account.added` last said. */
export const allLogins = (db: Database): Login[] =>
  db
    .query<{ body: string }, []>("SELECT body FROM logins ORDER BY host")
    .all()
    .map((r) => {
      const { host, ...rest } = decodeLogin(r.body)
      return { id: host, ...rest }
    })

export const logins: Projection = {
  name: "logins",
  version: 1,
  tables: ["logins"],
  create: "CREATE TABLE logins (host TEXT PRIMARY KEY, body TEXT NOT NULL);",
  on: [
    on(AccountAdded, (db, p) => {
      db.query(
        "INSERT INTO logins (host, body) VALUES (?, ?) ON CONFLICT (host) DO UPDATE SET body = excluded.body",
      ).run(p.host, JSON.stringify(p))
    }),
    on(AccountRemoved, (db, p) => {
      db.query("DELETE FROM logins WHERE host = ?").run(p.host)
    }),
  ],
  snapshot: () => null,
}

/** A token in this Mac's Keychain, as Switchboard keeps `claude setup-token` logins. */
export const keychainToken = (service: string, account: string) =>
  Effect.sync((): Credential | null => {
    const out = Bun.spawnSync(
      ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    )
    const token = out.stdout.toString().trim()
    return out.exitCode === 0 && token !== ""
      ? { secret: Redacted.make(token), until: Number.POSITIVE_INFINITY }
      : null
  })

export interface Login {
  readonly acp?: InstalledAgent
  readonly id: string
  /** Claude when unset. */
  readonly provider?: Subscription
  readonly configDir?: string
  /** A token login, by Keychain item. */
  readonly keychain?: { readonly service: string; readonly account: string }
  /** Added at the core, in a home of its own there: the core keeps it, and lends it. */
  readonly owned?: boolean
}

/**
 * The logins here when none are configured: each provider's default sign-in that exists, on a
 * machine that has the program its turns run. A turn placed on a login whose program isn't here
 * only fails to start, so a machine without it offers none. `bin`: where the core keeps the CLIs
 * it installed, searched after PATH as its turns search it.
 */
export const discover = (bin?: string): Login[] => {
  const home = homedir()
  const PATH = [process.env.PATH ?? "", ...(bin === undefined ? [] : [bin])].join(":")
  const has = (command: string) => Bun.which(command, { PATH }) !== null
  const out: Login[] = has("claude") ? [{ id: "claude", provider: "claude" }] : []
  if (
    has("codex") &&
    existsSync(path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json"))
  ) {
    out.push({ id: "codex", provider: "codex" })
  }
  if (
    has("fx") &&
    ((process.env.AI_GATEWAY_API_KEY ?? "") !== "" || existsSync(path.join(home, ".fx")))
  ) {
    out.push({ id: "fx", provider: "fx" })
  }
  const commands: Readonly<Record<string, string>> = { cursor: "cursor-agent", kiro: "kiro-cli" }
  for (const provider of ["cursor", "muse", "pi", "grok", "opencode", "kiro"] as const) {
    if (
      has(commands[provider] ?? provider) ||
      (provider === "cursor" && existsSync(path.join(home, ".cursor", "sdk", "auth.json")))
    ) {
      out.push({ id: provider, provider })
    }
  }
  return out
}

export const hostsOf = (all: readonly Login[], machine: Machine): Host[] =>
  all.map((l) => {
    const host: Host = {
      id: l.id,
      machine,
      ...(l.acp === undefined ? {} : { acp: l.acp }),
      provider: l.provider ?? "claude",
      ...(l.configDir === undefined ? {} : { configDir: l.configDir }),
      ...(l.keychain === undefined
        ? {}
        : { token: keychainToken(l.keychain.service, l.keychain.account) }),
    }
    return l.owned === true ? ownedHost(host) : host
  })

/** Where the accounts of a provider added here keep their logins: a home each, by id. */
export const addedDir = (stateDir: string, provider: LoginProvider) =>
  path.join(stateDir, "logins", provider)

/** The homes of accounts added here, as folders: what made them logins before `account.added`. */
export const ownedHomes = (stateDir: string): Login[] =>
  LOGIN_PROVIDERS.flatMap((provider) => {
    const dir = addedDir(stateDir, provider)
    return existsSync(dir) &&
      realpathSync(dir) === path.join(realpathSync(stateDir), "logins", provider)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]{0,31}$/u.test(d.name))
          .map((d) => ({ id: d.name, provider, owned: true }))
      : []
  })

/** Logins with each added here at its home under `stateDir`. */
export const atHome = (stateDir: string, all: readonly Login[]): Login[] =>
  all.map((l) => {
    const provider = l.provider ?? "claude"
    return l.owned === true && isLoginProvider(provider)
      ? { ...l, configDir: path.join(addedDir(stateDir, provider), l.id) }
      : l
  })
