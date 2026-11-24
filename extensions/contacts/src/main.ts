// Contacts as a stdio MCP server: `bun src/main.ts`. With a word, a one-off that needs no models:
//   push [apple|google] [--dry]  send what changed (backs both books up first, the first time)
//   backup                       both address books to <dir>/contacts-backup/<date>/
//   undo <batch>
// Importing decides with the host's models: the `import` tool.
import { Models, serveStdio } from "switch-ext-kit"
import { Effect, Layer } from "effect"

import { contactsApp } from "./app.ts"
import { backup, push } from "./push.ts"
import { background } from "./run.ts"
import { batchId, logLayer, moveLegacy } from "./store.ts"
import { undo } from "./undo.ts"

const services = Layer.mergeAll(logLayer(), Models.layer)

const say = (x: unknown) =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(x, null, 1)}\n`)
  })

const cli = (word: string, args: readonly string[]) =>
  Effect.gen(function* running() {
    if (word === "backup") {
      yield* say(yield* backup)
    } else if (word === "push") {
      const dry = args.includes("--dry")
      const only = args.find((a) => a === "apple" || a === "google")
      const targets: readonly ("apple" | "google")[] =
        only === undefined ? ["apple", "google"] : [only]
      for (const t of targets) {
        yield* say(yield* push(t, batchId(`push-${t}`), undefined, dry))
      }
    } else if (word === "undo") {
      yield* say(yield* undo(args[0] ?? ""))
    } else {
      yield* Effect.fail(new Error(`Unknown command ${word}`))
    }
  })

moveLegacy()
const word = process.argv.at(2)
if (word === undefined) {
  await serveStdio(contactsApp, Layer.provideMerge(background, services))
} else {
  await Effect.runPromise(
    cli(word, process.argv.slice(3)).pipe(Effect.provide(logLayer()), Effect.scoped),
  )
  process.exit(0)
}
