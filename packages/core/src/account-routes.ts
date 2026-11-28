// /auth/* is admin-only under authLayer. Neither request bodies nor OAuth replies enter the brain.
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { AccountId, NewAccount } from "./account-schema.ts"
import { Accounts } from "./account-service.ts"
import { web } from "./web.ts"

const Flow = Schema.Struct({ flowId: Schema.String.check(Schema.isMinLength(1)) })
const Code = Schema.Struct({
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
          return await respond(accounts.begin(input.provider))
        }),
      ),
      HttpRouter.add(
        "POST",
        "/auth/sign-ins/:flow/:action",
        privateWeb(async (request) => {
          const parts = new URL(request.url).pathname.split("/")
          const flowId = Schema.decodeUnknownSync(Flow.fields.flowId)(parts[3])
          switch (parts.at(4) ?? "") {
            case "complete": {
              const input = Schema.decodeUnknownSync(Code)(await request.json())
              return await respond(accounts.finish(flowId, input.code))
            }
            case "cancel": {
              return await respond(accounts.cancel(flowId))
            }
            default: {
              return json({ error: "Unknown sign-in action" }, 404)
            }
          }
        }),
      ),
      HttpRouter.add(
        "POST",
        "/auth/accounts/:id/:action",
        privateWeb(async (request) => {
          const parts = new URL(request.url).pathname.split("/")
          const id = Schema.decodeUnknownSync(AccountId)(parts[3])
          return (parts.at(4) ?? "") === "remove"
            ? await respond(accounts.remove(id))
            : json({ error: "Unknown account action" }, 404)
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
