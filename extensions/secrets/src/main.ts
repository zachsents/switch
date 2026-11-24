// The secrets extension as a stdio MCP server: `bun src/main.ts`. With a word, a one-off for the
// vault Mac's owner at its terminal (or over ssh), which needs no Keychain:
//   approve <code>   approves the device or extension showing that code (the running extension does it)
//   status           the vault's devices and extensions, and how many items it holds (nothing secret)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Effect, Layer } from "effect"
import { Models, serveStdio } from "switch-ext-kit"

import { announce, heartbeat, secretsApp } from "./app.ts"
import { approveCode, serial, touched } from "./ops.ts"
import { devices, dir, extensions, grantAllowed, openDb, openVault, seedGrants } from "./store.ts"
import type { Vault } from "./store.ts"

/** Devices and extensions without their keys. */
const show = <A extends { key: string }>(xs: readonly A[]) => xs.map(({ key: _, ...rest }) => rest)

/** Where `approve` leaves a code for the running extension, and finds what it made of it. */
const ASKED = path.join(dir(), "approve")

const word = process.argv.at(2)
if (word === "approve") {
  const code = (process.argv.at(3) ?? "").replaceAll(/\D/gu, "")
  mkdirSync(ASKED, { recursive: true, mode: 0o700 })
  const asked = path.join(ASKED, code)
  writeFileSync(asked, "", { mode: 0o600 })
  for (let i = 0; i < 40 && existsSync(asked); i += 1) {
    await Bun.sleep(250)
  }
  const said = `${asked}.done`
  console.log(
    existsSync(said) ? readFileSync(said, "utf-8") : "The secrets extension isn't running",
  )
  rmSync(asked, { force: true })
  rmSync(said, { force: true })
  process.exit(0)
}
if (word === "status") {
  const db = { db: openDb() }
  const count = db.db
    .query<{ n: number }, []>("select count(*) as n from items where purged = 0")
    .get()
  console.log(
    JSON.stringify(
      { items: count?.n ?? 0, devices: show(devices(db)), extensions: show(extensions(db)) },
      null,
      1,
    ),
  )
  process.exit(0)
}
if (word !== undefined) {
  console.error(`Unknown command ${word}: approve <code> or status`)
  process.exit(2)
}

const vault = await openVault()
seedGrants(vault)
grantAllowed(vault)
const app = secretsApp(vault)

/** Approves each code left by `approve`, and says how it went beside it. */
const approvals = (v: Vault) =>
  Effect.promise(async () => {
    if (!existsSync(ASKED)) {
      return
    }
    for (const code of readdirSync(ASKED).filter((f) => /^\d{6}$/u.test(f))) {
      const said = await serial(async () => {
        try {
          const done = await approveCode(v, code)
          touched(v)
          return done
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      })
      writeFileSync(path.join(ASKED, `${code}.done`), said, { mode: 0o600 })
      rmSync(path.join(ASKED, code), { force: true })
    }
  })

const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(announce)
    yield* Effect.forkScoped(heartbeat(vault))
    yield* Effect.forkScoped(
      Effect.forever(Effect.andThen(approvals(vault), Effect.sleep("1 second"))).pipe(
        Effect.ignore,
      ),
    )
  }),
)

await serveStdio(app, Layer.provideMerge(background, Models.layer))
