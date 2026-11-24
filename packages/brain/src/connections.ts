import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// Accounts the user connected for extensions: one per provider account, its scopes merged as
// extensions need more. Tokens are never here: the core keeps them in the Keychain under the
// connection's id.

export const ConnectionAdded = defineEvent(
  "connection.added",
  1,
  Schema.Struct({
    /** `<provider>:<account>`. */
    id: Schema.String,
    provider: Schema.String,
    /** The account as the provider names it, such as its email. */
    account: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
)

export const ConnectionScopesChanged = defineEvent(
  "connection.scopes_changed",
  1,
  Schema.Struct({ id: Schema.String, scopes: Schema.Array(Schema.String) }),
)

/** An extension's accounts from before connections, moved in once; its old Keychain items then go. */
export const ConnectionsMigrated = defineEvent(
  "connection.migrated",
  1,
  Schema.Struct({
    service: Schema.String,
    provider: Schema.String,
    /** Connection ids it brought in. */
    ids: Schema.Array(Schema.String),
  }),
)

export const ConnectionRemoved = defineEvent(
  "connection.removed",
  1,
  Schema.Struct({ id: Schema.String }),
)

export interface Connection {
  readonly id: string
  readonly provider: string
  readonly account: string
  readonly scopes: readonly string[]
}

interface Row {
  readonly id: string
  readonly provider: string
  readonly account: string
  readonly scopes: string
}

const parseScopes: (json: string) => string[] = JSON.parse

/** Every connection, by provider then account; only `provider`'s when given. */
export const allConnections = (db: Database, provider?: string): Connection[] =>
  db
    .query<Row, []>(
      "SELECT id, provider, account, scopes FROM connections ORDER BY provider, account",
    )
    .all()
    .filter((r) => provider === undefined || r.provider === provider)
    .map((r) => ({ ...r, scopes: parseScopes(r.scopes) }))

export const connections: Projection = {
  name: "connections",
  version: 1,
  tables: ["connections"],
  create: `CREATE TABLE connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    account TEXT NOT NULL, scopes TEXT NOT NULL);`,
  on: [
    on(ConnectionAdded, (db, p) => {
      db.query(
        `INSERT INTO connections (id, provider, account, scopes) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET scopes = excluded.scopes`,
      ).run(p.id, p.provider, p.account, JSON.stringify(p.scopes))
    }),
    on(ConnectionScopesChanged, (db, p) => {
      db.query("UPDATE connections SET scopes = ? WHERE id = ?").run(JSON.stringify(p.scopes), p.id)
    }),
    on(ConnectionRemoved, (db, p) => {
      db.query("DELETE FROM connections WHERE id = ?").run(p.id)
    }),
  ],
  snapshot: (db) => allConnections(db),
}

export const connectionsConfig = {
  events: [ConnectionAdded, ConnectionScopesChanged, ConnectionRemoved, ConnectionsMigrated],
  projections: [connections],
  commands: [],
}
