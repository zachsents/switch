// The macOS extension as a stdio MCP server: what a host runs, from this Mac's extension folder.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { BunRuntime } from "@effect/platform-bun"
import { AppEvents, Models, OUTBOX_FILE, serve } from "switch-ext-kit"
import { Effect, Layer } from "effect"

import { machine, macosApp, watch } from "./app.ts"
import { register } from "./vault.ts"

// Asks the vault to allow this Mac now, so the user's approval comes before a secret is needed.
void register(`macos-${machine}`)

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* serving() {
      const done = yield* serve(macosApp, new StdioServerTransport())
      yield* Effect.forkScoped(watch)
      yield* done
    }),
  ).pipe(Effect.provide(Layer.merge(AppEvents.layer(macosApp, OUTBOX_FILE), Models.layer))),
)
