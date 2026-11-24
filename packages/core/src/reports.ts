// Crash and hang reports from the apps, into the brain with what was on screen, as old Switchboard's
// iPhone sent MetricKit's with its trail. A client emits one over its socket.
import { defineEvent } from "@switch/brain"
import { Schema } from "effect"

export const ClientCrashed = defineEvent(
  "client.crashed",
  1,
  Schema.Struct({
    client: Schema.Literals(["iphone", "desktop"]),
    /** The install or machine. */
    device: Schema.String,
    kind: Schema.Literals(["crash", "hang", "error"]),
    build: Schema.String,
    /** When it happened, in ms. */
    at: Schema.Number,
    summary: Schema.String,
    /** What was on screen: the page and its space. */
    screen: Schema.String,
    /** The last steps before it, oldest first. */
    trail: Schema.Array(Schema.String),
    /** The raw report, clipped. */
    report: Schema.optionalKey(Schema.String),
  }),
)

export const reportsConfig = { events: [ClientCrashed], projections: [], commands: [] }
