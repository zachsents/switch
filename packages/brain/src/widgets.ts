import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { SpaceId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// Where apps' widgets show: which space, in what order. Placed by the user or the agent, never by
// the app: a widget never placed is on no board, only in the picker. A widget may be placed more
// than once (a web page's picture, one per page), each placement its own by its id: `<app>/<name>`
// for its first, `<app>/<name>#<n>` for each other. A placement may carry an input, which its
// widget's tool is called with, and a size in grid units, which its extension's hints are only the
// default for.

const which = { app: Schema.String, name: Schema.String }
/** The placement, of a widget placed more than once; none is its first, `<app>/<name>`. */
const placementId = { id: Schema.optionalKey(Schema.String) }
/** The arguments its widget's tool is called with. */
export const WidgetInput = Schema.Record(Schema.String, Schema.Unknown)
const count = Schema.Int.check(Schema.isGreaterThan(0))
/** Its size in a space's grid: columns and rows of units. */
export const WidgetSize = Schema.Struct({ cols: count, rows: count })
type Units = typeof WidgetSize.Type
const Where = Schema.Struct({
  ...which,
  ...placementId,
  space: SpaceId,
  index: Schema.Finite,
  input: Schema.optionalKey(WidgetInput),
  size: Schema.optionalKey(WidgetSize),
})

export const WidgetPlaced = defineEvent("widget.placed", 1, Where)
export const WidgetMoved = defineEvent("widget.moved", 1, Where)
export const WidgetRemoved = defineEvent(
  "widget.removed",
  1,
  Schema.Struct({ ...which, ...placementId }),
)

/** A widget's first placement's id, the one a placement naming none is. */
export const firstPlacement = (app: string, name: string) => `${app}/${name}`

/** A placement's id: the one it names, else its widget's first. */
export const placementOf = (p: {
  readonly app: string
  readonly name: string
  readonly id?: string
}) => p.id ?? firstPlacement(p.app, p.name)

export interface Placement {
  readonly id: string
  readonly app: string
  readonly name: string
  readonly space: SpaceId
  readonly index: number
  readonly input?: typeof WidgetInput.Type
  readonly size?: typeof WidgetSize.Type
}

interface Row {
  readonly id: string
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
const COLUMNS = "id, app, name, space, position, input, cols, rows"

const find = (db: Database, id: string) =>
  db.query<Row, [string]>(`SELECT ${COLUMNS} FROM widgets WHERE id = ?`).get(id)

/** The size its placement gave it; null for its extension's hint. */
const sizeOf = (row: Row | null) =>
  row && row.cols !== null && row.rows !== null ? { cols: row.cols, rows: row.rows } : null

const sameSize = (a: Units | null, b: Units | null) => a?.cols === b?.cols && a?.rows === b?.rows

/** What a placement's tool is called with: its input, else none; by id, else the widget's first. */
export const placedInput = (db: Database, app: string, name: string, id?: string) => {
  const row = find(db, id ?? firstPlacement(app, name))
  const input = row && row.app === app && row.name === name ? row.input : null
  return input === null ? {} : decodeInput(input)
}

const inSpace = (db: Database, space: SpaceId) =>
  db
    .query<Row, [string]>(`SELECT ${COLUMNS} FROM widgets WHERE space = ? ORDER BY position`)
    .all(space)

/** Every placement, each space's in order. */
export const placements = (db: Database): Placement[] =>
  db
    .query<Row, []>(
      `SELECT ${COLUMNS} FROM widgets WHERE space IS NOT NULL ORDER BY space, position`,
    )
    .all()
    .flatMap((r) =>
      r.space === null
        ? []
        : [
            {
              id: r.id,
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
  const set = db.query("UPDATE widgets SET space = ?, position = ? WHERE id = ?")
  for (const [i, r] of rows.entries()) {
    set.run(space, i, r.id)
  }
}

/** Takes it out of wherever it was, then puts it at `index` in `space`. */
const put = (db: Database, p: typeof Where.Type) => {
  const id = placementOf(p)
  const was = find(db, id)
  const input = p.input === undefined ? null : JSON.stringify(p.input)
  const cols = p.size?.cols ?? null
  const rows = p.size?.rows ?? null
  db.query(
    "INSERT INTO widgets (id, app, name, space, position, input, cols, rows) VALUES (?, ?, ?, NULL, 0, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET space = NULL, input = excluded.input, cols = excluded.cols, rows = excluded.rows",
  ).run(id, p.app, p.name, input, cols, rows)
  if (was && was.space !== null && was.space !== p.space) {
    renumber(db, inSpace(db, was.space), was.space)
  }
  const there = inSpace(db, p.space)
  const at = Math.max(0, Math.min(Math.trunc(p.index), there.length))
  const me: Row = { id, app: p.app, name: p.name, space: p.space, position: at, input, cols, rows }
  renumber(db, [...there.slice(0, at), me, ...there.slice(at)], p.space)
}

export const widgets: Projection = {
  name: "widgets",
  version: 6,
  tables: ["widgets"],
  // A removed placement keeps its row, space null, so an app's suggestion never brings it back.
  create: `
    CREATE TABLE widgets (id TEXT PRIMARY KEY, app TEXT NOT NULL, name TEXT NOT NULL, space TEXT, position INTEGER NOT NULL, input TEXT, cols INTEGER, rows INTEGER);
    CREATE INDEX widgets_space ON widgets (space, position);
    CREATE INDEX widgets_widget ON widgets (app, name);`,
  on: [
    on(WidgetPlaced, put),
    on(WidgetMoved, put),
    on(WidgetRemoved, (db, p) => {
      const id = placementOf(p)
      const was = find(db, id)
      db.query("UPDATE widgets SET space = NULL WHERE id = ?").run(id)
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

/** The id a new placement of the widget takes: its first's while that's free, else the next `#<n>`. */
const freshId = (db: Database, app: string, name: string) => {
  const first = firstPlacement(app, name)
  const taken = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM widgets WHERE app = ? AND name = ? AND space IS NOT NULL",
      )
      .all(app, name)
      .map((r) => r.id),
  )
  if (!taken.has(first)) {
    return first
  }
  let n = 2
  while (taken.has(`${first}#${n}`)) {
    n += 1
  }
  return `${first}#${n}`
}

export const PlaceWidget = defineCommand({
  type: "widget.place",
  payload: Schema.Struct({
    ...which,
    space: SpaceId,
    /** Which placement to move or change, by id; none is the widget's first. */
    id: Schema.optionalKey(Schema.String),
    /** A placement of its own beside those it has (another page's picture), its id a new one. */
    another: Schema.optionalKey(Schema.Boolean),
    /** Its place among the space's widgets; past the end, or none, puts it last. */
    index: Schema.optionalKey(Schema.Finite),
    /** What its tool is called with; none keeps what it had. */
    input: Schema.optionalKey(WidgetInput),
    /** Its size in grid units; none keeps what it had. */
    size: Schema.optionalKey(WidgetSize),
  }),
  load: (db, p) => {
    const id = p.another === true ? freshId(db, p.app, p.name) : placementOf(p)
    return {
      id,
      row: find(db, id),
      count: inSpace(db, p.space).filter((r) => r.id !== id).length,
      space: db
        .query<{ archived: number }, [string]>("SELECT archived FROM spaces WHERE id = ?")
        .get(p.space),
    }
  },
  decide: (state, p) => {
    if (state.space === null || state.space.archived === 1) {
      return { reject: "No such space" }
    }
    const first = firstPlacement(p.app, p.name)
    if (state.id !== first && !state.id.startsWith(`${first}#`)) {
      return { reject: `A placement of ${first} is ${first} or ${first}#<n>` }
    }
    const index = Math.max(0, Math.min(Math.trunc(p.index ?? state.count), state.count))
    // A new placement starts with nothing: a removed one's input and size stay with it.
    const fresh = p.another === true || !state.row || state.row.space === null
    const k = kept(p.another === true ? null : state.row, p)
    const placement = {
      app: p.app,
      name: p.name,
      ...(state.id !== first && { id: state.id }),
      space: p.space,
      index,
      ...k.fields,
    }
    if (fresh) {
      return { events: [WidgetPlaced.make(placement)] }
    }
    if (
      state.row?.space === p.space &&
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
  payload: Schema.Struct({ ...which, ...placementId }),
  load: (db, p) => find(db, placementOf(p)),
  decide: (row, p) =>
    !row || row.space === null || row.app !== p.app || row.name !== p.name
      ? { reject: "Not placed" }
      : { events: [WidgetRemoved.make(p)] },
})

export const widgetsConfig = {
  events: [WidgetPlaced, WidgetMoved, WidgetRemoved],
  projections: [widgets],
  commands: [PlaceWidget, RemoveWidget],
}
