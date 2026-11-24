import { Context, Effect, Layer } from "effect"

import { ModelError } from "./types.ts"
import type { Completion } from "./types.ts"

/** Heavy models, on the user's Claude subscription through Claude Code. Sessions build this. */
export class ClaudeCode extends Context.Service<
  ClaudeCode,
  {
    readonly run: (request: {
      readonly model: string
      readonly account?: string
      readonly system: string
      readonly prompt: string
    }) => Effect.Effect<Completion, ModelError>
  }
>()("switch/ClaudeCode") {
  static readonly stub = Layer.succeed(ClaudeCode, {
    run: () => Effect.fail(new ModelError({ reason: "Claude Code sessions not built" })),
  })
}
