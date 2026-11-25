// GET /route?text=: where a message the user writes with no space goes (`route`, membership's): the
// space it's plainly for, else Home. The desktop's composer asks as they type, to show it, and as
// they send. A read, so a quiet copy asks it too.
import { Brain, route } from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { line } from "./context.ts"
import { web } from "./web.ts"

export const routeRoute = Layer.unwrap(
  Effect.gen(function* routes() {
    const brain = yield* Brain
    const models = yield* Models
    return HttpRouter.add(
      "GET",
      "/route",
      web(async (request) => {
        const text = new URL(request.url).searchParams.get("text") ?? ""
        const space = await Effect.runPromise(
          route(line, text).pipe(
            Effect.provideService(Brain, brain),
            Effect.provideService(Models, models),
          ),
        )
        return Response.json({ space })
      }),
    )
  }),
)
