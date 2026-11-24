import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { SpaceId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// The tree. Home is its one root: it holds every top-level space and whatever fits no other, and it
// can't be moved or archived. Spaces are the user's: made by them, or by the agent when their own
// words ask for one. Nothing makes a space on its own. (`ephemeral` marks the items triage once made.)

export const HOME = SpaceId.make("home")

export const SpaceCreated = defineEvent(
  "space.created",
  1,
  Schema.Struct({
    id: SpaceId,
    name: Schema.String,
    parent: SpaceId,
    ephemeral: Schema.Boolean,
    about: Schema.String,
  }),
)

export const SpaceRenamed = defineEvent(
  "space.renamed",
  1,
  Schema.Struct({ id: SpaceId, name: Schema.String }),
)

export const SpaceDescribed = defineEvent(
  "space.described",
  1,
  Schema.Struct({ id: SpaceId, about: Schema.String }),
)

export const SpaceMoved = defineEvent(
  "space.moved",
  1,
  Schema.Struct({ id: SpaceId, parent: SpaceId }),
)

export const SpaceArchived = defineEvent("space.archived", 1, Schema.Struct({ id: SpaceId }))

export const SpaceUnarchived = defineEvent("space.unarchived", 1, Schema.Struct({ id: SpaceId }))

export const SpacePromoted = defineEvent("space.promoted", 1, Schema.Struct({ id: SpaceId }))

/** Its line's colors, for day and night appearance. */
export const SpaceInked = defineEvent(
  "space.inked",
  1,
  Schema.Struct({ id: SpaceId, day: Schema.String, night: Schema.String }),
)

export interface Space {
  readonly id: SpaceId
  readonly name: string
  readonly parent: SpaceId | null
  /** What it's for and its known identifiers. Membership reads it; names alone lost 8 points of recall. */
  readonly about: string
  readonly ephemeral: boolean
  readonly archived: boolean
  /** Its line's colors; null takes the next free one. */
  readonly ink: { readonly day: string; readonly night: string } | null
}

interface Row {
  readonly id: SpaceId
  readonly name: string
  readonly parent: SpaceId | null
  readonly about: string
  readonly ephemeral: number
  readonly archived: number
  readonly day: string | null
  readonly night: string | null
}

const toSpace = ({ day, night, ...r }: Row): Space => ({
  ...r,
  ephemeral: r.ephemeral === 1,
  archived: r.archived === 1,
  ink: day === null || night === null ? null : { day, night },
})

const COLUMNS = "id, name, parent, about, ephemeral, archived, day, night"

export const allSpaces = (db: Database): Space[] =>
  db.query<Row, []>(`SELECT ${COLUMNS} FROM spaces ORDER BY id`).all().map(toSpace)

const setFlag =
  (column: "ephemeral" | "archived", value: number) => (db: Database, id: SpaceId) => {
    db.query(`UPDATE spaces SET ${column} = ? WHERE id = ?`).run(value, id)
  }

/** A space's child spaces, archived ones left out. */
export const children = (db: Database, id: SpaceId): Space[] =>
  db
    .query<Row, [SpaceId]>(
      `SELECT ${COLUMNS} FROM spaces WHERE parent = ? AND archived = 0 ORDER BY name`,
    )
    .all(id)
    .map(toSpace)

const decodeAliases = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

/** The names spaces had before they were renamed, by id: what the user may still call them. */
export const spaceAliases = (db: Database) =>
  new Map(
    db
      .query<{ id: SpaceId; aliases: string }, []>(
        "SELECT id, aliases FROM spaces WHERE aliases != '[]'",
      )
      .all()
      .map((r) => [r.id, decodeAliases(r.aliases)]),
  )

/**
 * The open space (or any, with `archived`) a name gives, however it's given: its id, its name or a name it had, in any case;
 * or its id as Switchboard wrote it (`ws:<id>`, what migrate's `slug` made ids of) or as its chat's
 * thread (`space:<id>`). Null when it gives none.
 */
export const spaceNamed = (
  db: Database,
  given: string,
  options: { readonly archived?: boolean } = {},
): SpaceId | null => {
  const want = given
    .trim()
    .toLowerCase()
    .replace(/^(?:ws|space):/u, "")
  const aliases = spaceAliases(db)
  return (
    allSpaces(db).find(
      (s) =>
        (options.archived === true || !s.archived) &&
        [s.id, s.name, ...(aliases.get(s.id) ?? [])].some((n) => n.toLowerCase() === want),
    )?.id ?? null
  )
}

/**
 * Where work and what it makes live (a task, an item, an expectation, a memory, a Live Activity): the
 * space it names, else the space of the work that asked, else Home. Switchboard's: a task lives "in
 * the workspace it names, else this work's" (sb mcp.rs `task`), and an ask in the work that asked
 * (docs.md Asks).
 */
export const spaceFor = (db: Database, given: string | undefined, asker: string | null) =>
  (given === undefined ? null : spaceNamed(db, given)) ??
  (asker === null ? null : spaceNamed(db, asker)) ??
  HOME

export const spaces: Projection = {
  name: "spaces",
  version: 6,
  tables: ["spaces"],
  create: `
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, about TEXT NOT NULL, ephemeral INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, day TEXT, night TEXT, aliases TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX spaces_parent ON spaces (parent);
    INSERT INTO spaces (id, name, parent, about, ephemeral) VALUES ('${HOME}', 'Home', NULL, '', 0);`,
  on: [
    on(SpaceCreated, (db, p) => {
      db.query(
        "INSERT INTO spaces (id, name, parent, about, ephemeral) VALUES (?, ?, ?, ?, ?)",
      ).run(p.id, p.name, p.parent, p.about, p.ephemeral ? 1 : 0)
    }),
    on(SpaceRenamed, (db, p) => {
      // The old name stays as an alias, once; the new one isn't one.
      db.query(
        `UPDATE spaces SET aliases = (
           SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(aliases) WHERE value != ?2
             UNION SELECT name WHERE name != ?2
           )
         ), name = ?2 WHERE id = ?1`,
      ).run(p.id, p.name)
    }),
    on(SpaceDescribed, (db, p) => {
      db.query("UPDATE spaces SET about = ? WHERE id = ?").run(p.about, p.id)
    }),
    on(SpaceMoved, (db, p) => {
      db.query("UPDATE spaces SET parent = ? WHERE id = ?").run(p.parent, p.id)
    }),
    on(SpaceArchived, (db, p) => {
      setFlag("archived", 1)(db, p.id)
    }),
    on(SpaceUnarchived, (db, p) => {
      setFlag("archived", 0)(db, p.id)
    }),
    on(SpacePromoted, (db, p) => {
      setFlag("ephemeral", 0)(db, p.id)
    }),
    on(SpaceInked, (db, p) => {
      db.query("UPDATE spaces SET day = ?, night = ? WHERE id = ?").run(p.day, p.night, p.id)
    }),
  ],
  snapshot: allSpaces,
  sources: [
    {
      name: "spaces",
      description:
        "id, name, parent, about, ephemeral (an item triage once made), archived, link (its page in the apps).",
      select:
        "SELECT id, name, parent, about, ephemeral, archived, 'switchboard://space/' || id AS link, rowid AS n FROM spaces",
      columns: ["id", "name", "parent", "about", "ephemeral", "archived", "link", "n"],
      order: "n",
      depends: ["space."],
    },
  ],
}

export const findSpace = (db: Database, id: SpaceId | null) => {
  if (id === null) {
    return null
  }
  const row = db.query<Row, [SpaceId]>(`SELECT ${COLUMNS} FROM spaces WHERE id = ?`).get(id)
  return row ? toSpace(row) : null
}

/** The space and every space above it, nearest first. */
const lineage = (db: Database, id: SpaceId | null) => {
  const out: SpaceId[] = []
  for (let s = findSpace(db, id); s !== null && !out.includes(s.id); s = findSpace(db, s.parent)) {
    out.push(s.id)
  }
  return out
}

export const CreateSpace = defineCommand({
  type: "space.create",
  payload: Schema.Struct({
    id: SpaceId,
    name: Schema.String,
    /** Null puts it at the top level, inside Home. */
    parent: Schema.NullOr(SpaceId),
    about: Schema.optionalKey(Schema.String),
  }),
  load: (db, p) => ({ existing: findSpace(db, p.id), parent: findSpace(db, p.parent ?? HOME) }),
  decide: (state, p) => {
    if (state.existing) {
      return { reject: "Space exists" }
    }
    if (!state.parent) {
      return { reject: "No parent space" }
    }
    return {
      events: [
        SpaceCreated.make({
          id: p.id,
          name: p.name,
          parent: p.parent ?? HOME,
          about: p.about ?? "",
          ephemeral: false,
        }),
      ],
    }
  },
})

export const RenameSpace = defineCommand({
  type: "space.rename",
  payload: Schema.Struct({ id: SpaceId, name: Schema.String }),
  load: (db, p) => findSpace(db, p.id),
  decide: (space, p) => {
    if (!space) {
      return { reject: "No such space" }
    }
    const name = p.name.trim()
    if (name === "") {
      return { reject: "No name" }
    }
    return { events: space.name === name ? [] : [SpaceRenamed.make({ id: p.id, name })] }
  },
})

export const DescribeSpace = defineCommand({
  type: "space.describe",
  payload: Schema.Struct({ id: SpaceId, about: Schema.String }),
  load: (db, p) => findSpace(db, p.id),
  decide: (space, p) => {
    if (!space) {
      return { reject: "No such space" }
    }
    return { events: space.about === p.about ? [] : [SpaceDescribed.make(p)] }
  },
})

export const MoveSpace = defineCommand({
  type: "space.move",
  payload: Schema.Struct({ id: SpaceId, parent: Schema.NullOr(SpaceId) }),
  load: (db, p) => ({ space: findSpace(db, p.id), above: lineage(db, p.parent ?? HOME) }),
  decide: (state, p) => {
    if (!state.space) {
      return { reject: "No such space" }
    }
    if (p.id === HOME) {
      return { reject: "Home can't move" }
    }
    if (state.above.length === 0) {
      return { reject: "No parent space" }
    }
    if (state.above.includes(p.id)) {
      return { reject: "Can't move a space into itself" }
    }
    const parent = p.parent ?? HOME
    return { events: state.space.parent === parent ? [] : [SpaceMoved.make({ id: p.id, parent })] }
  },
})

export const ArchiveSpace = defineCommand({
  type: "space.archive",
  payload: Schema.Struct({ id: SpaceId }),
  load: (db, p) => findSpace(db, p.id),
  decide: (space, p) => {
    if (!space) {
      return { reject: "No such space" }
    }
    if (space.id === HOME) {
      return { reject: "Home can't be archived" }
    }
    return { events: space.archived ? [] : [SpaceArchived.make(p)] }
  },
})

export const UnarchiveSpace = defineCommand({
  type: "space.unarchive",
  payload: Schema.Struct({ id: SpaceId }),
  load: (db, p) => findSpace(db, p.id),
  decide: (space, p) => {
    if (!space) {
      return { reject: "No such space" }
    }
    return { events: space.archived ? [SpaceUnarchived.make(p)] : [] }
  },
})

/**
 * A space's project folder on one machine (empty: none there). Its turns run on a machine that has
 * it, in it; spaces inside it inherit it.
 */
export const SpaceFolderSet = defineEvent(
  "space.folder_set",
  1,
  Schema.Struct({ id: SpaceId, machine: Schema.String, path: Schema.String }),
)

export const spaceFolders: Projection = {
  name: "space_folders",
  version: 1,
  tables: ["space_folders"],
  create: `CREATE TABLE space_folders (space TEXT NOT NULL, machine TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (space, machine));`,
  on: [
    on(SpaceFolderSet, (db, p) => {
      if (p.path === "") {
        db.query("DELETE FROM space_folders WHERE space = ? AND machine = ?").run(p.id, p.machine)
      } else {
        db.query(
          "INSERT INTO space_folders (space, machine, path) VALUES (?, ?, ?) ON CONFLICT (space, machine) DO UPDATE SET path = excluded.path",
        ).run(p.id, p.machine, p.path)
      }
    }),
  ],
  snapshot: (db) =>
    db.query("SELECT space, machine, path FROM space_folders ORDER BY space, machine").all(),
}

interface FolderRow {
  readonly machine: string
  readonly path: string
}

/** A space's project folder on each machine that has one: its own, else the nearest above it. */
export const foldersOf = (db: Database, id: SpaceId): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const s of lineage(db, id)) {
    const rows = db
      .query<FolderRow, [SpaceId]>("SELECT machine, path FROM space_folders WHERE space = ?")
      .all(s)
    for (const r of rows) {
      if (!out.has(r.machine)) {
        out.set(r.machine, r.path)
      }
    }
  }
  return out
}

export const SetSpaceFolder = defineCommand({
  type: "space.set_folder",
  payload: Schema.Struct({ id: SpaceId, machine: Schema.String, path: Schema.String }),
  load: (db, p) => ({
    space: findSpace(db, p.id),
    now:
      db
        .query<{ path: string }, [SpaceId, string]>(
          "SELECT path FROM space_folders WHERE space = ? AND machine = ?",
        )
        .get(p.id, p.machine)?.path ?? "",
  }),
  decide: (state, p) => {
    if (!state.space) {
      return { reject: "No such space" }
    }
    return { events: state.now === p.path ? [] : [SpaceFolderSet.make(p)] }
  },
})

export const spacesConfig = {
  events: [
    SpaceCreated,
    SpaceRenamed,
    SpaceDescribed,
    SpaceMoved,
    SpaceArchived,
    SpaceUnarchived,
    SpacePromoted,
    SpaceInked,
    SpaceFolderSet,
  ],
  projections: [spaces, spaceFolders],
  commands: [
    CreateSpace,
    RenameSpace,
    DescribeSpace,
    MoveSpace,
    ArchiveSpace,
    UnarchiveSpace,
    SetSpaceFolder,
  ],
}
