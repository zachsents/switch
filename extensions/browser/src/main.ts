// The browser extension as a stdio MCP server: what a host runs. It writes the Chrome extension and
// its relay where the browser loads them, says it's here to the vault, then takes the relay's
// connection and says what's in front.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Effect, Layer } from "effect"
import { AppEvents, Models, OUTBOX_FILE, serve } from "switch-ext-kit"

import { browserApp, watch } from "./app.ts"
import { install, serve as listen } from "./chrome.ts"
import { register } from "./keeper.ts"
import { prepare } from "./portal.ts"

install()
listen()
// The screen engine an ask's live view needs, built once per version.
prepare()
// The vault keeps its secrets: the browser says it's here, so the user can allow it.
void register()
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* serving() {
      const done = yield* serve(browserApp, new StdioServerTransport())
      yield* Effect.forkScoped(watch)
      yield* done
    }),
  ).pipe(
    Effect.provide(Layer.provideMerge(Models.layer, AppEvents.layer(browserApp, OUTBOX_FILE))),
  ),
)
// The host went: the socket the browser connects to goes with this process.
process.exit(0)
