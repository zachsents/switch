// Pages: what the agent publishes at a link of its own, for anyone with the link to read in any
// browser (Switchboard's objects with `link: true`, SPEC §11.5). Each version is a `page.published`
// naming the blob its body is kept in; a new version keeps the page's id, so its link stays.
// `page.retired` takes it down. The link's token is made from the page's id and a key the core
// keeps (keys.ts), so it's in no record.
import type { Database } from "bun:sqlite"
import { BlobHash, defineEvent, on, SpaceId } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Schema } from "effect"

/** A dated plan a page lists, which calendars subscribe to: a day or a time with its offset. */
export const PageEvent = Schema.Struct({
  title: Schema.String,
  start: Schema.String,
  end: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String),
})
export type PageEvent = typeof PageEvent.Type

/** How an HTML page is drawn: in Switch's article shell (sheet, outline, calendar), or as it is. */
export const PageShell = Schema.Literals(["article", "blank"])
export type PageShell = typeof PageShell.Type

/**
 * What a page shows, kept as a blob: a markdown document, an A2UI surface, or HTML: an article's
 * inner HTML, or a blank page's whole document.
 */
export const PageBody = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("document"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("surface"), surface: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ kind: Schema.Literal("html"), html: Schema.String, shell: PageShell }),
])
export type PageBody = typeof PageBody.Type

export const PagePublished = defineEvent(
  "page.published",
  1,
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    kind: Schema.Literals(["document", "surface", "html"]),
    body: BlobHash,
    events: Schema.Array(PageEvent),
    /** The space it's about, and the thread that made it. */
    space: Schema.NullOr(SpaceId),
    thread: Schema.NullOr(Schema.String),
  }),
)

export const PageRetired = defineEvent("page.retired", 1, Schema.Struct({ id: Schema.String }))

export interface PageRow {
  readonly id: string
  readonly title: string
  readonly kind: "document" | "surface" | "html"
  readonly body: BlobHash
  /** JSON. */
  readonly events: string
  readonly space: SpaceId | null
  readonly thread: string | null
  readonly published: number
  readonly updated: number
  readonly retired: number
}

const COLUMNS = "id, title, kind, body, events, space, thread, published, updated, retired"

export const pageOf = (db: Database, id: string) =>
  db.query<PageRow, [string]>(`SELECT ${COLUMNS} FROM pages WHERE id = ?`).get(id)

export const allPages = (db: Database) =>
  db.query<PageRow, []>(`SELECT ${COLUMNS} FROM pages ORDER BY updated DESC`).all()

export const pages: Projection = {
  name: "pages",
  version: 1,
  tables: ["pages"],
  create: `CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
    body TEXT NOT NULL, events TEXT NOT NULL, space TEXT, thread TEXT, published INTEGER NOT NULL,
    updated INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0);`,
  on: [
    on(PagePublished, (db, p, e) => {
      db.query(
        `INSERT INTO pages (id, title, kind, body, events, space, thread, published, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, kind = excluded.kind,
           body = excluded.body, events = excluded.events, space = excluded.space,
           thread = excluded.thread, updated = excluded.updated, retired = 0`,
      ).run(
        p.id,
        p.title,
        p.kind,
        p.body,
        JSON.stringify(p.events),
        p.space,
        p.thread,
        e.time,
        e.time,
      )
    }),
    on(PageRetired, (db, p, e) => {
      db.query("UPDATE pages SET retired = 1, updated = ? WHERE id = ?").run(e.time, p.id)
    }),
  ],
  snapshot: () => null,
  sources: [
    {
      name: "pages",
      description:
        "Published pages: id, title, kind (document, surface, html), space, thread, published, updated, retired (1 when taken down). Their links: brain's pages tool.",
      select: "SELECT id, title, kind, space, thread, published, updated, retired FROM pages",
      columns: ["id", "title", "kind", "space", "thread", "published", "updated", "retired"],
      time: "updated",
      order: "updated",
      depends: ["page."],
    },
  ],
}

export const pagesConfig = {
  events: [PagePublished, PageRetired],
  projections: [pages],
  commands: [],
}
