// What autonomy fills: memory, triage and the read of a task's report. The defaults keep the core running without it.
import type { SpaceId, StoredEvent, ThreadId, TurnId } from "@switch/brain"
import { Context, Effect, Layer } from "effect"

export interface MemoryShape {
  /** The user's rules for a space (global, then the space's, inherited down the tree), whole, in its system prompt. */
  readonly core: (space: SpaceId) => Effect.Effect<string>
  /** What applies to this message, before it. */
  readonly recall: (space: SpaceId, text: string) => Effect.Effect<string>
}

export class Memory extends Context.Service<Memory, MemoryShape>()("switch/Memory") {
  static readonly none = Layer.succeed(Memory, {
    core: () => Effect.succeed(""),
    recall: () => Effect.succeed(""),
  })
}

/** A thread with a wake waiting for it in the record (`waitingEvent`), written with what woke it. */
export interface Wake {
  readonly thread: ThreadId
}

export interface TriageShape {
  /** Which of these events wake a turn. Called with each batch the brain commits, in order. */
  readonly wakes: (events: readonly StoredEvent[]) => Effect.Effect<readonly Wake[]>
  /** The fast path: wakes decided per event as they're committed, ahead of their batch. */
  readonly urgent?: (events: readonly StoredEvent[]) => Effect.Effect<readonly Wake[]>
  /** The wake rules' bursts whose time has come, read: asked every few seconds. */
  readonly due?: Effect.Effect<readonly Wake[]>
  /** What changed in a space after `seq`, triaged: about 500 characters. The raw events when unset. */
  readonly delta?: (space: SpaceId, seq: number) => Effect.Effect<string>
  /** Where it reads on from after a restart (the last event it read), or null to start at the head. */
  readonly from?: Effect.Effect<number | null>
}

export class Triage extends Context.Service<Triage, TriageShape>()("switch/Triage") {
  /** Nothing wakes anything but a task's end, which wakes its parent as it's written (sessions.ts). */
  static readonly tasksOnly = Layer.succeed(Triage, {
    wakes: () => Effect.succeed([]),
  })
}

/** A task's report, as its turn ends: its last words, which go to the work that started it. */
export interface Report {
  readonly thread: ThreadId
  readonly turn: TurnId
  readonly title: string
  readonly text: string
  /** Why the check is wrong this time: the report's last line, `bypass: why` (brain's bypass.ts). */
  readonly bypass?: string
}

export interface ReportsShape {
  /** Why the report goes back to its task before it reaches the user, or null to let it through. */
  readonly read: (report: Report) => Effect.Effect<string | null>
}

export class Reports extends Context.Service<Reports, ReportsShape>()("switch/Reports") {
  /** Every report goes through. */
  static readonly none = Layer.succeed(Reports, { read: () => Effect.succeed(null) })
}
