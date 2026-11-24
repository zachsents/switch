// Dictation between the view and the bun process, which runs the helper (src/native) and says what
// it hears. Each dictation has the view's id, so what an earlier one says late is told apart.

/** What the view asks: a dictation started, finished, dropped; or the microphone's settings. */
export type Dictate =
  | { readonly do: "start"; readonly id: number }
  | { readonly do: "stop" | "cancel" | "settings" }

/** Why a dictation stopped short. */
export type Stopped = "denied" | "no-input" | "missing" | "failed"

/** What the dictation under way says, in order. */
export type Heard = { readonly id: number } & (
  | { readonly kind: "ready" }
  /** How loud the microphone is, 0 to 1. */
  | { readonly kind: "level"; readonly level: number }
  /** All the words so far, the phrase under way included. */
  | { readonly kind: "words"; readonly text: string }
  /** It's over: all its words, and why it stopped short, if it did. */
  | {
      readonly kind: "end"
      readonly text: string
      readonly stopped?: Stopped
      readonly message?: string
    }
)
