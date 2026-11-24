// What a client does to a thread or its chat, as events, without the brain itself: browser-safe.
import { defineEvent, Dictated, ThreadId } from "@switch/brain/commands"
import { Schema } from "effect"

export const ThreadSteered = defineEvent(
  "thread.steered",
  1,
  Schema.Struct({ thread: ThreadId, text: Schema.String, dictated: Schema.optionalKey(Dictated) }),
)

/** The user stopped the thread's running turn. */
export const ThreadStopped = defineEvent("thread.stopped", 1, Schema.Struct({ thread: ThreadId }))

/** The command payloads clients send. */
export const StopPayload = Schema.Struct({ thread: ThreadId })
export const RetryPayload = Schema.Struct({ thread: ThreadId })
export const EditPayload = Schema.Struct({ seq: Schema.Number, text: Schema.String })
