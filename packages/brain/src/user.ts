import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// Who the user is: their name and a few lasting facts, set by the agent or in a client. Code and
// prompts say "the user"; this is where the name comes from.

const fields = {
  name: Schema.String,
  /** A line or two: where they live, what they do, who's close. */
  about: Schema.String,
}

export const UserDescribed = defineEvent("user.described", 1, Schema.Struct(fields))

export interface User {
  readonly name: string
  readonly about: string
}

export const userOf = (db: Database): User | null =>
  db.query<User, []>("SELECT name, about FROM user_profile WHERE id = 1").get()

/** The user's name, or "the user" until it's known. */
export const userName = (db: Database) => {
  const name = userOf(db)?.name.trim() ?? ""
  return name === "" ? "the user" : name
}

export const user: Projection = {
  name: "user",
  version: 1,
  tables: ["user_profile"],
  create:
    "CREATE TABLE user_profile (id INTEGER PRIMARY KEY, name TEXT NOT NULL, about TEXT NOT NULL);",
  on: [
    on(UserDescribed, (db, p) => {
      db.query(
        "INSERT INTO user_profile (id, name, about) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, about = excluded.about",
      ).run(p.name, p.about)
    }),
  ],
  snapshot: (db) => userOf(db),
}

export const DescribeUser = defineCommand({
  type: "user.describe",
  payload: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    about: Schema.optionalKey(Schema.String),
  }),
  load: userOf,
  decide: (was, p) => {
    const next = { name: p.name ?? was?.name ?? "", about: p.about ?? was?.about ?? "" }
    return was !== null && was.name === next.name && was.about === next.about
      ? { events: [] }
      : { events: [UserDescribed.make(next)] }
  },
})

export const userConfig = {
  events: [UserDescribed],
  projections: [user],
  commands: [DescribeUser],
}
