// What the gateway sees of an app failing: its tools' calls failing again and again, or its link not
// coming up. One record when it starts failing and one when it works again, never one per call; the
// senses watch (autonomy senses.ts) raises each to the agent.
import type { Database } from "bun:sqlite"
import { defineEvent } from "@switch/brain"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { Schema } from "effect"
import { REFUSED } from "switch-ext-kit"

export const PARTS = ["calls", "link"] as const
export type Part = (typeof PARTS)[number]

export const ExtensionFailing = defineEvent(
  "extension.failing",
  1,
  Schema.Struct({
    extension: Schema.String,
    part: Schema.Literals(PARTS),
    /** What's failing, or null once it works again. */
    failing: Schema.NullOr(Schema.String),
  }),
)

export const extensionFailingConfig = {
  events: [ExtensionFailing],
  projections: [],
  commands: [],
}

/** Calls in a row an app's tools fail before it's failing; one that works clears it. */
export const CALLS_FAILING = 3
/**
 * Whether a call's answer counts toward its app failing: an error, but never a check's refusal
 * (`REFUSED`, a gate bouncing a draft, say), which is the tool working and the caller's to fix.
 */
export const fails = (result: CallToolResult) =>
  result.isError === true && result._meta?.[REFUSED] !== true

/** How long an app's link keeps failing to come up before it's failing. */
export const LINK_FAILING_MS = 60_000

export interface Failing {
  readonly extension: string
  readonly part: Part
  readonly failing: string | null
}

/** Each app's and part's latest record. */
export const latestFailing = (db: Database) =>
  db
    .query<Failing & { readonly seq: number }, []>(
      `SELECT json_extract(payload, '$.extension') AS extension, json_extract(payload, '$.part') AS part,
         json_extract(payload, '$.failing') AS failing, max(seq) AS seq
       FROM events WHERE type = 'extension.failing' GROUP BY 1, 2`,
    )
    .all()
