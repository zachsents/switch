// A host's own credential for its core: kept in `<dir>/credential.json` (0600), made by pairing.
// It asks with `POST /pair`, logs the code for the user to approve on a desktop, and polls. A
// credential the core no longer takes is dropped and paired again.
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Effect, Option, Schema } from "effect"

const Saved = Schema.Struct({ core: Schema.String, token: Schema.String })
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved))
const Asked = Schema.Struct({ pairing: Schema.String, token: Schema.String, code: Schema.String })
const decodeAsked = Schema.decodeUnknownOption(Asked)
const Status = Schema.Struct({ status: Schema.String })
const decodeStatus = Schema.decodeUnknownOption(Status)

const POLL_MS = 3000

const fileOf = (dir: string) => path.join(dir, "credential.json")

const saved = (dir: string, core: string) => {
  const file = fileOf(dir)
  if (!existsSync(file)) {
    return null
  }
  const s = Option.getOrNull(decodeSaved(readFileSync(file, "utf-8")))
  return s !== null && s.core === core ? s.token : null
}

const save = (dir: string, core: string, token: string) => {
  writeFileAtomic(fileOf(dir), JSON.stringify({ core, token }), { mode: 0o600 })
}

const fetchJson = (url: string, init: RequestInit) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, init)
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  })

/** Whether the core still takes `token`: false only when it says so. */
const good = (core: string, token: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(new URL("/auth/self", core), {
      headers: { authorization: `Bearer ${token}` },
    })
    return res.status !== 401
  }).pipe(Effect.orElseSucceed(() => true))

const ask = (core: string, name: string) =>
  Effect.gen(function* asking() {
    for (;;) {
      const asked = yield* fetchJson(new URL("/pair", core).href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, kind: "host", scopes: ["host"] }),
      }).pipe(Effect.option)
      const made = asked.pipe(Option.flatMap((a) => decodeAsked(a.body)))
      if (Option.isSome(made)) {
        return made.value
      }
      yield* Effect.sleep("30 seconds")
    }
  })

const wait = (core: string, pairing: string, token: string) =>
  Effect.gen(function* waiting() {
    for (;;) {
      yield* Effect.sleep(POLL_MS)
      const polled = yield* fetchJson(new URL(`/pair/${pairing}`, core).href, {
        headers: { authorization: `Bearer ${token}` },
      }).pipe(Effect.option)
      const status = polled.pipe(
        Option.flatMap((p) => decodeStatus(p.body)),
        Option.map((s) => s.status),
        Option.getOrNull,
      )
      if (status === "approved" || status === "denied" || status === "gone") {
        return status
      }
    }
  })

/** This host's token for `core`, pairing as `name` first if it has none that works. */
export const credential = (dir: string, core: string, name: string) =>
  Effect.gen(function* getting() {
    const have = saved(dir, core)
    if (have !== null) {
      if (yield* good(core, have)) {
        return have
      }
      rmSync(fileOf(dir), { force: true })
      yield* Effect.logWarning("The core no longer takes this host's credential: pairing again")
    }
    for (;;) {
      const asked = yield* ask(core, name)
      yield* Effect.logInfo(`Pairing with the core: approve ${asked.code} on a desktop`)
      const status = yield* wait(core, asked.pairing, asked.token)
      if (status === "approved") {
        save(dir, core, asked.token)
        yield* Effect.logInfo("Paired")
        return asked.token
      }
      if (status === "denied") {
        yield* Effect.logWarning("Pairing denied")
        yield* Effect.sleep("10 minutes")
      }
    }
  })
