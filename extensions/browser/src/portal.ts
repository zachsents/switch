// An ask's live view (Switchboard's portals, its SPEC §11.4): this Mac's screen, streamed as H.264 by
// screen-relay's engine (pinned in package.json) on loopback, for the core to relay to the user's
// own apps. The engine is built here from the package once, started when a view opens and stopped
// once none is left. Every view gets a grant of its own, for one connection, which closing it
// revokes; the engine's own token never leaves this process. Opening one to drive brings its
// session's tab to the front first, since the engine shows the whole screen. Nothing of what it
// shows or what's typed in it passes through here.
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import * as chrome from "./chrome.ts"

const PACKAGE = path.resolve(
  path.dirname(Bun.resolveSync("screen-relay", import.meta.dir)),
  "../..",
)
const VERSION = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(readFileSync(path.join(PACKAGE, "package.json"), "utf-8")).version
const Grant = Schema.Struct({ id: Schema.String, token: Schema.String })
const DIR = path.join(chrome.HOME, "screen-relay", VERSION)
const ENGINE = path.join(DIR, "relay-engine")
const VIEWER = path.join(DIR, "viewer")
const TOKEN = path.join(chrome.HOME, "screen-relay", "token")
/** Homebrew's, where the engine's libraries (x264, libwebsockets) and pkg-config are. */
const BREW = "/opt/homebrew/bin:/usr/local/bin"
/** A grant lasts this long at most (the engine's own bound). */
const GRANT_S = 3600
/** The engine stops this long after its last view closes. */
const LINGER_MS = 60_000

let building: Promise<unknown> | null = null

/** Builds the engine from the pinned package, in a folder of its own that's gone after. */
const build = async () => {
  if (existsSync(ENGINE)) {
    return
  }
  const work = mkdtempSync(path.join(tmpdir(), "screen-relay-"))
  try {
    for (const part of ["Makefile", "src/engine"]) {
      cpSync(path.join(PACKAGE, part), path.join(work, part), { recursive: true })
    }
    const make = Bun.spawn(["make", "-j8", "relay-engine"], {
      cwd: work,
      env: { ...process.env, PATH: `${BREW}:${process.env.PATH ?? ""}` },
      stdout: "ignore",
      stderr: "pipe",
    })
    const [code, err] = await Promise.all([make.exited, new Response(make.stderr).text()])
    if (code !== 0) {
      const last = err.trim().split("\n").slice(-3).join(" ")
      throw new Error(
        `Can't build the screen engine (brew install pkgconf x264 libwebsockets): ${last}`,
      )
    }
    mkdirSync(DIR, { recursive: true })
    cpSync(path.join(PACKAGE, "dist/viewer"), VIEWER, { recursive: true })
    renameSync(path.join(work, "relay-engine"), ENGINE)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

interface Engine {
  readonly port: number
  readonly token: string
  readonly proc: Bun.Subprocess
}

let engine: Engine | null = null
let starting: Promise<Engine> | null = null
/** Each open grant, by its id, with when it runs out. */
const grants = new Map<string, number>()
let linger: Timer | null = null

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const { port } = probe
  void probe.stop(true)
  if (port === undefined) {
    throw new Error("No free port for the screen engine")
  }
  return port
}

const ask = async (e: Engine, method: string, route: string) =>
  await fetch(`http://127.0.0.1:${e.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${e.token}` },
  })

const answers = async (e: Engine) => {
  const up = await ask(e, "GET", "/capabilities").catch(() => null)
  return up?.ok === true
}

/** The engine ended: its views went with it. */
const gone = (e: Engine) => {
  if (engine === e) {
    engine = null
    grants.clear()
  }
}

const start = async (): Promise<Engine> => {
  if (building !== null) {
    await building
  }
  await build()
  const token = randomBytes(32).toString("hex")
  mkdirSync(path.dirname(TOKEN), { recursive: true })
  writeFileSync(TOKEN, token, { mode: 0o600 })
  chmodSync(TOKEN, 0o600)
  const port = freePort()
  const proc = Bun.spawn(
    [
      ENGINE,
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--token-file",
      TOKEN,
      "--viewer-dir",
      VIEWER,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const said = new Response(proc.stderr).text()
  const e = { port, token, proc }
  void proc.exited.then(() => {
    gone(e)
    return null
  })
  // Up when it answers; gone if it ends first (a permission it lacks says so on stderr).
  for (let i = 0; i < 100; i += 1) {
    if (proc.exitCode !== null) {
      const text = await said
      throw new Error(`The screen engine stopped: ${text.trim().split("\n").slice(-2).join(" ")}`)
    }
    if (await answers(e)) {
      return e
    }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error("The screen engine didn't come up")
}

const running = async () => {
  if (engine !== null) {
    return engine
  }
  starting ??= start().finally(() => {
    starting = null
  })
  engine = await starting
  return engine
}

/** Stops the engine once no view is left, after a minute. */
const settle = () => {
  const now = Date.now()
  for (const [id, until] of grants) {
    if (until <= now) {
      grants.delete(id)
    }
  }
  if (linger !== null) {
    clearTimeout(linger)
    linger = null
  }
  if (grants.size > 0) {
    linger = setTimeout(settle, Math.min(...grants.values()) - now + 1000)
    return
  }
  linger = setTimeout(() => {
    linger = null
    if (grants.size === 0 && engine !== null) {
      engine.proc.kill()
      engine = null
    }
  }, LINGER_MS)
}

export interface Opened {
  /** The engine's stream, on loopback here. */
  readonly url: string
  /** Offered as `bearer.<token>` beside `nsl1`: one connection's grant. */
  readonly token: string
  readonly grant: string
}

/**
 * A view of the screen for the core to relay: `watch` only shows it (a card's preview); `control`
 * drives it, with the session's tab brought to the front first.
 */
export const open = async (session: string, scope: "watch" | "control"): Promise<Opened> => {
  if (scope === "control") {
    await chrome.reach()
    await chrome.call("show", { session }, 10_000)
  }
  const e = await running()
  const made = await ask(e, "POST", `/grants/${scope}?ttl=${GRANT_S}&connections=1`)
  if (!made.ok) {
    throw new Error(`The screen engine refused a view (${made.status})`)
  }
  const g = Schema.decodeUnknownSync(Grant)(await made.json())
  grants.set(g.id, Date.now() + GRANT_S * 1000)
  settle()
  return {
    url: `ws://127.0.0.1:${e.port}/stream${scope === "watch" ? "?view=1" : "?take=1"}`,
    token: g.token,
    grant: g.id,
  }
}

/** Ends a view: its grant is revoked, which closes its connection. */
export const close = async (grant: string) => {
  if (!grants.delete(grant)) {
    return
  }
  const e = engine
  if (e !== null) {
    await ask(e, "DELETE", `/grants/${encodeURIComponent(grant)}`).catch(() => null)
  }
  settle()
}

/** Builds the engine ahead of the first view, so it doesn't wait on a compile. */
export const prepare = () => {
  building ??= build()
    .catch(() => null)
    .finally(() => {
      building = null
    })
}
