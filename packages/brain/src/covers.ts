// A space's cover: one picture shown behind its name, a blob served at /blobs/<hash>. The agent sets
// it from an image it has, or clears it (autonomy's `cover` tool). Older covers were drawn and
// recorded as `space.covered`, still read here: their picture as shown by day (`glass` on some, else
// `light`) is the cover.
import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { BlobHash } from "./attachment.ts"
import { defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"
import { SpaceId } from "./ids.ts"

/** An older cover, as it was drawn. Read only. */
export const SpaceCovered = defineEvent(
  "space.covered",
  1,
  Schema.Struct({
    id: SpaceId,
    print: BlobHash,
    light: BlobHash,
    dark: BlobHash,
    glass: Schema.optionalKey(BlobHash),
    ink: Schema.String,
    name: Schema.String,
    lettered: Schema.Boolean,
    photo: Schema.NullOr(BlobHash),
    subject: Schema.String,
    cost: Schema.Number,
  }),
)

/** A space's cover set to an image, or cleared (null). */
export const SpaceCoverSet = defineEvent(
  "space.cover_set",
  1,
  Schema.Struct({ id: SpaceId, image: Schema.NullOr(BlobHash) }),
)

/** A space's cover: the image's blob, at /blobs/<hash>. */
export interface CoverRow {
  readonly space: SpaceId
  readonly image: BlobHash
}

export const allCovers = (db: Database): CoverRow[] =>
  db.query<CoverRow, []>("SELECT space, image FROM space_covers").all()

const set = (db: Database, space: SpaceId, image: BlobHash | null, time: number) => {
  if (image === null) {
    db.query("DELETE FROM space_covers WHERE space = ?").run(space)
    return
  }
  db.query(
    `INSERT INTO space_covers (space, image, time) VALUES (?, ?, ?)
     ON CONFLICT (space) DO UPDATE SET image = excluded.image, time = excluded.time`,
  ).run(space, image, time)
}

export const covers: Projection = {
  name: "space_covers",
  version: 3,
  tables: ["space_covers"],
  create: `CREATE TABLE space_covers (space TEXT PRIMARY KEY, image TEXT NOT NULL, time INTEGER NOT NULL);`,
  on: [
    on(SpaceCovered, (db, p, e) => {
      set(db, p.id, p.glass ?? p.light, e.time)
    }),
    on(SpaceCoverSet, (db, p, e) => {
      set(db, p.id, p.image, e.time)
    }),
  ],
  snapshot: () => null,
  sources: [
    {
      name: "covers",
      description: "space, image (a blob at /blobs/<hash>), time.",
      select: "SELECT space, image, time FROM space_covers",
      columns: ["space", "image", "time"],
      order: "time",
      depends: ["space.covered", "space.cover_set"],
    },
  ],
}

export const coversConfig = {
  events: [SpaceCovered, SpaceCoverSet],
  projections: [covers],
  commands: [],
}
