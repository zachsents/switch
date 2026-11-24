// The event types the migration adds. Switchboard's records that are neither talk nor turns keep
// their envelope (stream, kind, about, body) in one of three types, by what they are; memories and
// open expectations are staged raw for autonomy to take in.
import { defineEvent, SpaceId } from "@switch/brain"
import { Schema } from "effect"

const recorded = Schema.Struct({
  /** The space it was filed in. */
  space: SpaceId,
  stream: Schema.String,
  kind: Schema.String,
  about: Schema.Array(Schema.String),
  body: Schema.Unknown,
})

/** A machine's state: vitals, presence, hosts, load. */
export const DeviceObserved = defineEvent("device.observed", 1, recorded)

/** What an extension sensed or did: mail, orders, printers, CI, notes. */
export const AppObserved = defineEvent("app.observed", 1, recorded)

/** What the user did in Switchboard's apps: read, looked at, scrolled, rated. */
export const UiObserved = defineEvent("ui.observed", 1, recorded)

/** A Switchboard memory or rule, as it stood, before the memory write path has seen it. */
export const MemoryImported = defineEvent(
  "memory.imported",
  1,
  Schema.Struct({
    space: SpaceId,
    /** fact, lead, preference, procedure or rule. */
    type: Schema.String,
    statement: Schema.String,
    /** Switchboard's whole row: confidence, whose, said, replaced_by, … */
    memory: Schema.Unknown,
  }),
)

/** An expectation, promise or watch still open in Switchboard. */
export const ExpectationImported = defineEvent(
  "expectation.imported",
  1,
  Schema.Struct({
    space: SpaceId,
    statement: Schema.String,
    /** When it's judged, in ms; null for one that waits on `when` alone. */
    due: Schema.NullOr(Schema.Number),
    promise: Schema.Boolean,
    /** Switchboard queries: the rows it's judged by, and what wakes it early. */
    check: Schema.NullOr(Schema.String),
    when: Schema.NullOr(Schema.String),
    record: Schema.Unknown,
  }),
)

/** How far a run got: Switchboard's log through `through` is in. */
export const MigrateSynced = defineEvent(
  "migrate.synced",
  1,
  Schema.Struct({ through: Schema.Number, records: Schema.Number, ms: Schema.Number }),
)

/** A staged memory the write path has taken: kept as `memory`, or dropped. */
export const MigrateDistilled = defineEvent(
  "migrate.distilled",
  1,
  Schema.Struct({
    seq: Schema.Number,
    /** The memory it became or was merged into, or null when dropped. */
    kept: Schema.NullOr(Schema.String),
    /** Memories it merged with. */
    replaces: Schema.Array(Schema.String),
    why: Schema.NullOr(Schema.String),
  }),
)

/** One model call a budgeted loop made, against its ledger: what it cost at list price. */
export const MigrateSpent = defineEvent(
  "migrate.spent",
  1,
  Schema.Struct({
    ledger: Schema.String,
    usd: Schema.Number,
    login: Schema.String,
    failed: Schema.Boolean,
  }),
)

export const migrateEvents = [
  DeviceObserved,
  AppObserved,
  UiObserved,
  MemoryImported,
  ExpectationImported,
  MigrateSynced,
  MigrateDistilled,
  MigrateSpent,
]
