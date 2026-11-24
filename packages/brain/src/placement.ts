import type { Database } from "bun:sqlite"
import { Schema } from "effect"
import { manifest } from "switch-ext-kit"

import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"
import { recordOf } from "./records.ts"

// Which extensions are installed, and which machine runs each, the way widgets are placed: by the
// agent, by the user, or, for an extension never placed, on the first machine to report that has
// what it needs. A machine reports what it provides ("macos", "messages", "lan:printers"); an
// extension needs some.

const machine = {
  machine: Schema.String,
  os: Schema.String,
  provides: Schema.Array(Schema.String),
}

export const MachineReported = defineEvent("machine.reported", 1, Schema.Struct(machine))
const placed = { extension: Schema.String, machine: Schema.String }
export const ExtensionPlaced = defineEvent("extension.placed", 1, Schema.Struct(placed))
const installedFields = {
  /** What it was installed from: a git URL or package name. */
  from: Schema.String,
  /** A folder of `from`, a monorepo: that folder at its commit, packed, is the package. */
  path: Schema.optionalKey(Schema.String),
  /** The same, pinned to the version installed. */
  source: Schema.String,
  package: Schema.String,
  version: Schema.String,
  manifest,
}
/** A package installed: where it came from (pinned), its version, and its manifest. */
const installed = Schema.Struct({ extension: Schema.String, ...installedFields })
export const ExtensionInstalled = defineEvent("extension.installed", 1, installed)
export const ExtensionUpdated = defineEvent("extension.updated", 1, installed)
/** Uninstalled: stopped everywhere, its package gone, its placement forgotten. */
export const ExtensionRemoved = defineEvent(
  "extension.removed",
  1,
  Schema.Struct({ extension: Schema.String }),
)

// The same events as the log has them from before extensions were renamed, read into the new
// shape: `spur.*` types with the name under `spur`. Never written.
const legacyInstalled = Schema.Struct({ spur: Schema.String, ...installedFields })
const LegacyPlaced = defineEvent(
  "spur.placed",
  1,
  Schema.Struct({ spur: Schema.String, machine: Schema.String }),
)
const LegacyInstalled = defineEvent("spur.installed", 1, legacyInstalled)
const LegacyUpdated = defineEvent("spur.updated", 1, legacyInstalled)
const LegacyRemoved = defineEvent("spur.removed", 1, Schema.Struct({ spur: Schema.String }))
const fromLegacy = ({ spur, ...rest }: typeof legacyInstalled.Type) => ({
  extension: spur,
  ...rest,
})

export type Installed = typeof installed.Type

export interface Machine {
  readonly machine: string
  readonly os: string
  readonly provides: readonly string[]
}

export interface ExtensionPlacement {
  readonly extension: string
  readonly machine: string
}

interface MachineRow {
  readonly machine: string
  readonly os: string
  readonly provides: string
}

const decodeProvides = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const machineOf = (r: MachineRow): Machine => ({
  machine: r.machine,
  os: r.os,
  provides: decodeProvides(r.provides),
})

const findMachine = (db: Database, name: string) => {
  const row = db
    .query<MachineRow, [string]>("SELECT machine, os, provides FROM machines WHERE machine = ?")
    .get(name)
  return row === null ? null : machineOf(row)
}

const findExtension = (db: Database, extension: string) =>
  db
    .query<{ machine: string | null }, [string]>(
      "SELECT machine FROM extension_placements WHERE extension = ?",
    )
    .get(extension)

export const machines = (db: Database): Machine[] =>
  db
    .query<MachineRow, []>("SELECT machine, os, provides FROM machines ORDER BY machine")
    .all()
    .map(machineOf)

/** Every placed extension. */
export const extensionPlacements = (db: Database): ExtensionPlacement[] =>
  db
    .query<ExtensionPlacement, []>(
      "SELECT extension, machine FROM extension_placements ORDER BY extension",
    )
    .all()

/**
 * The types of an event any installed extension may report by its name (`<extension>.<name>`), as a
 * subquery: what a part of Switch reads of "attention" or "vitals" without knowing which extension
 * says it.
 */
export const extensionsEvent = (name: string) => `SELECT extension || '.${name}' FROM extensions`

/** Extensions placed at all. */
export const knownExtensions = (db: Database): Set<string> =>
  new Set(extensionPlacements(db).map((r) => r.extension))

const readInstalled = recordOf("installed extension", Schema.fromJsonString(installed))

/** Every installed extension that reads, by name. */
export const installedExtensions = (db: Database): Installed[] =>
  db
    .query<{ extension: string; body: string }, []>(
      "SELECT extension, body FROM extensions ORDER BY extension",
    )
    .all()
    .flatMap((r) => {
      const got = readInstalled(r.body, r.extension)
      return got ? [got] : []
    })

const findInstalled = (db: Database, extension: string) =>
  db
    .query<{ body: string }, [string]>("SELECT body FROM extensions WHERE extension = ?")
    .get(extension)

const place = (db: Database, p: ExtensionPlacement) => {
  db.query(
    "INSERT INTO extension_placements (extension, machine) VALUES (?, ?) ON CONFLICT (extension) DO UPDATE SET machine = excluded.machine",
  ).run(p.extension, p.machine)
}

const install = (db: Database, p: Installed) => {
  db.query(
    "INSERT INTO extensions (extension, body) VALUES (?, ?) ON CONFLICT (extension) DO UPDATE SET body = excluded.body",
  ).run(p.extension, JSON.stringify(p))
}

const update = (db: Database, p: Installed) => {
  db.query("UPDATE extensions SET body = ? WHERE extension = ?").run(JSON.stringify(p), p.extension)
}

const remove = (db: Database, extension: string) => {
  db.query("DELETE FROM extensions WHERE extension = ?").run(extension)
  db.query("DELETE FROM extension_placements WHERE extension = ?").run(extension)
}

export const placement: Projection = {
  name: "placement",
  version: 3,
  // `spur_placements` and `spurs` were its tables before extensions were renamed: dropped.
  tables: ["machines", "extension_placements", "extensions", "spur_placements", "spurs"],
  create: `
    CREATE TABLE machines (machine TEXT PRIMARY KEY, os TEXT NOT NULL, provides TEXT NOT NULL);
    CREATE TABLE extension_placements (extension TEXT PRIMARY KEY, machine TEXT NOT NULL);
    CREATE TABLE extensions (extension TEXT PRIMARY KEY, body TEXT NOT NULL);`,
  on: [
    on(MachineReported, (db, p) => {
      db.query(
        "INSERT INTO machines (machine, os, provides) VALUES (?, ?, ?) ON CONFLICT (machine) DO UPDATE SET os = excluded.os, provides = excluded.provides",
      ).run(p.machine, p.os, JSON.stringify(p.provides))
    }),
    on(ExtensionPlaced, place),
    on(ExtensionInstalled, install),
    on(ExtensionUpdated, update),
    on(ExtensionRemoved, (db, p) => {
      remove(db, p.extension)
    }),
    on(LegacyPlaced, (db, p) => {
      place(db, { extension: p.spur, machine: p.machine })
    }),
    on(LegacyInstalled, (db, p) => {
      install(db, fromLegacy(p))
    }),
    on(LegacyUpdated, (db, p) => {
      update(db, fromLegacy(p))
    }),
    on(LegacyRemoved, (db, p) => {
      remove(db, p.spur)
    }),
  ],
  snapshot: (db) => ({
    machines: machines(db),
    extensions: extensionPlacements(db),
    installed: installedExtensions(db),
  }),
}

export const ReportMachine = defineCommand({
  type: "machine.report",
  payload: Schema.Struct(machine),
  load: (db, p) => findMachine(db, p.machine),
  decide: (was, p) =>
    was !== null && was.os === p.os && was.provides.join("\n") === p.provides.join("\n")
      ? { events: [] }
      : { events: [MachineReported.make(p)] },
})

/** What `needs` lacks on a machine that provides `provides`. */
export const lacking = (needs: readonly string[], provides: readonly string[]) =>
  needs.filter((n) => !provides.includes(n))

export const PlaceExtension = defineCommand({
  type: "extension.place",
  payload: Schema.Struct({
    extension: Schema.String,
    machine: Schema.String,
    /** What the extension needs; the machine must provide all of it. */
    needs: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The first fit, for an extension never placed before. */
    suggested: Schema.optionalKey(Schema.Boolean),
  }),
  load: (db, p) => ({ row: findExtension(db, p.extension), machine: findMachine(db, p.machine) }),
  decide: (state, p) => {
    if (p.suggested === true && state.row !== null) {
      return { events: [] }
    }
    if (state.machine === null) {
      return { reject: `No machine ${p.machine}` }
    }
    const missing = lacking(p.needs ?? [], state.machine.provides)
    if (missing.length > 0) {
      return { reject: `${p.machine} lacks ${missing.join(", ")}` }
    }
    if (state.row?.machine === p.machine) {
      return { events: [] }
    }
    return { events: [ExtensionPlaced.make({ extension: p.extension, machine: p.machine })] }
  },
})

export const InstallExtension = defineCommand({
  type: "extension.install",
  payload: installed,
  load: (db, p) => findInstalled(db, p.extension),
  decide: (row, p) =>
    row ? { reject: `${p.extension} is installed` } : { events: [ExtensionInstalled.make(p)] },
})

export const UpdateExtension = defineCommand({
  type: "extension.update",
  payload: installed,
  load: (db, p) => findInstalled(db, p.extension),
  decide: (row, p) => {
    if (!row) {
      return { reject: `No extension ${p.extension}` }
    }
    return row.body === JSON.stringify(p) ? { events: [] } : { events: [ExtensionUpdated.make(p)] }
  },
})

export const RemoveExtension = defineCommand({
  type: "extension.remove",
  payload: Schema.Struct({ extension: Schema.String }),
  load: (db, p) => ({
    installed: findInstalled(db, p.extension),
    placed: findExtension(db, p.extension),
  }),
  decide: (was, p) =>
    was.installed || was.placed
      ? { events: [ExtensionRemoved.make(p)] }
      : { reject: `No extension ${p.extension}` },
})

export const placementConfig = {
  events: [
    MachineReported,
    ExtensionPlaced,
    ExtensionInstalled,
    ExtensionUpdated,
    ExtensionRemoved,
    LegacyPlaced,
    LegacyInstalled,
    LegacyUpdated,
    LegacyRemoved,
  ],
  projections: [placement],
  commands: [ReportMachine, PlaceExtension, InstallExtension, UpdateExtension, RemoveExtension],
}
