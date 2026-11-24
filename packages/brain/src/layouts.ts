import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { SpaceId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"
import { recordOf } from "./records.ts"

// A space's page as the user laid it out in the desktop's old configurable grid: which widgets (an
// app's, or Switch's own: its chat, Running, Needs you, Spaces), each widget's settings, where each
// sat in the scrolling grid, and the two sidebars beside it (each its width in the grid's columns
// and a stack of widgets). Saved whole when the user left edit mode. The desktop's page is one fixed
// layout now and no client reads or writes these; they're kept so the log still reads.

const unit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const span = Schema.Int.check(Schema.isGreaterThan(0))

/** A widget in a space's grid: `id` is unique in the space, `app/name` says what it draws. */
export const LayoutWidget = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  name: Schema.String,
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

/** Where a widget sits, in grid units. */
export const LayoutCell = Schema.Struct({ i: Schema.String, x: unit, y: unit, w: span, h: span })

/** A widget in a sidebar's stack: `h`, its height in grid rows; none shares the height left. */
export const SideItem = Schema.Struct({ i: Schema.String, h: Schema.optionalKey(span) })

/** A sidebar: its width in the grid's columns, and its stack, top first. */
export const LayoutSide = Schema.Struct({ cols: span, items: Schema.Array(SideItem) })

const layout = {
  space: SpaceId,
  widgets: Schema.Array(LayoutWidget),
  /** The grid's cells, by its name ("grid"). */
  cells: Schema.Record(Schema.String, Schema.Array(LayoutCell)),
  left: Schema.optionalKey(LayoutSide),
  right: Schema.optionalKey(LayoutSide),
}

export const LayoutSaved = defineEvent("layout.saved", 1, Schema.Struct(layout))

export type Layout = typeof LayoutSaved.payload.Type

const read = recordOf(
  "layout",
  Schema.fromJsonString(
    Schema.Struct({
      widgets: layout.widgets,
      cells: layout.cells,
      left: layout.left,
      right: layout.right,
    }),
  ),
)

/** Every space's saved layout that reads. */
export const layouts = (db: Database): Layout[] =>
  db
    .query<{ space: SpaceId; layout: string }, []>("SELECT space, layout FROM layouts")
    .all()
    .flatMap((r) => {
      const got = read(r.layout, r.space)
      return got ? [{ space: r.space, ...got }] : []
    })

export const layoutsProjection: Projection = {
  name: "layouts",
  version: 1,
  tables: ["layouts"],
  create: "CREATE TABLE layouts (space TEXT PRIMARY KEY, layout TEXT NOT NULL);",
  on: [
    on(LayoutSaved, (db, p) => {
      db.query(
        "INSERT INTO layouts (space, layout) VALUES (?, ?) ON CONFLICT (space) DO UPDATE SET layout = excluded.layout",
      ).run(
        p.space,
        JSON.stringify({ widgets: p.widgets, cells: p.cells, left: p.left, right: p.right }),
      )
    }),
  ],
  snapshot: layouts,
}

export const SaveLayout = defineCommand({
  type: "layout.save",
  payload: Schema.Struct(layout),
  load: (db, p) =>
    db.query<{ id: string }, [string]>("SELECT id FROM spaces WHERE id = ?").get(p.space),
  decide: (space, p) => (space ? { events: [LayoutSaved.make(p)] } : { reject: "No such space" }),
})

export const layoutsConfig = {
  events: [LayoutSaved],
  projections: [layoutsProjection],
  commands: [SaveLayout],
}
