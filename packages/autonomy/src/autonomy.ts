// Autonomy wired to the core: what the brain registers, the two slots it leaves open (memory and
// triage), and the workers that start work on their own (expectations, reflection, the senses watch,
// items that close themselves, after checks).
import { Sessions } from "@switch/agent"
import { Brain } from "@switch/brain"
import type { Line, SpaceId, StoredEvent, ThreadId } from "@switch/brain"
import { Models } from "@switch/models"
import type { Profile } from "@switch/models"
import { Effect, Layer } from "effect"

import { afterChecks } from "./after.ts"
import { expectationWorker, expectConfig } from "./expect.ts"
import { gateConfig } from "./gate.ts"
import { itemsConfig } from "./items.ts"
import { memoryConfig } from "./memory.ts"
import { promisesConfig, promisesKernel } from "./promises.ts"
import { memoryLayer } from "./recall.ts"
import { reflectConfig, reflecting } from "./reflect.ts"
import { reportsLayer } from "./report.ts"
import { resolveWatch } from "./resolve.ts"
import { rulesAt, wakeRulesOf } from "./rules.ts"
import { seedAlarms, seedMemories } from "./seeds.ts"
import { sensesWatch } from "./senses.ts"
import { dialNumber, settingsConfig, untune } from "./settings.ts"
import { surpriseConfig } from "./surprise.ts"
import { triageConfig, triageLayer } from "./triage.ts"
import type { TriageConfig } from "./triage.ts"

/** Events, projections and commands to add to the brain. */
export const autonomyConfig = {
  events: [
    ...triageConfig.events,
    ...expectConfig.events,
    ...promisesConfig.events,
    ...gateConfig.events,
    ...itemsConfig.events,
    ...memoryConfig.events,
    ...reflectConfig.events,
    ...surpriseConfig.events,
    ...settingsConfig.events,
  ],
  projections: [
    ...triageConfig.projections,
    ...expectConfig.projections,
    ...gateConfig.projections,
    ...itemsConfig.projections,
    ...memoryConfig.projections,
    ...reflectConfig.projections,
    ...surpriseConfig.projections,
    ...settingsConfig.projections,
  ],
  commands: [
    ...expectConfig.commands,
    ...itemsConfig.commands,
    ...memoryConfig.commands,
    ...surpriseConfig.commands,
  ],
}

export interface AutonomyConfig {
  readonly line: (event: StoredEvent) => Line | null
  /** A space's master thread. */
  readonly threadOf: (space: SpaceId) => ThreadId
  /** Dollars per reflection look. */
  readonly reflectUsd?: number
  /** Reflection's measures (measures.ts), read off the core's thread. */
  readonly measured?: Effect.Effect<string, unknown>
  /** A condition's line in a space's chat, when it has one. */
  readonly openLine: TriageConfig["openLine"]
  readonly openLines: TriageConfig["openLines"]
}

// The slots sit below Sessions, so they get models of their own, on the ClaudeCode the core gives
// them: a role the profile puts on a subscription (triage on Claude Code or Codex) runs there once
// Sessions is up, as the core's own do.
const smallModels = (profile: Profile | Effect.Effect<Profile>) => Models.layer(profile)

/** The Memory slot: core fields at launch, situational recall before each message. */
export const autonomyMemory = (profile: Profile | Effect.Effect<Profile>) =>
  memoryLayer.pipe(Layer.provide(smallModels(profile)))

/** The Reports slot: a task's report read before it reaches the user. */
export const autonomyReports = (profile: Profile | Effect.Effect<Profile>) =>
  reportsLayer.pipe(Layer.provide(smallModels(profile)))

/** The Triage slot, with the user's rules in its prompts, and their dials on its wakes. */
export const autonomyTriage = (
  config: AutonomyConfig & { readonly profile: Profile | Effect.Effect<Profile> },
) =>
  Layer.unwrap(
    Effect.gen(function* making() {
      const brain = yield* Brain
      return triageLayer({
        line: config.line,
        threadOf: config.threadOf,
        openLine: config.openLine,
        openLines: config.openLines,
        rules: (spaces, about) => brain.read((db) => rulesAt(db, spaces, about)),
        wakeRules: (spaces) => brain.read((db) => wakeRulesOf(db, spaces)),
        wakeAt: brain.read((db) => dialNumber(db, "wake.at")),
      })
    }),
  ).pipe(Layer.provide(smallModels(config.profile)))

/** A new brain's seed memories, expectations, promises, reflection, and the watch on senses. */
export const autonomyWorkers = (config: AutonomyConfig) =>
  Layer.effectDiscard(
    Effect.gen(function* working() {
      const sessions = yield* Sessions
      // The alarms after the seeds: a brain the seeds find holding them would be one that's not new.
      yield* Effect.forkScoped(
        Effect.andThen(
          Effect.ignore(seedMemories, { log: "Warn" }),
          Effect.ignore(seedAlarms, { log: "Warn" }),
        ),
      )
      yield* Effect.forkScoped(Effect.ignore(untune, { log: "Warn" }))
      // Each expectation wakes its work at most twice.
      yield* Effect.forkScoped(
        expectationWorker({
          threadOf: config.threadOf,
          kick: sessions.kick,
        }),
      )
      // What the agent says is read for promises, as Switchboard's promises kernel read it.
      yield* Effect.forkScoped(promisesKernel({ threadOf: config.threadOf }))
      // And by the checks that come after a message is in the chat, such as its links.
      yield* Effect.forkScoped(afterChecks)
      // Extensions in trouble wake Home's work at once.
      yield* Effect.forkScoped(sensesWatch({ threadOf: config.threadOf, kick: sessions.kick }))
      // Items that close themselves once their query finds something, as Switchboard's watches did.
      yield* Effect.forkScoped(resolveWatch)
      yield* Effect.forkScoped(
        reflecting({
          budgetUsd: config.reflectUsd ?? 2,
          measured: config.measured ?? Effect.succeed(""),
          // No host now: it waits, and starts once one can (sessions.ts `wait`).
          start: (id, title, task) =>
            sessions.send(id, task, { title }).pipe(
              Effect.asVoid,
              Effect.catchTag("NoHost", () => Effect.void),
            ),
        }),
      )
    }),
  )
