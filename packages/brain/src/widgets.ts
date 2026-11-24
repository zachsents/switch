import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { SpaceId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// Where apps' widgets show: which space, in what order. Placed by the user or the agent, never by
// the app: a widget never placed is on no board, only in the picker. A placement may carry an
// input, which its widget's tool is called with, and a size in grid units, which its extension's
// hints are only the default for.

const which = { app: Schema.String, name: Schema.String }
/** The arguments its widget's tool is called with. */
export const WidgetInput = Schema.Record(Schema.String, Schema.Unknown)
const count = Schema.Int.check(Schema.isGreaterThan(0))
/** Its size in a space's grid: columns and rows of units. */
export const WidgetSize = Schema.Struct({ cols: count, rows: count })
type Units = typeof WidgetSize.Type
const where = {
  ...which,
  space: SpaceId,
  index: Schema.Finite,
  input: Schema.optionalKey(WidgetInput),
  size: Schema.optionalKey(WidgetSize),
}

export const WidgetPlaced = defineEvent("widget.placed", 1, Schema.Struct(where))
export const WidgetMoved = defineEvent("widget.moved", 1, Schema.Struct(where))
export const WidgetRemoved = defineEvent("widget.removed", 1, Schema.Struct(which))

export interface Placement {
  readonly app: string
  readonly name: string
  readonly space: SpaceId
  readonly index: number
  readonly input?: typeof WidgetInput.Type
  readonly size?: typeof WidgetSize.Type
}

interface Row {
  readonly app: string
  readonly name: string
  readonly space: SpaceId | null
  readonly position: number
  /** JSON; null for none. */
  readonly input: string | null
  /** Null for its extension's hint. */
  readonly cols: number | null
  readonly rows: number | null
}

const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(WidgetInput))

const find = (db: Database, app: string, name: string) =>
  db
    .query<Row, [string, string]>(
      "SELECT app, name, space, position, input, cols, rows FROM widgets WHERE app = ? AND name = ?",
    )
    .get(app, name)

/** The size its placement gave it; null for its extension's hint. */
const sizeOf = (row: Row | null) =>
  row && row.cols !== null && row.rows !== null ? { cols: row.cols, rows: row.rows } : null

const sameSize = (a: Units | null, b: Units | null) => a?.cols === b?.cols && a?.rows === b?.rows

/** What a placed widget's tool is called with: its placement's input, else none. */
export const placedInput = (db: Database, app: string, name: string) => {
  const input = find(db, app, name)?.input
  return input === null || input === undefined ? {} : decodeInput(input)
}

const inSpace = (db: Database, space: SpaceId) =>
  db
    .query<Row, [string]>(
      "SELECT app, name, space, position, input, cols, rows FROM widgets WHERE space = ? ORDER BY position",
    )
    .all(space)

/** Every placed widget, each space's in order. */
export const placements = (db: Database): Placement[] =>
  db
    .query<Row, []>(
      "SELECT app, name, space, position, input, cols, rows FROM widgets WHERE space IS NOT NULL ORDER BY space, position",
    )
    .all()
    .flatMap((r) =>
      r.space === null
        ? []
        : [
            {
              app: r.app,
              name: r.name,
              space: r.space,
              index: r.position,
              ...(r.input !== null && { input: decodeInput(r.input) }),
              ...(r.cols !== null && r.rows !== null && { size: { cols: r.cols, rows: r.rows } }),
            },
          ],
    )

const renumber = (db: Database, rows: readonly Row[], space: SpaceId | null) => {
  const set = db.query("UPDATE widgets SET space = ?, position = ? WHERE app = ? AND name = ?")
  for (const [i, r] of rows.entries()) {
    set.run(space, i, r.app, r.name)
  }
}

/** Takes it out of wherever it was, then puts it at `index` in `space`. */
const put = (db: Database, p: Placement) => {
  const was = find(db, p.app, p.name)
  const input = p.input === undefined ? null : JSON.stringify(p.input)
  const cols = p.size?.cols ?? null
  const rows = p.size?.rows ?? null
  db.query(
    "INSERT INTO widgets (app, name, space, position, input, cols, rows) VALUES (?, ?, NULL, 0, ?, ?, ?) ON CONFLICT (app, name) DO UPDATE SET space = NULL, input = excluded.input, cols = excluded.cols, rows = excluded.rows",
  ).run(p.app, p.name, input, cols, rows)
  if (was && was.space !== null && was.space !== p.space) {
    renumber(db, inSpace(db, was.space), was.space)
  }
  const there = inSpace(db, p.space)
  const at = Math.max(0, Math.min(Math.trunc(p.index), there.length))
  const me: Row = { app: p.app, name: p.name, space: p.space, position: at, input, cols, rows }
  renumber(db, [...there.slice(0, at), me, ...there.slice(at)], p.space)
}

export const widgets: Projection = {
  name: "widgets",
  version: 5,
  tables: ["widgets"],
  // A removed widget keeps its row, space null, so an app's suggestion never brings it back.
  create: `
    CREATE TABLE widgets (app TEXT NOT NULL, name TEXT NOT NULL, space TEXT, position INTEGER NOT NULL, input TEXT, cols INTEGER, rows INTEGER, PRIMARY KEY (app, name));
    CREATE INDEX widgets_space ON widgets (space, position);`,
  on: [
    on(WidgetPlaced, put),
    on(WidgetMoved, put),
    on(WidgetRemoved, (db, p) => {
      const was = find(db, p.app, p.name)
      db.query("UPDATE widgets SET space = NULL WHERE app = ? AND name = ?").run(p.app, p.name)
      if (was && was.space !== null) {
        renumber(db, inSpace(db, was.space), was.space)
      }
    }),
  ],
  snapshot: placements,
}

/** Its input (JSON) and size: what a command gives, else what it had. */
const kept = (
  row: Row | null,
  p: { readonly input?: typeof WidgetInput.Type; readonly size?: Units },
) => {
  const input = p.input === undefined ? (row?.input ?? null) : JSON.stringify(p.input)
  const size = p.size ?? sizeOf(row)
  return {
    input,
    size,
    fields: {
      ...(input !== null && { input: decodeInput(input) }),
      ...(size !== null && { size }),
    },
  }
}

export const PlaceWidget = defineCommand({
  type: "widget.place",
  payload: Schema.Struct({
    ...which,
    space: SpaceId,
    /** Its place among the space's widgets; past the end, or none, puts it last. */
    index: Schema.optionalKey(Schema.Finite),
    /** What its tool is called with; none keeps what it had. */
    input: Schema.optionalKey(WidgetInput),
    /** Its size in grid units; none keeps what it had. */
    size: Schema.optionalKey(WidgetSize),
  }),
  load: (db, p) => ({
    row: find(db, p.app, p.name),
    count: inSpace(db, p.space).filter((r) => r.app !== p.app || r.name !== p.name).length,
    space: db
      .query<{ archived: number }, [string]>("SELECT archived FROM spaces WHERE id = ?")
      .get(p.space),
  }),
  decide: (state, p) => {
    if (state.space === null || state.space.archived === 1) {
      return { reject: "No such space" }
    }
    const index = Math.max(0, Math.min(Math.trunc(p.index ?? state.count), state.count))
    const k = kept(state.row, p)
    const placement = { app: p.app, name: p.name, space: p.space, index, ...k.fields }
    if (!state.row || state.row.space === null) {
      return { events: [WidgetPlaced.make(placement)] }
    }
    if (
      state.row.space === p.space &&
      state.row.position === index &&
      state.row.input === k.input &&
      sameSize(sizeOf(state.row), k.size)
    ) {
      return { events: [] }
    }
    return { events: [WidgetMoved.make(placement)] }
  },
})

export const RemoveWidget = defineCommand({
  type: "widget.remove",
  payload: Schema.Struct(which),
  load: (db, p) => find(db, p.app, p.name),
  decide: (row, p) =>
    !row || row.space === null ? { reject: "Not placed" } : { events: [WidgetRemoved.make(p)] },
})

export const widgetsConfig = {
  events: [WidgetPlaced, WidgetMoved, WidgetRemoved],
  projections: [widgets],
  commands: [PlaceWidget, RemoveWidget],
}
