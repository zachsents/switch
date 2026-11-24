import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// The user's preferences that follow them across clients: the theme, where notifications go. Each is
// a key and a JSON value, set whole. What belongs to one machine (launching at login) stays there.

const pref = { key: Schema.String, value: Schema.Unknown }

export const PrefSet = defineEvent("pref.set", 1, Schema.Struct(pref))

/** Every preference, by key. */
export const prefs = (db: Database): Record<string, unknown> =>
  Object.fromEntries(
    db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM prefs")
      .all()
      .map((r) => [r.key, JSON.parse(r.value) as unknown]),
  )

export const prefsProjection: Projection = {
  name: "prefs",
  version: 1,
  tables: ["prefs"],
  create: "CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  on: [
    on(PrefSet, (db, p) => {
      db.query(
        "INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(p.key, JSON.stringify(p.value))
    }),
  ],
  snapshot: prefs,
}

export const SetPref = defineCommand({
  type: "pref.set",
  payload: Schema.Struct(pref),
  load: () => null,
  decide: (_none, p) => ({ events: [PrefSet.make(p)] }),
})

export const prefsConfig = {
  events: [PrefSet],
  projections: [prefsProjection],
  commands: [SetPref],
}
