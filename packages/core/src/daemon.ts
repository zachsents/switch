// The daemon, a machine's host alone (with the agent turns the core places there), or the brain
// readied for this build.
import { BunRuntime } from "@effect/platform-bun"
import { discover } from "@switch/agent"
import { Effect, Layer } from "effect"

import { CoreConfig, osName } from "./config.ts"
import { dial, makeHost } from "./host.ts"
import { credential } from "./paired.ts"
import { redactLogs } from "./redaction.ts"
import { layerServer, prepare } from "./server.ts"

const host = Effect.gen(function* hosting() {
  const c = yield* CoreConfig
  if (c.core === null) {
    return yield* Effect.die(new Error("No core: set core in config.json or SWITCH_CORE"))
  }
  const { core } = c
  const made = yield* makeHost({
    dir: c.dir,
    machine: c.machine,
    os: osName(),
    provides: c.provides,
    core,
    ...(!process.argv.includes("--extensions-only") && {
      turns: { logins: c.logins.length > 0 ? c.logins : discover() },
    }),
  })
  const address = Effect.gen(function* addressing() {
    const url = new URL("/hosts", core)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("token", yield* credential(c.dir, core, c.machine))
    return url.href
  })
  return yield* dial(made, address)
}).pipe(
  Effect.scoped,
  // It took the core's release: what it ran is stopped, and launchd or systemd starts the new one.
  Effect.andThen(Effect.sync(() => process.exit(0))),
  Effect.provide(CoreConfig.layer),
)

// The CLI on the core's machine: `switch pairings`, `switch approve <code>`, `switch deny <code>`,
// `switch revoke <id>`, `switch rotate extension:<name>`, through the core's own routes.
const admin = (verb: string, arg: string) =>
  Effect.gen(function* administering() {
    const c = yield* CoreConfig
    const res = yield* Effect.promise(
      async () =>
        await (verb === "pairings"
          ? fetch(`${c.local}/auth`)
          : fetch(`${c.local}/auth/${verb}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                verb === "revoke" || verb === "rotate" ? { id: arg } : { code: arg },
              ),
            })),
    )
    const said = yield* Effect.promise(async () => await res.text())
    yield* Effect.sync(() => {
      console.log(said)
    })
  }).pipe(Effect.provide(CoreConfig.layer))

export const run = (command: string | undefined) => {
  // What it logs (the core's, a host's, a prepare's) never holds a secret.
  redactLogs()
  if (command === "host") {
    BunRuntime.runMain(host)
  } else if (
    command === "pairings" ||
    command === "approve" ||
    command === "deny" ||
    command === "revoke" ||
    command === "rotate"
  ) {
    BunRuntime.runMain(admin(command, process.argv.at(3) ?? ""))
  } else if (command === "prepare") {
    BunRuntime.runMain(prepare)
  } else if (command === undefined) {
    BunRuntime.runMain(Layer.launch(layerServer()))
  } else {
    // Only a bare `switch` is the core: one started by `switch --help` would reap the live core's
    // turns as its own leftovers.
    console.error(
      `Unknown command ${command}: switch [host [--extensions-only]|prepare|sb|event|guard|pairings|approve|deny|revoke|rotate]`,
    )
    process.exit(2)
  }
}
