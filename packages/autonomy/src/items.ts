// Action items (asks): what needs the user, the furthest the agent can get without them. Each is
// tied to its space. The gate decides when the agent's open (see `action_item` in app.ts);
// extensions open theirs through the core (`asks/open`). The user answers, does or waves one off;
// the agent closes, dismisses or revises its own. Whoever waits on one (its space's thread, the
// spaces following it, the extension that raised it) hears when it closes: core/asks.ts.
//
// Kinds:
// - task: something to do; Done.
// - question: options and/or a typed answer.
// - approval: Approve runs `send` in the core (with the drafts as the user left them), Decline.
// - Any kind can carry a live view (`portal`): the screen of the Mac an app runs on, about one of its
//   sessions (a browser tab held for a human check or a sign-in only the user can finish). The card
//   shows it, and the user drives it from there; the app's `portal` tool opens each view, which the
//   core relays and never keeps (core/portal.ts).
// - An extension's approval can need the user's passkey (`passkey`): its link opens a page where
//   Face ID or Touch ID signs the extension's challenge, which the extension verifies and closes
//   (core/passkey.ts).
// - sealed: the user types a secret into a sealed field. What they type is sealed on their device
//   to the ask's one-time key (`sealed.key`) and goes straight to the raising extension's `answerTo`
//   tool; the brain records only that it was answered (see core/asks.ts and switch-ext-kit's sealed.ts).
import type { Database } from "bun:sqlite"
import { defineCommand, defineEvent, ItemId, ModelTag, on, SpaceId, ThreadId } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Schema } from "effect"

import type { Edit } from "./draft-words.ts"
import { rebased } from "./draft-words.ts"

export const KINDS = ["task", "question", "approval", "sealed"] as const
export type ItemKind = (typeof KINDS)[number]

const call = Schema.Struct({
  app: Schema.String,
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
})

/**
 * Where a draft also lives, kept as one version with the card (an email draft in the user's
 * mailbox): the extension's tool that reads it (`{text}` back, or `{gone: true}`) and, given `text`
 * too, writes its words.
 */
export const DraftCopy = Schema.Struct({
  app: Schema.String,
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
})

/** Words to send in the user's name, editable on the card. */
export const Draft = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  text: Schema.String,
  copy: Schema.optionalKey(DraftCopy),
})

/**
 * A file on the card. The seam to the blob store: `blob` is its key there, which clients fetch from
 * the core at `/blobs/<blob>`; `url` is a link instead. `option` puts it beside that option.
 */
export const Attachment = Schema.Struct({
  name: Schema.String,
  /** Its media type: image/*, audio/*, video/* draw as such; anything else is a chip. */
  type: Schema.String,
  size: Schema.optionalKey(Schema.Finite),
  blob: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  option: Schema.optionalKey(Schema.Finite),
})
export type Attachment = typeof Attachment.Type

/** The one-time key a sealed answer is sealed to, and what it's for (bound into the seal). */
export const Sealed = Schema.Struct({ key: Schema.String, use: Schema.String })

/** A live view: the app whose `portal` tool opens it, and the session it's about. */
export const Portal = Schema.Struct({ app: Schema.String, session: Schema.String })

/** A command that succeeds once the step left to the user is done, and the Mac it runs on. */
export const ItemCheck = Schema.Struct({
  run: Schema.String,
  machine: Schema.optionalKey(Schema.String),
})

/**
 * A shell command the item asks the user to run, and the folder it runs in (~ is home): the
 * desktop opens it in a terminal on the Mac they're at, typed and waiting for their ↵.
 */
export const ItemCommand = Schema.Struct({
  run: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
})

const itemFields = Schema.Struct({
  id: ItemId,
  space: SpaceId,
  title: Schema.String,
  /** What's prepared and the one thing left to them. */
  body: Schema.String,
  /** The gate decision that let it through. */
  decision: Schema.String,
  /** It can't wait: a deadline close by. Its notification breaks through Focus. */
  urgent: Schema.optionalKey(Schema.Boolean),
  /** A key that helps, called from the user's client: an app's tool (a sign-in, a page opened). */
  action: Schema.optionalKey(Schema.Struct({ label: Schema.String, ...call.fields })),
  kind: Schema.optionalKey(Schema.Literals(KINDS)),
  /** Its owner verifies completion; clients can dismiss it but cannot mark it done or answer it. */
  completion: Schema.optionalKey(Schema.Literals(["owner"])),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  drafts: Schema.optionalKey(Schema.Array(Draft)),
  links: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        url: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
      }),
    ),
  ),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  /** What Approve runs, in the core: `{{draft:name}}` in a string arg is that draft as approved. */
  send: Schema.optionalKey(call),
  /** Closes itself once this holds, as triage reads events. */
  resolveWhen: Schema.optionalKey(Schema.String),
  /**
   * Closes itself once this command succeeds: sh, run on `machine` (the core's own by default)
   * until it exits 0 (core's item-checks.ts), for a step nothing records.
   */
  check: Schema.optionalKey(ItemCheck),
  /** False: no notification. */
  notify: Schema.optionalKey(Schema.Boolean),
  /** The extension that raised it, set by the core. */
  app: Schema.optionalKey(Schema.String),
  /** Its tool told of the answer: `{item, status, answer}`, or a sealed one's `{item, use, enc, ct}`. */
  answerTo: Schema.optionalKey(Schema.String),
  sealed: Schema.optionalKey(Sealed),
  /**
   * Approved only with the user's passkey: its extension's tool, by this name, gives the WebAuthn
   * options and verifies the answer, which the core relays from `/p/passkey/<token>` (core's
   * passkey.ts), the item's link.
   */
  passkey: Schema.optionalKey(Schema.String),
  portal: Schema.optionalKey(Portal),
  command: Schema.optionalKey(ItemCommand),
  /**
   * Out of the user's queue while the agent reworks it: not shown, counted or answerable, until a
   * revise without it, or the end of the work (`thread`) that set it. The user, Nov 22: "if you're
   * revising an ask … take it out of my queue while it's under revision."
   */
  revising: Schema.optionalKey(Schema.Struct({ thread: Schema.optionalKey(ThreadId) })),
  /** The model that wrote it, as it last opened or revised it. */
  model: Schema.optionalKey(ModelTag),
})
export type ItemFields = typeof itemFields.Type

export const ItemOpened = defineEvent("item.opened", 1, itemFields)
/** The open item, as revised: every field, in place of what it held. */
export const ItemRevised = defineEvent("item.revised", 1, itemFields)
/** A closed item open again, as it was. */
export const ItemReopened = defineEvent("item.reopened", 1, itemFields)

export const ItemClosed = defineEvent(
  "item.closed",
  1,
  Schema.Struct({
    id: ItemId,
    status: Schema.Literals(["done", "dismissed", "resolved"]),
    why: Schema.optionalKey(Schema.String),
    /** The agent's work that closed it: everyone else waiting on it hears. */
    thread: Schema.optionalKey(ThreadId),
  }),
)

export const Answer = Schema.Struct({
  id: ItemId,
  /** An approval's Approve (true) or Decline (false). */
  approved: Schema.optionalKey(Schema.Boolean),
  choice: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  /** Each draft by name, as approved. */
  drafts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The drafts the user changed. */
  edited: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A sealed answer reached its extension; nothing of it is here. */
  sealed: Schema.optionalKey(Schema.Boolean),
})
export type Answer = typeof Answer.Type

export const ItemAnswered = defineEvent("item.answered", 1, Answer)

/** The user's own version of drafts on an open card, saved as he edits: not an approval. */
export const ItemEdited = defineEvent(
  "item.edited",
  1,
  Schema.Struct({
    id: ItemId,
    /** Each draft he changed, by name, as he left it. */
    drafts: Schema.Record(Schema.String, Schema.String),
    /** Read from the draft's copy (its email draft), not typed on a card. */
    copy: Schema.optionalKey(Schema.Boolean),
  }),
)

/** What came of running an approved item's `send`. */
export const ItemRan = defineEvent(
  "item.ran",
  1,
  Schema.Struct({ id: ItemId, ok: Schema.Boolean, output: Schema.String }),
)

/**
 * An approved item's send is going out: written before it's called, so a restart before its
 * `item.ran` knows it may have gone, and never sends it twice.
 */
export const ItemSending = defineEvent("item.sending", 1, Schema.Struct({ id: ItemId }))

/**
 * How an item closed goes to the extension that raised it, as `delivery`: recorded before it's
 * called, and the call carries it as its once-id (switch-ext-kit's ONCE), so an answer read again
 * after a restart reaches the extension once.
 */
export const ItemTold = defineEvent(
  "item.told",
  1,
  Schema.Struct({ id: ItemId, delivery: Schema.String }),
)

/** A space's thread waits on an item it didn't open (`follow`), or stops waiting. */
export const ItemFollowed = defineEvent(
  "item.followed",
  1,
  Schema.Struct({ id: ItemId, space: SpaceId, follow: Schema.Boolean }),
)

export type ItemStatus = "open" | "done" | "dismissed" | "resolved" | "answered"

export interface ActionItem extends ItemFields {
  readonly status: ItemStatus
  readonly openedAt: number
  readonly closedAt: number | null
  readonly answer: Answer | null
  readonly ran: { readonly ok: boolean; readonly output: string } | null
  readonly followers: readonly SpaceId[]
  /** His edits of its drafts, by name. */
  readonly edits: Readonly<Record<string, Edit>>
}

interface Row {
  readonly id: ItemId
  readonly status: ItemStatus
  readonly opened_at: number
  readonly closed_at: number | null
  readonly data: string
  readonly answer: string | null
  readonly ran: string | null
  readonly followers: string
  readonly edits: string | null
}

const parseFields: (json: string) => ItemFields = JSON.parse
const parseAnswer: (json: string) => Answer = JSON.parse
const parseRan: (json: string) => { ok: boolean; output: string } = JSON.parse
const parseSpaces: (json: string) => SpaceId[] = JSON.parse
const parseEdits: (json: string) => Record<string, Edit> = JSON.parse
const parseTexts: (json: string) => Record<string, string> = JSON.parse

const toItem = (r: Row): ActionItem => ({
  ...parseFields(r.data),
  status: r.status,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  answer: r.answer === null ? null : parseAnswer(r.answer),
  ran: r.ran === null ? null : parseRan(r.ran),
  followers: parseSpaces(r.followers),
  edits: r.edits === null ? {} : parseEdits(r.edits),
})

/** A draft's words as the card shows them: his version, else the agent's. */
export const shownText = (i: ActionItem, name: string) =>
  i.edits[name]?.text ?? i.drafts?.find((d) => d.name === name)?.text ?? ""

/** His versions that differ from the agent's, by name, as clients show them. */
export const shownEdits = (i: ActionItem) =>
  Object.fromEntries(
    (i.drafts ?? []).flatMap((d) => {
      const text = i.edits[d.name]?.text
      return text === undefined || text === d.text ? [] : [[d.name, text]]
    }),
  )

/** An item's own fields, as its events carry them. */
export const fieldsOf: (i: ActionItem) => ItemFields = Schema.decodeUnknownSync(itemFields)

const put = (db: Database, p: ItemFields, time: number) => {
  db.query(
    `INSERT INTO action_items (id, space, status, decision, opened_at, data) VALUES (?, ?, 'open', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET space = excluded.space, status = 'open', closed_at = NULL,
       answer = NULL, ran = NULL, data = excluded.data`,
  ).run(p.id, p.space, p.decision, time, JSON.stringify(p))
}

export const actionItems: Projection = {
  name: "action_items",
  version: 3,
  tables: ["action_items"],
  create: `
    CREATE TABLE action_items (id TEXT PRIMARY KEY, space TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', decision TEXT NOT NULL, opened_at INTEGER NOT NULL,
      closed_at INTEGER, data TEXT NOT NULL, answer TEXT, ran TEXT, followers TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX action_items_space ON action_items (space, status);
    CREATE INDEX action_items_decision ON action_items (decision);`,
  on: [
    on(ItemOpened, (db, p, e) => {
      db.query(
        "INSERT OR IGNORE INTO action_items (id, space, decision, opened_at, data) VALUES (?, ?, ?, ?, ?)",
      ).run(p.id, p.space, p.decision, e.time, JSON.stringify(p))
    }),
    on(ItemRevised, (db, p) => {
      db.query("UPDATE action_items SET space = ?, data = ? WHERE id = ? AND status = 'open'").run(
        p.space,
        JSON.stringify(p),
        p.id,
      )
    }),
    on(ItemReopened, (db, p, e) => {
      put(db, p, e.time)
    }),
    on(ItemClosed, (db, p, e) => {
      db.query(
        "UPDATE action_items SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'",
      ).run(p.status, e.time, p.id)
    }),
    on(ItemAnswered, (db, p, e) => {
      db.query(
        "UPDATE action_items SET status = 'answered', closed_at = ?, answer = ? WHERE id = ? AND status = 'open'",
      ).run(e.time, JSON.stringify(p), p.id)
    }),
    on(ItemRan, (db, p) => {
      db.query("UPDATE action_items SET ran = ? WHERE id = ?").run(
        JSON.stringify({ ok: p.ok, output: p.output }),
        p.id,
      )
    }),
    on(ItemFollowed, (db, p) => {
      const row = db
        .query<{ followers: string }, [string]>("SELECT followers FROM action_items WHERE id = ?")
        .get(p.id)
      if (!row) {
        return
      }
      const rest = parseSpaces(row.followers).filter((s) => s !== p.space)
      db.query("UPDATE action_items SET followers = ? WHERE id = ?").run(
        JSON.stringify(p.follow ? [...rest, p.space] : rest),
        p.id,
      )
    }),
  ],
  snapshot: (db) => items(db),
  sources: [
    {
      name: "items",
      description:
        "Action items in the user's queue: id, space, title, body, status (open, done, dismissed, resolved, answered), opened_at, closed_at, link (the item in the apps).",
      select:
        "SELECT id, space, json_extract(data, '$.title') AS title, json_extract(data, '$.body') AS body, status, opened_at, closed_at, 'switchboard://item/' || id AS link, rowid AS n FROM action_items",
      columns: ["id", "space", "title", "body", "status", "opened_at", "closed_at", "link", "n"],
      time: "opened_at",
      order: "n",
      depends: ["item."],
    },
  ],
}

const textsOf = (drafts: ItemFields["drafts"]) =>
  JSON.stringify(Object.fromEntries((drafts ?? []).map((d) => [d.name, d.text])))

const editsRow = (db: Database, id: string) =>
  db
    .query<{ drafts: string; edits: string }, [string]>(
      "SELECT drafts, edits FROM item_edits WHERE id = ?",
    )
    .get(id)

/**
 * His edits of each item's drafts, beside the agent's words they were made from. A revision that
 * changes a draft keeps what he wrote that it kept (draft-words.ts `rebased`).
 */
/**
 * A card's draft and its copy elsewhere (draft-copies.ts) agree on these words now: what each
 * side's later edit is told apart from, across restarts.
 */
export const ItemAgreed = defineEvent(
  "item.agreed",
  1,
  Schema.Struct({ id: ItemId, name: Schema.String, text: Schema.String }),
)

export const itemAgreed: Projection = {
  name: "item_agreed",
  version: 1,
  tables: ["item_agreed"],
  create:
    "CREATE TABLE item_agreed (id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (id, name));",
  on: [
    on(ItemAgreed, (db, p) => {
      db.query(
        "INSERT INTO item_agreed (id, name, text) VALUES (?, ?, ?) ON CONFLICT (id, name) DO UPDATE SET text = excluded.text",
      ).run(p.id, p.name, p.text)
    }),
  ],
  snapshot: () => null,
}

/** The words a draft and its copy last agreed on; null before they're known. */
export const agreedOn = (db: Database, id: string, name: string) =>
  db
    .query<{ text: string }, [string, string]>(
      "SELECT text FROM item_agreed WHERE id = ? AND name = ?",
    )
    .get(id, name)?.text ?? null

export const itemEdits: Projection = {
  name: "item_edits",
  version: 1,
  tables: ["item_edits"],
  create: `
    CREATE TABLE item_edits (id TEXT PRIMARY KEY, drafts TEXT NOT NULL, edits TEXT NOT NULL DEFAULT '{}');`,
  on: [
    on(ItemOpened, (db, p) => {
      db.query("INSERT OR IGNORE INTO item_edits (id, drafts) VALUES (?, ?)").run(
        p.id,
        textsOf(p.drafts),
      )
    }),
    on(ItemReopened, (db, p) => {
      db.query(
        "INSERT INTO item_edits (id, drafts) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET drafts = excluded.drafts",
      ).run(p.id, textsOf(p.drafts))
    }),
    on(ItemRevised, (db, p) => {
      const row = editsRow(db, p.id)
      const was = row ? parseTexts(row.drafts) : {}
      const next = parseTexts(textsOf(p.drafts))
      const edits = Object.fromEntries(
        Object.entries(row ? parseEdits(row.edits) : {}).flatMap(([name, e]) => {
          const kept = rebased(e, was[name], next[name])
          return kept ? [[name, kept]] : []
        }),
      )
      db.query(
        "INSERT INTO item_edits (id, drafts, edits) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET drafts = excluded.drafts, edits = excluded.edits",
      ).run(p.id, JSON.stringify(next), JSON.stringify(edits))
    }),
    on(ItemEdited, (db, p) => {
      const row = editsRow(db, p.id)
      if (!row) {
        return
      }
      const base = parseTexts(row.drafts)
      const was = parseEdits(row.edits)
      const given = Object.entries(p.drafts).map(([name, text]): [string, Edit] => [
        name,
        { ...(was[name] ?? { base: base[name] ?? "", wrote: [] }), text },
      ])
      // Back to the agent's words, with nothing of his kept from before: no edit.
      const edits = Object.fromEntries(
        Object.entries({ ...was, ...Object.fromEntries(given) }).filter(
          ([, e]) => e.text !== e.base || e.wrote.length > 0,
        ),
      )
      db.query("UPDATE item_edits SET edits = ? WHERE id = ?").run(JSON.stringify(edits), p.id)
    }),
  ],
  snapshot: () => null,
}

const ALL = "SELECT a.*, e.edits FROM action_items a LEFT JOIN item_edits e ON e.id = a.id"

/** Every item, newest first; only `status` ones in `space` when given. */
export const items = (
  db: Database,
  filter: { readonly space?: SpaceId; readonly status?: ItemStatus } = {},
): ActionItem[] =>
  db
    .query<Row, []>(`${ALL} ORDER BY a.opened_at DESC`)
    .all()
    .map(toItem)
    .filter(
      (i) =>
        (filter.space === undefined || i.space === filter.space) &&
        (filter.status === undefined || i.status === filter.status),
    )

export const getItem = (db: Database, id: string) => {
  const row = db.query<Row, [string]>(`${ALL} WHERE a.id = ?`).get(id)
  return row ? toItem(row) : null
}

const spaceExists = (db: Database, id: string) =>
  db.query("SELECT id FROM spaces WHERE id = ?").get(id) !== null

/** Opens an item the gate passed, or an extension raised. */
export const OpenItem = defineCommand({
  type: "item.open",
  payload: ItemOpened.payload,
  load: (db, p) => ({ space: spaceExists(db, p.space), existing: getItem(db, p.id) }),
  decide: (s, p) => {
    if (!s.space) {
      return { reject: "No such space" }
    }
    return { events: s.existing ? [] : [ItemOpened.make(p)] }
  },
})

/** Every field of an open item, as revised. */
export const ReviseItem = defineCommand({
  type: "item.revise",
  payload: ItemRevised.payload,
  load: (db, p) => ({ space: spaceExists(db, p.space), existing: getItem(db, p.id) }),
  decide: (s, p) => {
    if (!s.space) {
      return { reject: "No such space" }
    }
    if (s.existing?.status !== "open") {
      return { reject: s.existing ? `It's ${s.existing.status}` : "No such item" }
    }
    const revised = { ...p }
    if (s.existing.completion === "owner") {
      revised.completion = "owner"
      if (s.existing.action === undefined) {
        delete revised.action
      } else {
        revised.action = s.existing.action
      }
      if (s.existing.app === undefined) {
        delete revised.app
      } else {
        revised.app = s.existing.app
      }
      if (s.existing.answerTo === undefined) {
        delete revised.answerTo
      } else {
        revised.answerTo = s.existing.answerTo
      }
      // Its passkey link leads to its own ceremony, whoever revises it.
      if (s.existing.passkey === undefined) {
        delete revised.passkey
      } else {
        revised.passkey = s.existing.passkey
        revised.links = s.existing.links ?? []
      }
    }
    return { events: [ItemRevised.make(revised)] }
  },
})

/** Done, or waved off: by the user, or by the agent for its own. Resolved: its condition held. */
export const CloseItem = defineCommand({
  type: "item.close",
  payload: ItemClosed.payload,
  load: (db, p) => getItem(db, p.id),
  decide: (item, p) => {
    if (!item) {
      return { reject: "No such item" }
    }
    if (item.completion === "owner" && p.status !== "dismissed") {
      return { reject: "Its extension verifies completion" }
    }
    return { events: item.status === "open" ? [ItemClosed.make(p)] : [] }
  },
})

/** The user's answer. A sealed item takes only the core's record that its sealed answer arrived. */
export const AnswerItem = defineCommand({
  type: "item.answer",
  payload: Answer,
  load: (db, p) => getItem(db, p.id),
  decide: (item, p) => {
    if (!item) {
      return { reject: "No such item" }
    }
    if (item.status !== "open") {
      return { events: [] }
    }
    if (item.completion === "owner") {
      return { reject: "Its extension verifies completion" }
    }
    if (item.revising) {
      return { reject: "It's being revised" }
    }
    const sealedItem = item.kind === "sealed"
    if (sealedItem !== (p.sealed === true)) {
      return { reject: sealedItem ? "It takes a sealed answer" : "It isn't sealed" }
    }
    if (sealedItem && Object.keys(p).some((k) => k !== "id" && k !== "sealed")) {
      return { reject: "A sealed answer carries nothing" }
    }
    return { events: [ItemAnswered.make(p)] }
  },
})

/** His version of drafts on an open card, as he types it. */
export const EditItem = defineCommand({
  type: "item.edit",
  payload: ItemEdited.payload,
  load: (db, p) => getItem(db, p.id),
  decide: (item, p) => {
    if (item?.status !== "open") {
      return { reject: item ? `It's ${item.status}` : "No such item" }
    }
    const names = new Set((item.drafts ?? []).map((d) => d.name))
    const unknown = Object.keys(p.drafts).filter((n) => !names.has(n))
    if (unknown.length > 0) {
      return { reject: `No draft ${unknown.join(", ")}` }
    }
    const drafts = Object.fromEntries(
      Object.entries(p.drafts).filter(([name, text]) => text !== shownText(item, name)),
    )
    return Object.keys(drafts).length === 0
      ? { events: [] }
      : { events: [ItemEdited.make({ ...p, drafts })] }
  },
})

/** A closed item open again, as it was. */
export const ReopenItem = defineCommand({
  type: "item.reopen",
  payload: Schema.Struct({ id: ItemId }),
  load: (db, p) => getItem(db, p.id),
  decide: (item) => {
    if (!item) {
      return { reject: "No such item" }
    }
    if (item.kind === "sealed") {
      return { reject: "A sealed item is asked again by its extension" }
    }
    if (item.status === "open") {
      return { events: [] }
    }
    // As it was, in their queue: a mark of work that may be gone isn't carried back.
    const fields = { ...fieldsOf(item) }
    delete fields.revising
    return { events: [ItemReopened.make(fields)] }
  },
})

export const FollowItem = defineCommand({
  type: "item.follow",
  payload: ItemFollowed.payload,
  load: (db, p) => ({ item: getItem(db, p.id), space: spaceExists(db, p.space) }),
  decide: (s, p) => {
    if (!s.item || !s.space) {
      return { reject: s.item ? "No such space" : "No such item" }
    }
    return { events: [ItemFollowed.make(p)] }
  },
})

export const itemsConfig = {
  events: [
    ItemOpened,
    ItemRevised,
    ItemReopened,
    ItemClosed,
    ItemAnswered,
    ItemEdited,
    ItemRan,
    ItemSending,
    ItemTold,
    ItemAgreed,
    ItemFollowed,
  ],
  projections: [actionItems, itemEdits, itemAgreed],
  commands: [OpenItem, ReviseItem, CloseItem, AnswerItem, EditItem, ReopenItem, FollowItem],
}
