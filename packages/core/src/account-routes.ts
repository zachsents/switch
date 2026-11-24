// /auth/* is admin-only under authLayer. Neither request bodies nor OAuth replies enter the brain.
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { AccountId, NewAccount } from "./account-schema.ts"
import { Accounts } from "./account-service.ts"
import { web } from "./web.ts"

const Flow = Schema.Struct({ flowId: Schema.String.check(Schema.isMinLength(1)) })
const Complete = Schema.Struct({
  ...Flow.fields,
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
})
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  })
const respond = async <A, E>(effect: Effect.Effect<A, E>) => {
  const result = await Effect.runPromise(Effect.result(effect))
  return result._tag === "Success"
    ? json(result.success)
    : json(
        {
          error:
            result.failure instanceof Error ? result.failure.message : "Account operation failed",
        },
        400,
      )
}
const privateWeb = (handler: (request: Request) => Promise<Response>) =>
  web(async (request) => {
    try {
      return await handler(request)
    } catch {
      return json({ error: "Invalid account request" }, 400)
    }
  })
export const accountsRoute = Layer.unwrap(
  Effect.gen(function* routes() {
    const accounts = yield* Accounts
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/auth/accounts",
        privateWeb(async () => await respond(accounts.list)),
      ),
      HttpRouter.add(
        "POST",
        "/auth/accounts",
        privateWeb(async (request) => {
          const input = Schema.decodeUnknownSync(NewAccount)(await request.json())
          return await respond(accounts.add(input.provider, input.id))
        }),
      ),
      HttpRouter.add(
        "POST",
        "/auth/accounts/:id/:action",
        privateWeb(async (request) => {
          const parts = new URL(request.url).pathname.split("/")
          const id = Schema.decodeUnknownSync(AccountId)(parts[3])
          const action = parts.at(4) ?? ""
          switch (action) {
            case "start": {
              return await respond(accounts.start(id))
            }
            case "complete": {
              const input = Schema.decodeUnknownSync(Complete)(await request.json())
              return await respond(accounts.finish(id, input.flowId, input.code))
            }
            case "cancel": {
              const input = Schema.decodeUnknownSync(Flow)(await request.json())
              return await respond(accounts.cancel(id, input.flowId))
            }
            case "signout": {
              return await respond(accounts.signout(id))
            }
            case "remove": {
              return await respond(accounts.remove(id))
            }

            default: {
              return json({ error: "Unknown account action" }, 404)
            }
          }
        }),
      ),
      HttpRouter.add(
        "POST",
        "/auth/cli/:provider/install",
        privateWeb(async (request) => {
          const provider = new URL(request.url).pathname.split("/").at(3)
          return await respond(accounts.install(provider ?? ""))
        }),
      ),
    )
  }),
)
