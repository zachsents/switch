// What a client sends to forget or edit a memory, without the brain itself: browser-safe.
import { Schema } from "effect"

export const FORGET = "memory.forget"
export const EDIT = "memory.edit"

/** `restore`: what it replaced, put back (a "Remembered" line's Undo). */
export const ForgetPayload = Schema.Struct({
  id: Schema.String,
  restore: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const EditPayload = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  body: Schema.String,
})
