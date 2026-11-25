// A projection's indexes are made on every open, so one added after its tables were made reaches a
// brain without a rebuild, and a rebuild keeps them.
import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Brain } from "@switch/brain"
import type { Projection } from "@switch/brain"

const dir = mkdtempSync(path.join(tmpdir(), "indexes-"))
const file = path.join(dir, "brain.db")
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** As it was made, before its index. */
const bare: Projection = {
  name: "notes",
  version: 1,
  tables: ["notes"],
  create: "CREATE TABLE notes (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
  on: [],
  snapshot: () => null,
}
const notes: Projection = {
  ...bare,
  indexes: "CREATE INDEX IF NOT EXISTS notes_name ON notes (name);",
}

/** The brain opened on `file` with `projection` (rebuilt when `rebuild`), and closed. */
const opened = async (projection: Projection, rebuild = false) => {
  const runtime = ManagedRuntime.make(
    Brain.layer({ path: file, events: [], projections: [projection], commands: [] }),
  )
  await runtime.runPromise(
    Effect.gen(function* open() {
      const brain = yield* Brain
      if (rebuild) {
        yield* brain.rebuild(projection.name)
      }
    }),
  )
  await runtime.dispose()
}

const indexes = () => {
  const db = new Database(file, { readonly: true })
  const names = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL",
    )
    .all()
    .map((r) => r.name)
  db.close()
  return names
}

test("an index added later is made on the next open", async () => {
  await opened(bare)
  expect(indexes()).toEqual([])
  await opened(notes)
  expect(indexes()).toEqual(["notes_name"])
})

test("a rebuild keeps its indexes", async () => {
  await opened(notes, true)
  expect(indexes()).toEqual(["notes_name"])
})
