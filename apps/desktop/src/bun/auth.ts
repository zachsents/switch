// This app's credential for its core, kept in the Keychain. On the core's own machine the core mints
// one at once; elsewhere the app pairs: it asks with `POST /pair`, shows the code for the user to
// approve on another desktop (or with `switch approve` on the core's machine), and polls. One the
// core stops taking (revoked, said again and again) is dropped and paired again.
import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Effect, Option, Schema } from "effect"

import type { Auth } from "../shared/commands.ts"

const SERVICE = "Switchboard"
const SCOPES = ["client", "admin"]

const TAILSCALE = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].find((p) => existsSync(p))

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ core: Schema.optionalKey(Schema.String) })),
)
const decodeSelf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) })),
)
const decodeMinted = Schema.decodeUnknownOption(Schema.Struct({ token: Schema.String }))
const decodeAsked = Schema.decodeUnknownOption(
  Schema.Struct({ pairing: Schema.String, token: Schema.String, code: Schema.String }),
)
const decodeStatus = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.String }))

/** The core this Mac's Switch config names, if it names one. */
const configured = () => {
  const file = path.join(homedir(), ".switch", "config.json")
  if (!existsSync(file)) {
    return null
  }
  return Option.getOrNull(decodeConfig(readFileSync(file, "utf-8")))?.core ?? null
}

/** This Mac as the core names machines: its Tailscale name, else its host name. */
export const machineName = () => {
  const fallback = (hostname().split(".")[0] ?? "mac").toLowerCase()
  if (TAILSCALE === undefined) {
    return fallback
  }
  const done = Bun.spawnSync([TAILSCALE, "status", "--self", "--json"], { stderr: "ignore" })
  const s = Option.getOrNull(decodeSelf(done.stdout.toString()))
  return s?.Self.DNSName.split(".")[0] ?? fallback
}

const computerName = () => {
  const done = Bun.spawnSync(["scutil", "--get", "ComputerName"], { stderr: "ignore" })
  return done.stdout.toString().trim() || hostname()
}

const httpOf = (core: string) => {
  const url = new URL(core)
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:"
  return url.origin
}

const loopback = (core: string) => /^(?:127\.|localhost$|\[::1\]$)/u.test(new URL(core).hostname)

/** A JSON answer and its status; null when the core can't be reached. */
const json = (url: string, init: RequestInit = {}) =>
  Effect.promise(async () => {
    const res = await fetch(url, init).catch(() => null)
    if (res === null) {
      return null
    }
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  })

const key = (core: string) => ({ service: SERVICE, name: core })

/** Whether the core says no to `token` this once. */
const refused = (core: string, token: string) =>
  json(`${core}/auth/self`, { headers: { authorization: `Bearer ${token}` } }).pipe(
    Effect.map((r) => r?.status === 401),
  )

/** How many times running the core must say no before a token's dropped: a core starting up
 * (a redeploy) may say it once. */
const REFUSALS = 3

/** Whether the core still takes `token`: false only when it says so again and again. */
const good = (core: string, token: string) =>
  Effect.gen(function* checking() {
    for (let i = 0; i < REFUSALS; i += 1) {
      if (i > 0) {
        yield* Effect.sleep("5 seconds")
      }
      if (!(yield* refused(core, token))) {
        return true
      }
    }
    return false
  })

const asking = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

/** A credential straight from the core on its own machine. */
const mint = (core: string) =>
  json(`${core}/auth/mint`, asking({ name: computerName(), kind: "device", scopes: SCOPES })).pipe(
    Effect.map((r) => Option.getOrNull(decodeMinted(r?.body))?.token ?? null),
  )

/** Waits on one pairing: approved, or anything else that ends it. */
const waitOn = (core: string, pairing: string, token: string) =>
  Effect.gen(function* waiting() {
    for (;;) {
      yield* Effect.sleep("2 seconds")
      const polled = yield* json(`${core}/pair/${pairing}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const status = Option.getOrNull(decodeStatus(polled?.body))?.status ?? "waiting"
      if (status !== "waiting") {
        return status
      }
    }
  })

/** Pairs, showing each code it waits on; the token once approved. */
const pair = (core: string, show: (code: string) => void) =>
  Effect.gen(function* pairing() {
    for (;;) {
      const asked = yield* json(
        `${core}/pair`,
        asking({ name: computerName(), kind: "device", scopes: SCOPES }),
      )
      const a = Option.getOrNull(decodeAsked(asked?.body))
      if (a === null) {
        yield* Effect.sleep("10 seconds")
        continue
      }
      show(a.code)
      if ((yield* waitOn(core, a.pairing, a.token)) === "approved") {
        return a.token
      }
    }
  })

// The Keychain, else (when it won't answer, as it may not for a build signed differently) a file
// only this user can read.
const FILE = path.join(homedir(), ".switch", "desktop-credential.json")
const decodeFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)
const fromFile = () =>
  existsSync(FILE) ? (Option.getOrNull(decodeFile(readFileSync(FILE, "utf-8"))) ?? {}) : {}
const toFile = (all: Readonly<Record<string, string>>) => {
  writeFileAtomic(FILE, JSON.stringify(all), { mode: 0o600 })
}

const secret = {
  get: (core: string) =>
    Effect.promise(async () => {
      const kept = await Bun.secrets.get(key(core)).catch(() => null)
      return kept ?? fromFile()[core] ?? null
    }),
  set: (core: string, value: string) =>
    Effect.promise(async () => {
      const kept = await Bun.secrets
        .set({ ...key(core), value })
        .then(() => true)
        .catch(() => false)
      if (!kept) {
        toFile({ ...fromFile(), [core]: value })
      }
    }),
  drop: (core: string) =>
    Effect.promise(async () => {
      await Bun.secrets.delete(key(core)).catch(() => false)
      const { [core]: _, ...rest } = fromFile()
      if (existsSync(FILE)) {
        toFile(rest)
      }
    }),
}

/**
 * Keeps this app paired with its core and tells `send` each change: the code while it pairs, then
 * the core and token. `fallback` is the core when nothing here names one.
 */
export const keepPaired = (fallback: string, send: (a: Auth) => void) => {
  const core = httpOf(process.env.SWITCH_CORE ?? configured() ?? fallback)
  const once = Effect.gen(function* keeping() {
    let token = yield* secret.get(core)
    if (token !== null && !(yield* good(core, token))) {
      yield* secret.drop(core)
      token = null
    }
    if (token === null) {
      token = loopback(core) ? yield* mint(core) : null
      token ??= yield* pair(core, (code) => {
        send({ core, code })
      })
      yield* secret.set(core, token)
    }
    send({ core, token })
    while (yield* good(core, token)) {
      yield* Effect.sleep("1 minute")
    }
  })
  Effect.runFork(Effect.forever(once))
}
