// What the brain holds for a dial (settings.ts), read without the dials' definitions: the gate and
// the memory commands read here, and settings.ts reads them.
import type { Database } from "bun:sqlite"

const parse: (json: string) => unknown = JSON.parse

/** A dial's value as last set; null at its default. */
export const storedDial = (db: Database, key: string): number | string | null => {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key)
  const v = row ? parse(row.value) : null
  return typeof v === "number" || typeof v === "string" ? v : null
}

/** Whether `id` is a dial's change that Undo can still take back. */
export const changeOpen = (db: Database, id: string) =>
  db.query("SELECT 1 FROM setting_changes WHERE id = ? AND undone = 0").get(id) !== null
