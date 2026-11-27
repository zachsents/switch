import { Schema } from "effect"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  reason: Schema.String,
}) {
  /** Its reason, so a log of it says what went wrong. */
  override get message() {
    return this.reason
  }
}

export interface Choice {
  readonly value: string
  readonly description?: string
}

/**
 * Pick one of `choices`; or, as a `predicate`, how likely `instructions` is true, as a probability
 * of "yes" (Luna answers it calibrated; Jev, which answers choices only, is asked yes or no:
 * Switchboard's crates/decide/src/lib.rs:5-13).
 */
export interface Question {
  readonly instructions: string
  readonly choices: readonly Choice[]
  readonly predicate?: boolean
}

export interface Answer {
  readonly choice: string
  /** Every choice's probability. */
  readonly probabilities: Readonly<Record<string, number>>
}

/** `stable` goes first and is the same across many calls, so the provider can cache it. */
export interface Input {
  readonly stable: string
  readonly item: string
}

export interface Decision {
  readonly answers: Readonly<Record<string, Answer>>
  readonly ms: number
  /** Dollars, as the gateway reports it. */
  readonly cost: number
}

export interface Completion {
  readonly text: string
  readonly ms: number
  readonly cost: number
}

export interface Embedding {
  readonly vectors: readonly Float32Array[]
  readonly ms: number
  readonly cost: number
}
