// Crash and hang reports from the apps, into the brain with what was on screen, as old Switchboard's
// iPhone sent MetricKit's with its trail. A client emits one over its socket. And which build each
// desktop runs, said once a launch (the iPhone says its own in `iphone.reported`).
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
    /** The app image's UUID, which names the build's dSYM (the iPhone's reports). */
    binary: Schema.optionalKey(Schema.String),
    /** The crashing or hung thread's stack, innermost first, as image and offset into its text. */
    frames: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          binaryName: Schema.String,
          binaryUUID: Schema.String,
          offset: Schema.Number,
        }),
      ),
    ),
  }),
)

export const ClientReported = defineEvent(
  "client.reported",
  1,
  Schema.Struct({
    client: Schema.Literal("desktop"),
    /** The machine. */
    device: Schema.String,
    build: Schema.String,
    /** The commit it was built from. */
    hash: Schema.String,
  }),
)

export const reportsConfig = {
  events: [ClientCrashed, ClientReported],
  projections: [],
  commands: [],
}
