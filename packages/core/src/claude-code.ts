// The models' "turn" role on the real session runner: one Claude Code turn in a thread of its own,
// with restricted native tools and no Switch tools, closed when it ends.
import { Sessions } from "@switch/agent"
import type { SessionsShape } from "@switch/agent"
import { Brain, defineRead, ThreadId } from "@switch/brain"
import { ClaudeCode, ModelError } from "@switch/models"
import { Context, Deferred, Effect, Layer } from "effect"
import { profilesState } from "./profiles.ts"

/**
 * Sessions, once they're up. Memory, triage and the report read sit below Sessions (its launch
 * reads them), so their subscription roles reach it through this.
 */
export class LateSessions extends Context.Service<LateSessions, Deferred.Deferred<SessionsShape>>()(
  "switch/LateSessions",
) {
  static readonly layer = Layer.effect(LateSessions, Deferred.make<SessionsShape>())
  /** Hands Sessions over once built. */
  static readonly fill = Layer.effectDiscard(
    Effect.gen(function* filling() {
      yield* Deferred.succeed(yield* LateSessions, yield* Sessions)
    }),
  )
}

/** The profiles and the catalog: which accounts a completion may run on. */
const profilesRead = defineRead("core/claude-code/profiles", profilesState)

export const claudeCodeLayer = Layer.effect(
  ClaudeCode,
  Effect.gen(function* making() {
    const late = yield* LateSessions
    const brain = yield* Brain
    return {
      run: (request: {
        readonly model: string
        readonly account?: string
        readonly system: string
        readonly prompt: string
      }) =>
        Effect.gen(function* running() {
          const sessions = yield* Deferred.await(late)
          const thread = ThreadId.make(`run-${crypto.randomUUID()}`)
          return yield* Effect.gen(function* completing() {
            const split = request.model.indexOf(":")
            const provider = request.model.slice(0, split)
            const model = request.model.slice(split + 1)
            const catalog = yield* brain.read(profilesRead)
            const eligibleAccounts = new Set(
              catalog.accounts
                .filter(
                  (account) =>
                    account.available &&
                    account.completion === true &&
                    account.provider === provider &&
                    account.models.includes(model),
                )
                .map((account) => account.host),
            )
            const turn = yield* sessions.send(
              thread,
              `<instructions>\n${request.system}\n</instructions>\n\n${request.prompt}`,
              {
                title: "Completion",
                model: request.model,
                ...(request.account === undefined ? {} : { account: request.account }),
                permissions: { tools: [], mode: "dontAsk", delegate: false },
                once: true,
                eligibleAccounts,
              },
            )
            const end = yield* sessions.ended(turn)
            if (end.status !== "done") {
              return yield* new ModelError({ reason: `Subscription ${end.status}: ${end.result}` })
            }
            return { text: end.result, ms: end.ms, cost: end.costUsd }
          }).pipe(Effect.onInterrupt(() => Effect.ignore(sessions.interrupt(thread))))
        }).pipe(
          Effect.catchDefect(() =>
            Effect.fail(new ModelError({ reason: "Subscription completion failed" })),
          ),
          Effect.catchTags({
            NoHost: () => Effect.fail(new ModelError({ reason: "Every login is at its limit" })),
            Rejected: (r) => Effect.fail(new ModelError({ reason: r.reason })),
          }),
        ),
    }
  }),
)
