// An extension's runs as they come and go on each machine: up when its host reports it running,
// down when it stops or its host's link ends. Health and surprises read them; clients don't.
import { defineEvent } from "@switch/brain"
import { Schema } from "effect"

const run = Schema.Struct({
  extension: Schema.String,
  machine: Schema.String,
  run: Schema.Number,
  /** Why it went down, as its host says. */
  reason: Schema.optionalKey(Schema.String),
})

export const ExtensionUp = defineEvent("extension.up", 1, run)
export const ExtensionDown = defineEvent("extension.down", 1, run)

export const extensionRunsConfig = {
  events: [ExtensionUp, ExtensionDown],
  projections: [],
  commands: [],
}
