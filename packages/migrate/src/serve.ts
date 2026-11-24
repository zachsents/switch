// A look at an import before cutover: the brain file behind the client sync socket alone, with no
// agent, tagger or workers, so a client shows it and nothing runs on it.
import { BunHttpServer } from "@effect/platform-bun"
import { syncLayer } from "@switch/brain"
import { clientView } from "@switch/core"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"

export const serveLayer = (port: number) =>
  HttpRouter.serve(syncLayer(clientView), { disableLogger: true }).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
  )
