import { InstalledAgent } from "@switch/agent/acp-install"
// One file (~/.switch/config.json, or $SWITCH_CONFIG) and the environment, which wins. Every key is
// optional. A service, as T3 Code's ServerConfig.
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import type { Login } from "@switch/agent"
import type { BlobsConfig } from "@switch/brain"
import { SUBSCRIPTIONS } from "@switch/models"
import { Config, Context, Effect, Layer, Option, Schema } from "effect"

import { spec } from "./link.ts"
import type { Spec } from "./link.ts"

const extensionOptions = Schema.Record(
  Schema.String,
  Schema.Struct({
    readOnly: Schema.optionalKey(Schema.Boolean),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
)

const file = Schema.Struct({
  /** Bind address: 127.0.0.1, this machine's Tailscale address, or 0.0.0.0. */
  host: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  brain: Schema.optionalKey(Schema.String),
  /** Folder new threads work in. */
  cwd: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  /** Extensions run by command, beside those installed: stdio MCP servers. */
  apps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...spec.fields,
        /** What the machine running it must provide, like "macos" or "lan:printers". */
        needs: Schema.optionalKey(Schema.Array(Schema.String)),
        /** It runs on every machine with what it needs, as `<name>-<machine>`, never placed. */
        every: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  /** Per installed extension, by name: only its looking tools, and environment for it. */
  extensionOptions: Schema.optionalKey(extensionOptions),
  /** `extensionOptions` before extensions were renamed: read when that's missing. */
  spurOptions: Schema.optionalKey(extensionOptions),
  /** Send nothing: every tool that speaks for the user is refused. */
  readOnly: Schema.optionalKey(Schema.Boolean),
  /**
   * Published pages: `url`, the public address their links start with (a proxy's, like Tailscale
   * Funnel's), and `port`, where the core serves them alone on 127.0.0.1 for that proxy.
   */
  pages: Schema.optionalKey(
    Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      port: Schema.optionalKey(Schema.Number),
    }),
  ),
  /** This machine's name to the core: its Tailscale name when unset. */
  machine: Schema.optionalKey(Schema.String),
  /**
   * What this machine offers beyond its OS ("messages", "lan:printers", "browser"), and where
   * agent turns go: "always-on" first; "personal", the user's own laptop, last and guarded;
   * "no-turns", a server that keeps the core alone, none (its logins only lent).
   */
  provides: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The machine whose login profile has AI_GATEWAY_API_KEY, read over ssh when it isn't set here. */
  keyHost: Schema.optionalKey(Schema.String),
  /** The core a host on this machine reports to, like http://laptop:4871. */
  core: Schema.optionalKey(Schema.String),
  /** Subscription logins on this machine: each provider's default sign-in when empty. */
  logins: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        provider: Schema.optionalKey(Schema.Literals(SUBSCRIPTIONS)),
        configDir: Schema.optionalKey(Schema.String),
        acp: Schema.optionalKey(InstalledAgent),
        /** A token login (`claude setup-token`), by Keychain item. */
        keychain: Schema.optionalKey(
          Schema.Struct({ service: Schema.String, account: Schema.String }),
        ),
      }),
    ),
  ),
})
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(file))

export interface App extends Spec {
  readonly needs?: readonly string[]
  readonly every?: boolean
}

export interface ExtensionOptions {
  readonly readOnly?: boolean
  readonly env?: Readonly<Record<string, string>>
}

export interface CoreConfigShape {
  readonly host: string
  readonly port: number
  /** State: the brain, process records. */
  readonly dir: string
  readonly brain: string
  /** Files, beside the brain. */
  readonly blobs: BlobsConfig
  readonly cwd: string
  readonly profile: string
  readonly apps: readonly App[]
  readonly extensionOptions: Readonly<Record<string, ExtensionOptions>>
  readonly logins: readonly Login[]
  /** Nothing that speaks for the user goes out. */
  readonly readOnly: boolean
  /**
   * A deploy's canary beside the live core, on a copy of the brain: only what its health and turn
   * checks need. No extensions, pushes, notifications, triage, tagging, expectations, reflection,
   * covers, Keychain moves, or catch-up on what the copy left.
   */
  readonly canary: boolean
  readonly machine: string
  /** Its OS ("macos", "linux") and what the file adds. */
  readonly provides: readonly string[]
  readonly core: string | null
  /** Where this process's own sessions reach it. */
  readonly local: string
  /** Where pages' links start: the public address, else the core's on the private network. */
  readonly pagesUrl: string
  /** Where pages are served alone, on 127.0.0.1, for a public proxy; none without one. */
  readonly pagesPort: number | null
}

const TAILSCALE = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].find((p) => existsSync(p))

const selfOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) })),
)

/** A DNS name's first label, or null when it has none. */
const firstLabel = (name: string) => {
  const [first = ""] = name.split(".")
  return first === "" ? null : first
}

/**
 * This machine's name on its tailnet, or null when it's on none: Tailscale absent, logged out or
 * stopped (its DNS name empty then), or not answering.
 */
const tailnetName = () => {
  if (TAILSCALE === undefined) {
    return null
  }
  const done = Bun.spawnSync([TAILSCALE, "status", "--self", "--json"], { stderr: "ignore" })
  return Option.match(selfOf(done.stdout.toString()), {
    onNone: () => null,
    onSome: (v) => firstLabel(v.Self.DNSName),
  })
}

/** This machine as an address can name it: its tailnet name, else its host name. */
const hereName = () => tailnetName() ?? firstLabel(hostname()) ?? "localhost"

// Compiled, this binary is bun too, with BUN_BE_BUN set; under bun, bun is what runs it.
const compiled = Bun.main.startsWith("/$bunfs/")
/** How to run bun, for an extension's package: adding it and running its entry. */
export const BUN: { readonly argv: readonly string[]; readonly env: Record<string, string> } = {
  argv: [process.execPath],
  env: compiled ? { BUN_BE_BUN: "1" } : {},
}

export const osName = () => (process.platform === "darwin" ? "macos" : process.platform)

/** "laptop" on a Mac with a battery of its own: it takes turns after the steady machines. */
const hardware = () => {
  if (process.platform !== "darwin") {
    return []
  }
  const batt = Bun.spawnSync(["pmset", "-g", "batt"], { stderr: "ignore" })
  return batt.stdout.toString().includes("InternalBattery") ? ["laptop"] : []
}

const expand = (p: string) => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p)

/** Read-only, by $SWITCH_READ_ONLY, else the file's word. */
const readOnlyOf = (given: boolean | undefined) =>
  Config.Boolean("SWITCH_READ_ONLY").pipe(Config.withDefault(given === true))

const load = Effect.gen(function* loading() {
  const dir = yield* Config.String("SWITCH_DIR").pipe(
    Config.withDefault(path.join(homedir(), ".switch")),
  )
  mkdirSync(expand(dir), { recursive: true })
  const at = yield* Config.String("SWITCH_CONFIG").pipe(
    Config.withDefault(path.join(dir, "config.json")),
  )
  const f = existsSync(expand(at)) ? yield* decodeFile(readFileSync(expand(at), "utf-8")) : {}
  const host = yield* Config.String("SWITCH_HOST").pipe(Config.withDefault(f.host ?? "127.0.0.1"))
  const port = yield* Config.Port("SWITCH_PORT").pipe(Config.withDefault(f.port ?? 4871))
  const brain = yield* Config.String("SWITCH_BRAIN").pipe(
    Config.withDefault(f.brain ?? path.join(dir, "brain.db")),
  )
  const cwd = yield* Config.String("SWITCH_CWD").pipe(Config.withDefault(f.cwd ?? homedir()))
  const profile = yield* Config.String("SWITCH_PROFILE").pipe(
    Config.withDefault(f.profile ?? "claude"),
  )
  const canary = yield* Config.Boolean("SWITCH_CANARY").pipe(Config.withDefault(false))
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const here = hereName()
  const machine = yield* Config.String("SWITCH_MACHINE").pipe(Config.withDefault(f.machine ?? here))
  return {
    host,
    port,
    dir: expand(dir),
    brain: expand(brain),
    blobs: { dir: path.join(path.dirname(expand(brain)), "blobs") },
    cwd: expand(cwd),
    profile,
    apps: f.apps ?? [],
    extensionOptions: f.extensionOptions ?? f.spurOptions ?? {},
    logins: f.logins ?? [],
    readOnly: yield* readOnlyOf(f.readOnly),
    canary,
    machine,
    provides: [osName(), ...hardware(), ...(f.provides ?? [])],
    core: yield* Config.String("SWITCH_CORE").pipe(Config.withDefault(f.core ?? null)),
    local: `http://${reachable}:${port}`,
    // Never the machine's name as the user gave it ("Zoe's Mac"), which an address can't hold.
    pagesUrl: f.pages?.url ?? `http://${here}:${port}`,
    pagesPort: f.pages?.port ?? null,
  } satisfies CoreConfigShape
})

export class CoreConfig extends Context.Service<CoreConfig, CoreConfigShape>()(
  "switch/CoreConfig",
) {
  static readonly layer = Layer.effect(CoreConfig, load)
}
