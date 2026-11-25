// The iPhone as an extension. Its app reports itself (`iphone.reported`: where APNs reaches it and
// each Live Activity's push token), and these tools reach it from anywhere: Live Activities from
// three general templates, Wallet passes, and notifications. They run in the core, which holds the
// push key and the pass certificate; each is an event too, so the app applies it at once while it's
// open.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Database } from "bun:sqlite"
import { BlobHash, Brain, defineRead, EventId, react, spaceFor, SpaceId } from "@switch/brain"
import type { BlobsShape } from "@switch/brain"
import { Effect, Schedule, Schema } from "effect"

import { AppEvents, Caller, defineApp, defineEvent, tool } from "switch-ext-kit"
import type { AppEventsService } from "switch-ext-kit"
import { makeApns } from "./apns.ts"
import type { Apns, Push, Target } from "./apns.ts"
import { pushKeyFile, walletFiles } from "./keys.ts"
import { certificate, checkBytes, checkLink, makeBundle, MIME, MIME_MANY } from "./check.ts"
import { KINDS, makePass } from "./wallet.ts"

const TEMPLATES = ["progress", "countdown", "status"] as const
const STATES = ["running", "done", "failed", "needs"] as const

export const Reported = defineEvent(
  "iphone.reported",
  1,
  Schema.Struct({
    /** This install's id. */
    device: Schema.String,
    name: Schema.String,
    notifications: Schema.String,
    apns: Schema.optionalKey(
      Schema.Struct({ token: Schema.String, environment: Schema.String, topic: Schema.String }),
    ),
    /** The token that starts a Live Activity from a push. */
    pushToStart: Schema.optionalKey(Schema.String),
    /** Each running Live Activity's push token, by its id. */
    activities: Schema.Record(Schema.String, Schema.String),
    build: Schema.optionalKey(Schema.String),
  }),
)

export const Opened = defineEvent("iphone.opened", 1, Schema.Struct({ device: Schema.String }))

export const Located = defineEvent(
  "iphone.located",
  1,
  Schema.Struct({
    device: Schema.String,
    latitude: Schema.Finite,
    longitude: Schema.Finite,
    accuracy: Schema.Finite,
  }),
)

const activityState = {
  title: Schema.String,
  line: Schema.optionalKey(Schema.String),
  /** 0 to 1. */
  progress: Schema.optionalKey(Schema.Finite),
  /** In ms. */
  startedAt: Schema.Finite,
  endsAt: Schema.optionalKey(Schema.Finite),
  state: Schema.Literals(STATES),
  /**
   * True while the user follows it, so they hear when it ends; kept until changed (Switchboard's
   * activity fact `follow`, its docs.md "activities").
   */
  follow: Schema.optionalKey(Schema.Boolean),
}

export const Activity = defineEvent(
  "iphone.activity",
  1,
  Schema.Struct({
    id: Schema.String,
    phase: Schema.Literals(["start", "update", "end"]),
    template: Schema.Literals(TEMPLATES),
    space: SpaceId,
    ...activityState,
  }),
)
type ActivityPayload = typeof Activity.payload.Type

export const PassIssued = defineEvent(
  "iphone.pass_issued",
  1,
  Schema.Struct({ serial: Schema.String, title: Schema.String, space: SpaceId }),
)

/** A pass or bundle made, kept in the blob store: what /passes/<id> serves, the latest by its id. */
export const PassMade = defineEvent(
  "iphone.pass_made",
  1,
  Schema.Struct({ id: Schema.String, blob: Schema.String, bundle: Schema.Boolean }),
)
const decodeMade = Schema.decodeUnknownOption(Schema.fromJsonString(PassMade.payload))

/** The blob of the latest pass or bundle made by `id`. */
const madeBlob = (db: Database, id: string) => {
  const row = db
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM events WHERE type = 'iphone.pass_made'
         AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(id)
  const made = row === null ? null : decodeMade(row.payload)
  return made?._tag === "Some" ? made.value : null
}

export const Notified = defineEvent(
  "iphone.notified",
  1,
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    body: Schema.String,
    space: SpaceId,
    options: Schema.Array(Schema.String),
  }),
)

type Device = typeof Reported.payload.Type
const parse: (json: string) => unknown = JSON.parse
const decodeDevice = Schema.decodeUnknownOption(Reported.payload)
const decodeActivity = Schema.decodeUnknownOption(Activity.payload)

/** Each install's latest report. */
const devices = (db: Database): Device[] =>
  db
    .query<{ payload: string }, []>(
      `SELECT payload FROM events WHERE seq IN (
         SELECT max(seq) FROM events WHERE type = 'iphone.reported'
         GROUP BY json_extract(payload, '$.device'))`,
    )
    .all()
    .flatMap((r) => {
      const d = decodeDevice(parse(r.payload))
      return d._tag === "Some" ? [d.value] : []
    })

const lastActivity = (db: Database, id: string): ActivityPayload | null => {
  const row = db
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM events WHERE type = 'iphone.activity'
         AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(id)
  if (!row) {
    return null
  }
  const a = decodeActivity(parse(row.payload))
  return a._tag === "Some" ? a.value : null
}

const spaceName = (db: Database, id: SpaceId) =>
  db.query<{ name: string }, [string]>("SELECT name FROM spaces WHERE id = ?").get(id)?.name ??
  "Home"

const spaceInk = (db: Database, id: SpaceId) =>
  db
    .query<{ day: string | null; night: string | null }, [string]>(
      "SELECT day, night FROM spaces WHERE id = ?",
    )
    .get(id) ?? { day: null, night: null }

/** His queue's count: an item the agent is reworking is out of it. */
const openItems = (db: Database) =>
  db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM action_items WHERE status = 'open' AND json_extract(data, '$.revising') IS NULL",
    )
    .get()?.n ?? 0

// The iPhone's reads of the brain, by name (reads.ts), so they run in a reader thread.
const devicesRead = defineRead("gateway/iphone/devices", (db) => devices(db))
/** The phones, and the queue's count for their badge. */
const devicesBadgeRead = defineRead("gateway/iphone/devices-badge", (db) => ({
  ds: devices(db),
  badge: openItems(db),
}))
/** The phones, and the name and ink of the space an activity shows. */
const activityPushRead = defineRead("gateway/iphone/activity-push", (db, space: SpaceId) => ({
  ds: devices(db),
  name: spaceName(db, space),
  ink: spaceInk(db, space),
}))
/** The phones, the queue's count, and the name of the space a note is from. */
const alertRead = defineRead("gateway/iphone/alert", (db, space: SpaceId) => ({
  ds: devices(db),
  badge: openItems(db),
  name: spaceName(db, space),
}))
const lastActivityRead = defineRead("gateway/iphone/last-activity", (db, id: string) =>
  lastActivity(db, id),
)
const madeBlobRead = defineRead("gateway/iphone/made-blob", (db, id: string) => madeBlob(db, id))
const spaceForRead = defineRead(
  "gateway/iphone/space-for",
  (db, given: string | undefined, asker: string | null) => spaceFor(db, given, asker),
)

/** Something to tell the user: a new item, or a reply or a task's report they left unread. */
export interface Note {
  /**
   * An item in their queue, a reply or a finished task's report they left unread, or an app's own
   * alert (its notification, or an activity they follow ending).
   */
  readonly kind: "item" | "reply" | "report" | "alert"
  readonly space: SpaceId
  readonly title: string
  readonly body: string
  readonly item?: string
  readonly seq?: number
  readonly urgent?: boolean
  /** An item's kind and options: its lock-screen keys. */
  readonly itemKind?: string
  readonly options?: readonly string[]
  /** The item carries a live view, which its notification opens. */
  readonly portal?: boolean
}

export interface IphoneOptions {
  /** Switch's folder: its push key and pass certificate. */
  readonly dir: string
  /** Where issued passes and bundles are kept. */
  readonly blobs: BlobsShape
}

/** Milliseconds from an ISO time or a number of ms. */
const msOf = (v: string | number) => {
  const ms = typeof v === "number" ? v : Temporal.Instant.from(v).epochMilliseconds
  if (!Number.isFinite(ms)) {
    throw new TypeError(`Not a time: ${String(v)}`)
  }
  return ms
}

/** Where alerts go: each install's APNs target once, though two reports name the same token. */
const alerts = (ds: readonly Device[]) => [
  ...new Map(
    ds.flatMap((d) => (d.apns === undefined ? [] : [[d.apns.token, d.apns] as const])),
  ).values(),
]

const contentState = (a: ActivityPayload) => ({
  title: a.title,
  ...(a.line !== undefined && { line: a.line }),
  ...(a.progress !== undefined && { progress: a.progress }),
  startedAt: a.startedAt,
  ...(a.endsAt !== undefined && { endsAt: a.endsAt }),
  state: a.state,
})

/** An action item opened or closed, as far as a notification needs it (a close names only its id). */
const decodeItem = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    space: Schema.optionalKey(SpaceId),
    title: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Array(Schema.String)),
    notify: Schema.optionalKey(Schema.Boolean),
  }),
)

/** Where what a tool starts shows: the space given, else the asking work's, else Home (`spaceFor`). */
const placed = (given: string | undefined) =>
  Effect.gen(function* placing() {
    const brain = yield* Brain
    const caller = yield* Caller
    return yield* brain.read(spaceForRead, given, caller.space)
  })

/** The lock screen's keys for an item, by its kind (Shared/Categories.swift); a task's are "item". */
const CATEGORIES: Readonly<Record<string, string>> = {
  approval: "item.approval",
  question: "item.question",
  sealed: "item.sealed",
}
const categoryOf = (kind: string | undefined) => CATEGORIES[kind ?? ""] ?? "item"

const CLOSES = new Set(["item.closed", "item.answered"])

const now = () => Temporal.Now.instant().epochMilliseconds

const when = Schema.Union([Schema.String, Schema.Finite])

export const makeIphone = (options: IphoneOptions) => {
  // Made once there's a key; while there's none (or `push-hold`), looked for again on each push.
  let apns: Apns | undefined
  const push = (): Apns | null => {
    if (apns === undefined) {
      const file = pushKeyFile(options.dir)
      if (file === null) {
        return null
      }
      apns = makeApns(file)
    }
    return apns
  }

  /** Sends to every reachable install; says how many took it. */
  const send = (targets: readonly Target[], p: Push) =>
    Effect.promise(async () => {
      const key = push()
      if (key === null) {
        return { sent: 0, reason: "No push key" }
      }
      if (targets.length === 0) {
        return { sent: 0, reason: "No iPhone registered with this core" }
      }
      const results = await Promise.all(targets.map(async (t) => await key.send(t, p)))
      const ok = results.filter((r) => r.status === 200).length
      const failed = results.find((r) => r.status !== 200)
      return { sent: ok, reason: failed === undefined ? "" : `${failed.status} ${failed.reason}` }
    })

  /** The activity's push: start from the phone's start token, else update or end with its own. */
  const activityPush = (a: ActivityPayload) =>
    Effect.gen(function* pushing() {
      const brain = yield* Brain
      const { ds, name, ink } = yield* brain.read(activityPushRead, a.space)
      const seconds = Math.floor(now() / 1000)
      const targets: { target: Target; payload: Record<string, unknown> }[] = []
      for (const d of ds) {
        if (d.apns === undefined) {
          continue
        }
        const own = d.activities[a.id]
        if (own !== undefined && a.phase !== "start") {
          targets.push({
            target: { ...d.apns, token: own },
            payload: {
              aps: {
                timestamp: seconds,
                event: a.phase === "end" ? "end" : "update",
                "content-state": contentState(a),
                ...(a.phase === "end" && { "dismissal-date": seconds + 15 * 60 }),
              },
            },
          })
        } else if (a.phase === "start" && d.pushToStart !== undefined && own === undefined) {
          targets.push({
            target: { ...d.apns, token: d.pushToStart },
            payload: {
              aps: {
                timestamp: seconds,
                event: "start",
                "content-state": contentState(a),
                "attributes-type": "SwitchActivity",
                attributes: {
                  id: a.id,
                  template: a.template,
                  space: name,
                  spaceId: a.space,
                  ...(ink.day !== null && { ink: ink.day }),
                  ...(ink.night !== null && { night: ink.night }),
                },
                alert: { title: a.title, body: a.line ?? name },
              },
            },
          })
        }
      }
      const results = yield* Effect.all(
        targets.map((t) =>
          send([t.target], { type: "liveactivity", payload: t.payload, priority: 10 }),
        ),
      )
      return results.reduce((n, r) => n + r.sent, 0)
    })

  const activity = (a: ActivityPayload) =>
    Effect.gen(function* acting() {
      const events = yield* AppEvents
      yield* Effect.orDie(events.emit(Activity.make(a)))
      const pushed = yield* activityPush(a)
      return { id: a.id, state: a.state, pushed }
    })

  const startInput = Schema.Struct({
    /** Reuse one to replace it; made from the title when absent. */
    id: Schema.optionalKey(Schema.String),
    template: Schema.Literals(TEMPLATES),
    title: Schema.String,
    line: Schema.optionalKey(Schema.String),
    progress: Schema.optionalKey(Schema.Finite),
    endsAt: Schema.optionalKey(when),
    space: Schema.optionalKey(SpaceId),
    follow: Schema.optionalKey(Schema.Boolean),
  })

  const start = tool(
    "live_activity_start",
    {
      description:
        "Starts a Live Activity on the iPhone's lock screen and Dynamic Island. template: progress (a print, a deploy: give progress 0-1 and/or endsAt), countdown (a timer, leaving for a meeting: endsAt), status (a line that changes). endsAt is ISO 8601 or ms. follow: true while the user follows it, so they hear when it ends.",
      input: startInput,
    },
    (i) =>
      Effect.gen(function* starting() {
        const brain = yield* Brain
        const id =
          i.id ?? `${i.title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}-${now().toString(36)}`
        // Replacing one still running (its app reconnecting) keeps whether they follow it, as an
        // activity's facts stood until changed there (Switchboard's core projectors/entities.rs).
        const was = yield* brain.read(lastActivityRead, id)
        const follow = i.follow ?? (was?.phase === "end" ? undefined : was?.follow)
        return yield* activity({
          id,
          phase: "start",
          template: i.template,
          space: yield* placed(i.space),
          title: i.title,
          ...(i.line !== undefined && { line: i.line }),
          ...(i.progress !== undefined && { progress: i.progress }),
          startedAt: now(),
          ...(i.endsAt !== undefined && { endsAt: msOf(i.endsAt) }),
          state: "running",
          ...(follow !== undefined && { follow }),
        })
      }),
  )

  const changeInput = Schema.Struct({
    id: Schema.String,
    title: Schema.optionalKey(Schema.String),
    line: Schema.optionalKey(Schema.String),
    progress: Schema.optionalKey(Schema.Finite),
    endsAt: Schema.optionalKey(when),
    state: Schema.optionalKey(Schema.Literals(STATES)),
    follow: Schema.optionalKey(Schema.Boolean),
  })

  const change = (phase: "update" | "end") => (i: typeof changeInput.Type) =>
    Effect.gen(function* changing() {
      const brain = yield* Brain
      const was = yield* brain.read(lastActivityRead, i.id)
      if (was === null || was.phase === "end") {
        return yield* Effect.fail(new Error(`No running Live Activity ${i.id}`))
      }
      const endsAt = i.endsAt === undefined ? was.endsAt : msOf(i.endsAt)
      let state = i.state ?? was.state
      if (phase === "end" && i.state === undefined) {
        state = "done"
      }
      return yield* activity({
        ...was,
        phase,
        title: i.title ?? was.title,
        ...((i.line ?? was.line) !== undefined && { line: i.line ?? was.line }),
        ...((i.progress ?? was.progress) !== undefined && { progress: i.progress ?? was.progress }),
        ...(endsAt !== undefined && { endsAt }),
        state,
        ...(i.follow !== undefined && { follow: i.follow }),
      })
    })

  const update = tool(
    "live_activity_update",
    {
      description:
        "Changes a running Live Activity: title, line, progress (0-1), endsAt, state (running, needs, failed), or follow (true while the user follows it, so they hear when it ends).",
      input: changeInput,
    },
    change("update"),
  )

  const end = tool(
    "live_activity_end",
    {
      description:
        "Ends a Live Activity; it stays on the lock screen 15 minutes saying how it ended (state done or failed; done by default).",
      input: changeInput,
    },
    change("end"),
  )

  const field = Schema.Struct({ label: Schema.String, value: Schema.String })

  const signing = Effect.suspend(() => {
    const files = walletFiles(options.dir)
    return files === null
      ? Effect.fail(
          new Error(
            `No pass certificate: put pass.pem, pass.key and wwdr.pem in ${path.join(options.dir, "wallet")}`,
          ),
        )
      : Effect.succeed(files)
  })

  /** An issued pass or bundle by its serial or id, if it's here. */
  const issued = (id: string) =>
    Effect.gen(function* finding() {
      const brain = yield* Brain
      const made = yield* brain.read(madeBlobRead, id)
      const file = made === null ? null : yield* options.blobs.path(BlobHash.make(made.blob))
      return made === null || file === null ? null : { file, type: made.bundle ? MIME_MANY : MIME }
    })

  /** Keeps a pass or bundle in the blob store, recorded by its id before it's served. */
  const keep = (id: string, bytes: Uint8Array, bundle: boolean) =>
    Effect.gen(function* keeping() {
      const stored = yield* options.blobs
        .put(new Blob([bytes]).stream())
        .pipe(Effect.mapError((reason) => new Error(`Can't keep ${id}: ${reason}`)))
      const brain = yield* Brain
      yield* brain.ingest([
        {
          id: EventId.make(`pass:${id}:${stored.hash}`),
          type: PassMade.type,
          source: "core",
          payload: { id, blob: stored.hash, bundle },
        },
      ])
    })

  const pass = tool(
    "wallet_issue_pass",
    {
      description:
        "Makes a signed Apple Wallet pass and puts it in front of the user on their iPhone (send: false only makes it, as for a bundle). kind: generic, eventTicket, boardingPass (transit: air, boat, bus, train), coupon, storeCard. barcode is the ticket's real code, never a made-up one: a decoded code's `wallet` (format qr, aztec, pdf417 or code128; message; encoding) as it is. relevantDate is ISO 8601 with its offset. Served at /passes/<serial> on the core.",
      input: Schema.Struct({
        kind: Schema.Literals(KINDS),
        title: Schema.String,
        organization: Schema.optionalKey(Schema.String),
        serial: Schema.optionalKey(Schema.String),
        transit: Schema.optionalKey(Schema.String),
        primary: Schema.optionalKey(Schema.Array(field)),
        secondary: Schema.optionalKey(Schema.Array(field)),
        auxiliary: Schema.optionalKey(Schema.Array(field)),
        back: Schema.optionalKey(Schema.Array(field)),
        barcode: Schema.optionalKey(
          Schema.Struct({
            message: Schema.String,
            format: Schema.optionalKey(Schema.String),
            encoding: Schema.optionalKey(Schema.String),
            altText: Schema.optionalKey(Schema.String),
          }),
        ),
        relevantDate: Schema.optionalKey(Schema.String),
        locations: Schema.optionalKey(
          Schema.Array(Schema.Struct({ latitude: Schema.Finite, longitude: Schema.Finite })),
        ),
        space: Schema.optionalKey(SpaceId),
        send: Schema.optionalKey(Schema.Boolean),
      }),
    },
    (i) =>
      Effect.gen(function* issuing() {
        const files = yield* signing
        const made = yield* Effect.try(() => makePass(files, i))
        yield* keep(made.serial, made.bytes, false)
        if (i.send === false) {
          return { serial: made.serial, path: `/passes/${made.serial}` }
        }
        const space = yield* placed(i.space)
        const events = yield* AppEvents
        yield* Effect.orDie(
          events.emit(PassIssued.make({ serial: made.serial, title: i.title, space })),
        )
        const brain = yield* Brain
        const ds = yield* brain.read(devicesRead)
        const sent = yield* send(alerts(ds), {
          type: "alert",
          payload: {
            aps: { alert: { title: i.title, body: "Wallet" }, sound: "default", category: "pass" },
            pass: made.serial,
            space,
          },
          collapse: `pass-${made.serial}`,
        })
        return { serial: made.serial, path: `/passes/${made.serial}`, pushed: sent.sent }
      }),
  )

  const bundle = tool(
    "wallet_bundle",
    {
      description:
        "Puts two or more issued passes (a party's tickets, each its own, issued with send: false) in one .pkpasses, which Safari on an iPhone adds with one tap. Each is checked first. Served at /passes/<id> on the core.",
      input: Schema.Struct({ serials: Schema.Array(Schema.String) }),
    },
    (i) =>
      Effect.gen(function* bundling() {
        if (i.serials.length < 2) {
          return yield* Effect.fail(new Error("Give two or more passes"))
        }
        const passes = yield* Effect.all(
          i.serials.map((serial) =>
            Effect.gen(function* reading() {
              const at = yield* issued(serial)
              if (at === null || at.type !== MIME) {
                return yield* Effect.fail(new Error(`No pass ${serial}`))
              }
              return readFileSync(at.file)
            }),
          ),
        )
        const made = yield* Effect.try(() => makeBundle(passes))
        yield* keep(made.id, made.bytes, true)
        return {
          id: made.id,
          path: `/passes/${made.id}`,
          count: passes.length,
          bytes: made.bytes.length,
        }
      }),
  )

  const check = tool(
    "wallet_check",
    {
      description:
        "Checks a .pkpass or .pkpasses as iOS does: each file's hash in the manifest, the signature through Apple's WWDR G4 to Apple's root, the signer its own Pass Type ID; and says what would trouble Wallet (voided, expired, its date passed). pass is an issued serial or bundle id, an https URL or a path on the core's machine; barcodes show only their kind and length. Also the signing certificate and how long it has. A published page's Add to Wallet link: wallet_check_link.",
      readOnly: true,
      input: Schema.Struct({ pass: Schema.optionalKey(Schema.String) }),
    },
    (i) =>
      Effect.gen(function* checking() {
        const files = walletFiles(options.dir)
        const cert = files === null ? null : yield* Effect.try(() => certificate(files))
        if (i.pass === undefined) {
          return { certificate: cert }
        }
        const ref = i.pass.trim()
        const at = /^https?:\/\//u.test(ref) ? null : yield* issued(ref)
        const bytes = yield* Effect.tryPromise(async () => {
          if (/^https?:\/\//u.test(ref)) {
            const res = await fetch(ref, { signal: AbortSignal.timeout(30_000) })
            if (!res.ok) {
              throw new Error(`It answers ${res.status}`)
            }
            return new Uint8Array(await res.arrayBuffer())
          }
          const file = at === null ? ref : at.file
          if (!existsSync(file)) {
            throw new Error(`No pass ${ref}`)
          }
          return new Uint8Array(readFileSync(file))
        })
        const checked = yield* Effect.try(() => checkBytes(bytes))
        return {
          valid: checked.passes.every((p) => p.valid),
          ...checked,
          certificate: cert,
        }
      }),
  )

  const checkLinkTool = tool(
    "wallet_check_link",
    {
      description:
        "Opens a link the way someone else would (Safari on an iPhone, no cookies) and checks every pass it gives: a pass's own link, or a page whose Add to Wallet links it follows. Each must answer, be served as application/vnd.apple.pkpass (or .pkpasses for several) and verify as iOS would. Answers ok, problems and each link's passes.",
      readOnly: true,
      input: Schema.Struct({ link: Schema.String }),
    },
    (i) => Effect.tryPromise(async () => await checkLink(i.link.trim())),
  )

  const notify = tool(
    "notify",
    {
      description:
        "A notification on the iPhone that the user can answer from the lock screen: the reply goes to the space's chat. options become buttons.",
      input: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
        space: Schema.optionalKey(SpaceId),
        options: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    },
    (i) =>
      Effect.gen(function* notifying() {
        const id = crypto.randomUUID()
        const space = yield* placed(i.space)
        const options_ = i.options ?? []
        const events = yield* AppEvents
        yield* Effect.orDie(
          events.emit(
            Notified.make({ id, title: i.title, body: i.body, space, options: options_ }),
          ),
        )
        const brain = yield* Brain
        const { ds, badge } = yield* brain.read(devicesBadgeRead)
        const sent = yield* send(alerts(ds), {
          type: "alert",
          payload: {
            aps: {
              alert: { title: i.title, body: i.body },
              sound: "default",
              badge,
              category: options_.length > 0 ? "ask.options" : "ask",
              "thread-id": space,
              "mutable-content": 1,
            },
            ask: { id, options: options_ },
            space,
          },
        })
        // A miss comes back to the agent that sent it, with why: `sent` 0 and `reason`.
        return { id, ...sent }
      }),
  )

  const app = defineApp<Brain | AppEventsService>({
    name: "iphone",
    version: "1",
    instructions:
      "The iPhone: Live Activities (progress, countdown, status), Wallet passes (issue, bundle, check, check a link) and notifications the user can answer. A boarding pass from a screenshot or PDF: decode its barcode, then issue the pass with that code as it is.",
    tools: [start, update, end, pass, bundle, check, checkLinkTool, notify],
    events: [Reported, Opened, Located, Activity, PassIssued, PassMade, Notified],
  })

  /**
   * A closed item's notifications leave every phone: a quiet push it clears them on. From its
   * cursor, so one closed as the core stopped still clears; a push no phone took is tried again.
   */
  const pushes = react(
    "iphone-clears",
    // One taken out of the queue to be reworked leaves the phones as a closed one does.
    (e) =>
      CLOSES.has(e.type) ||
      (e.type === "item.revised" &&
        typeof e.payload === "object" &&
        e.payload !== null &&
        "revising" in e.payload),
    (e) =>
      Effect.gen(function* one() {
        const brain = yield* Brain
        const item = decodeItem(e.payload)
        const { ds, badge } = yield* brain.read(devicesBadgeRead)
        const targets = alerts(ds)
        const r = yield* send(targets, {
          type: "background",
          payload: { aps: { "content-available": 1, badge }, closed: item.id },
        })
        if (r.sent === 0 && targets.length > 0 && push() !== null) {
          yield* Effect.fail(r.reason)
        }
      }).pipe(Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 5 })),
  )

  /** Whether any phone can be pushed to. */
  const reachable = Effect.gen(function* reaching() {
    const brain = yield* Brain
    return push() !== null && alerts(yield* brain.read(devicesRead)).length > 0
  })

  /**
   * What needs the user, on every phone: a new item (answered or marked done from the lock screen),
   * or a reply they left unread. An urgent one breaks through Focus.
   */
  const alert = (n: Note) =>
    Effect.gen(function* alerting() {
      const brain = yield* Brain
      const { ds, badge, name } = yield* brain.read(alertRead, n.space)
      const aps = {
        alert:
          n.kind === "reply"
            ? { title: name, body: n.body }
            : { title: n.title, subtitle: name, body: n.body },
        sound: "default",
        badge,
        category: n.kind === "item" ? categoryOf(n.itemKind) : "reply",
        "thread-id": n.space,
        ...(n.kind === "item" && { "mutable-content": 1 }),
        ...(n.urgent === true && { "interruption-level": "time-sensitive" }),
      }
      return yield* send(alerts(ds), {
        type: "alert",
        payload:
          n.kind === "item"
            ? {
                aps,
                item: n.item,
                space: n.space,
                kind: n.itemKind ?? "task",
                options: n.options ?? [],
                ...(n.portal === true && { portal: true }),
              }
            : { aps, space: n.space, seq: n.seq },
        ...(n.kind === "item" && { collapse: `item-${n.item ?? ""}` }),
      })
    })

  /** GET /passes/<serial>: an issued pass or bundle, as Wallet takes it. */
  const passes = (request: Request) =>
    Effect.map(issued(new URL(request.url).pathname.split("/").at(-1) ?? ""), (at) =>
      at === null
        ? new Response("No such pass", { status: 404 })
        : new Response(Bun.file(at.file), { headers: { "content-type": at.type } }),
    )

  return { app, pushes, passes, alert, reachable }
}
