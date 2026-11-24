// A Web fetch handler as a route.
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

export const web =
  (fetch: (request: Request) => Promise<Response>) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((r) => Effect.promise(async () => await fetch(r))),
      Effect.map(HttpServerResponse.fromWeb),
      Effect.orElseSucceed(() => HttpServerResponse.text("Bad request", { status: 400 })),
    )
