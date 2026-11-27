// The brain as an app: reading its log and spaces, posting a message to a space, and where widgets
// show. It reads the gateway for the widgets apps offer, so it's kept once the gateway is up.
import {
  allCovers,
  allSpaces,
  ArchiveSpace,
  Brain,
  CreateSpace,
  MoveSpace,
  RenameSpace,
  spaceFor,
  spaceNamed,
  UnarchiveSpace,
  Condition,
  DescribeUser,
  MoveMessage,
  placements,
  PlaceWidget,
  PostMessage,
  Emoji,
  Tapback,
  ReactToMessage,
  RemoveMessage,
  RemoveWidget,
  RestoreMessage,
  SetSpaceFolder,
  SpaceId,
  userOf,
  WidgetInput,
  WidgetSize,
  BYPASS,
  Bypass,
  bypassOf,
  defineRead,
  emDashRefusal,
  stringsIn,
  unheardTask,
  unlessBypassed,
} from "@switch/brain"
import type { Space, Blobs } from "@switch/brain"
import { Effect, Schema } from "effect"

import { answer, Caller, defineApp, Rejected, tool } from "switch-ext-kit"

import { Gateway } from "./gateway.ts"
import {
  PAGE_GUIDE,
  PAGE_MAX,
  PAGE_MAX_HEIGHT,
  PAGE_MIN_HEIGHT,
  PAGE_THEME,
  preparePage,
  themedPage,
  withHeight,
} from "./page.ts"
import type { Pages } from "./pages/pages.ts"
import { pagesTool, publish } from "./pages/tool.ts"
import { Preview } from "./preview.ts"
import { brainName, keepView, surfaceOf } from "./views.ts"
import type { View } from "./views.ts"

const parse: (json: string) => unknown = JSON.parse

// The brain app's reads of the brain, by name (reads.ts), so they run in a reader thread.
const spaceNamedRead = defineRead("gateway/brain/space-named", (db, given: string) =>
  spaceNamed(db, given, { archived: true }),
)
const spacesRead = defineRead("gateway/brain/spaces", (db) =>
  db
    .query<Pick<Space, "id" | "name" | "parent"> & { archived: number; aliases: string }, []>(
      "SELECT id, name, parent, archived, aliases FROM spaces ORDER BY id",
    )
    .all()
    .map((s) => ({ ...s, archived: s.archived === 1, aliases: parse(s.aliases) })),
)
const spaceForRead = defineRead(
  "gateway/brain/space-for",
  (db, given: string | undefined, asker: string | null) => spaceFor(db, given, asker),
)
const spaceIdsRead = defineRead(
  "gateway/brain/space-ids",
  (db) => new Set(allSpaces(db).map((s) => s.id)),
)
const coverLooksRead = defineRead("gateway/brain/cover-looks", (db) =>
  allCovers(db).map((c) => c.image),
)
/** The message a reaction goes on: `seq`, else the space's last one not the agent's. */
const reactedRead = defineRead(
  "gateway/brain/reacted",
  (db, space: string, seq: number | undefined) =>
    seq === undefined
      ? db
          .query<{ seq: number; source: string }, [string]>(
            "SELECT seq, source FROM messages WHERE space = ? AND source != 'agent' ORDER BY seq DESC LIMIT 1",
          )
          .get(space)
      : db
          .query<{ seq: number; source: string }, [number]>(
            "SELECT seq, source FROM messages WHERE seq = ?",
          )
          .get(seq),
)
const placementsRead = defineRead("gateway/brain/placements", (db) => placements(db))
const unheardRead = defineRead("gateway/brain/unheard-task", (db, thread: string) =>
  unheardTask(db, thread),
)
const userRead = defineRead("gateway/brain/user", (db) => userOf(db))
const foldersRead = defineRead("gateway/brain/folders", (db) =>
  db
    .query<{ space: string; machine: string; path: string }, []>(
      "SELECT space, machine, path FROM space_folders ORDER BY space, machine",
    )
    .all(),
)

const QUERY = `Query the brain: a source, then conditions. Rows newest first.
- from: "events" (the log: seq, id, time, type, source, payload; default), "spaces", "messages", "work" (threads and tasks), "items", "expectations", "surprises", "memories", "leads".
- where: [{field, op, value}]: field a column or a path into JSON ("payload.data.facts.state"); op one of ==, !=, >, >=, <, <=, contains, startsWith, in (a list), exists (true/false). On the log, narrow by type, seq, id, time or since.
- since: minutes back. latest: keep each key's newest row (a field), then having: conditions on those (an entity's current state). fields: what to return. oldest: oldest first. limit: default 50, at most 500.
- type, source, space, after: shorthands for the log (type a prefix; space is payload.space; after a seq).
Example: {"where": [{"field": "type", "op": "==", "value": "<extension>.<event>"}], "latest": "payload.data.entity", "having": [{"field": "payload.data.facts.state", "op": "==", "value": "open"}]}`

const query = tool(
  "query",
  {
    description: QUERY,
    readOnly: true,
    input: Schema.Struct({
      from: Schema.optionalKey(Schema.String),
      where: Schema.optionalKey(Schema.Array(Condition)),
      since: Schema.optionalKey(Schema.Finite),
      latest: Schema.optionalKey(Schema.String),
      having: Schema.optionalKey(Schema.Array(Condition)),
      fields: Schema.optionalKey(Schema.Array(Schema.String)),
      oldest: Schema.optionalKey(Schema.Boolean),
      limit: Schema.optionalKey(Schema.Finite),
      type: Schema.optionalKey(Schema.String),
      source: Schema.optionalKey(Schema.String),
      space: Schema.optionalKey(SpaceId),
      after: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* querying() {
      const brain = yield* Brain
      const { type, source, space, after, ...rest } = input
      const where: Condition[] = [...(rest.where ?? [])]
      if (type !== undefined) {
        where.push({ field: "type", op: "startsWith", value: type })
      }
      if (source !== undefined) {
        where.push({ field: "source", op: "==", value: source })
      }
      if (space !== undefined) {
        const id = yield* brain.read(spaceNamedRead, space)
        where.push({ field: "payload.space", op: "==", value: id ?? space })
      }
      if (after !== undefined) {
        where.push({ field: "seq", op: ">", value: after })
      }
      const found = yield* brain.query({ ...rest, where })
      // The log's rows keep the shape this tool has always answered with.
      return (rest.from ?? "events") === "events" ? { events: found.rows } : found
    }),
)

const spaces = tool(
  "spaces",
  {
    description: "Every space: id, name, parent, whether it's archived, and its former names.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const brain = yield* Brain
      const found = yield* brain.read(spacesRead)
      return { spaces: found }
    }),
)

/** A space by its id, name or former name (`spaceNamed`), archived ones too, or why not. */
const named = (given: string) =>
  Effect.gen(function* resolving() {
    const brain = yield* Brain
    const found = yield* brain.read(spaceNamedRead, given)
    return found ?? (yield* new Rejected({ reason: `No space ${given}` }))
  })

/** Why `check`'s words can't go (an em dash, brain's dashes.ts), or null: none, or bypassed. */
const dashesIn = (check: string, texts: readonly string[], bypass: string | undefined) =>
  Effect.gen(function* reading() {
    const caller = yield* Caller
    const dashed = yield* unlessBypassed(emDashRefusal(texts), bypassOf(bypass), {
      check,
      objections: ["dash"],
      work: caller.thread ?? "nowhere",
      ...(caller.space !== null && { space: caller.space }),
    })
    return dashed === null ? null : `${dashed} ${BYPASS}`
  })

/** Where what a tool puts lives: the space given, else the asking work's, else Home (`spaceFor`). */
const placed = (given: string | undefined) =>
  Effect.gen(function* placing() {
    const brain = yield* Brain
    const caller = yield* Caller
    return yield* brain.read(spaceForRead, given, caller.space)
  })

const create = tool(
  "create_space",
  {
    closed: true,
    description:
      "Make a space, only when the user's own words ask for one; never to hold an event or a matter on your own (that goes to the space it's about, or Home). `parent` null puts it at the top level. It's made without a cover: draw one (autonomy_image) and set it (autonomy_cover).",
    input: Schema.Struct({
      name: Schema.String,
      parent: Schema.NullOr(Schema.String),
      about: Schema.optionalKey(Schema.String),
      bypass: Bypass,
    }),
  },
  (input) =>
    Effect.gen(function* creating() {
      const dashed = yield* dashesIn("create_space", [input.name, input.about ?? ""], input.bypass)
      if (dashed !== null) {
        return yield* new Rejected({ reason: dashed })
      }
      const brain = yield* Brain
      const parent = input.parent === null ? null : yield* named(input.parent)
      const base = input.name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "")
        .slice(0, 40)
      const taken = yield* brain.read(spaceIdsRead)
      let id = base || "space"
      for (let n = 2; taken.has(SpaceId.make(id)); n += 1) {
        id = `${base || "space"}-${n}`
      }
      const made = yield* command(CreateSpace.type, {
        id,
        name: input.name.trim(),
        parent,
        ...(input.about !== undefined && { about: input.about }),
      })
      const looks = yield* brain.read(coverLooksRead)
      return {
        id,
        ...made,
        cover: `None yet: draw one with autonomy_image in the look of the spaces' covers, from the blobs in covers, and set it with autonomy_cover.`,
        covers: looks.slice(-3),
      }
    }),
)

const rename = tool(
  "rename_space",
  {
    closed: true,
    description: "Rename a space. Its old name stays known as an alias.",
    input: Schema.Struct({ space: Schema.String, name: Schema.String, bypass: Bypass }),
  },
  (input) =>
    Effect.gen(function* renaming() {
      const dashed = yield* dashesIn("rename_space", [input.name], input.bypass)
      if (dashed !== null) {
        return yield* new Rejected({ reason: dashed })
      }
      const id = yield* named(input.space)
      return yield* command(RenameSpace.type, { id, name: input.name })
    }),
)

const moveSpace = tool(
  "move_space",
  {
    closed: true,
    description: "Move a space inside another; `parent` null puts it at the top level.",
    input: Schema.Struct({ space: Schema.String, parent: Schema.NullOr(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* moving() {
      const id = yield* named(input.space)
      const parent = input.parent === null ? null : yield* named(input.parent)
      return yield* command(MoveSpace.type, { id, parent })
    }),
)

const archive = tool(
  "archive_space",
  {
    closed: true,
    description:
      "Settle a space that's done: archived, it leaves the user's view and takes no new events. `undo` opens it again.",
    input: Schema.Struct({ space: Schema.String, undo: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    Effect.flatMap(named(input.space), (id) =>
      command(input.undo === true ? UnarchiveSpace.type : ArchiveSpace.type, { id }),
    ),
)

const command = (type: string, payload: unknown) =>
  Effect.gen(function* commanding() {
    const brain = yield* Brain
    const receipt = yield* brain.dispatch({
      id: crypto.randomUUID(),
      type,
      source: "agent",
      payload,
    })
    return { seq: receipt.seq }
  })

const react = tool(
  "react",
  {
    closed: true,
    description:
      "React to the user's message, as a tapback: love, like, dislike, laugh, emphasize or question; null takes yours back. Or `emoji`: any one emoji as the reaction instead. `seq`: their message, by default their latest in the space. Reacting again swaps it. An acknowledgement (got it, on it, started) is a reaction, never a message: 🕐 on their message while you work on it; it turns to `like` by itself once that turn and the tasks it delegated are done.",
    input: Schema.Struct({
      space: SpaceId,
      reaction: Schema.optionalKey(Schema.NullOr(Tapback)),
      emoji: Schema.optionalKey(Emoji),
      seq: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* reacting() {
      const brain = yield* Brain
      const space = yield* placed(input.space)
      const said = yield* brain.read(reactedRead, space, input.seq)
      if (!said) {
        return yield* new Rejected({ reason: "No such message" })
      }
      if (said.source === "agent") {
        return yield* new Rejected({ reason: "Only the user's messages take a reaction" })
      }
      const reaction = input.emoji ?? input.reaction
      if (reaction === undefined) {
        return yield* new Rejected({ reason: "Give a reaction or an emoji" })
      }
      // A clock is tied to the work of the turn placing it, which settles it (agent's clocks.ts).
      const caller = yield* Caller
      return yield* command(ReactToMessage.type, {
        seq: said.seq,
        reaction,
        ...(caller.thread !== null && { by: caller.thread }),
      })
    }),
)

const move = tool(
  "move_exchange",
  {
    closed: true,
    description:
      "Move an exchange to the chat of the space it's about: the message at `seq` and the replies to it.",
    input: MoveMessage.payload,
  },
  (input) =>
    Effect.flatMap(named(input.space), (space) => command(MoveMessage.type, { ...input, space })),
)

const remove = tool(
  "remove_message",
  {
    closed: true,
    description:
      "Take a message out of one space it shows in, where it doesn't belong (a mention that doesn't bear on that space, or the wrong space): it stays in the others, and never leaves its last. The user's own removals are hand labels triage and routing learn from. `undo` puts it back.",
    input: Schema.Struct({
      seq: Schema.Finite,
      space: Schema.String,
      undo: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.flatMap(named(input.space), (space) =>
      command(input.undo === true ? RestoreMessage.type : RemoveMessage.type, {
        seq: input.seq,
        space,
      }),
    ),
)

const widgets = tool(
  "widgets",
  {
    description:
      "Where widgets show: each placed widget's app, name, space, index, input and size.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const brain = yield* Brain
      return { widgets: yield* brain.read(placementsRead) }
    }),
)

const place = tool(
  "place_widget",
  {
    closed: true,
    description:
      "Show a widget in a space, or move or resize it: an app's, or one you made (`app` `brain`, `name` from show_widget). A widget can be placed more than once, each placement with its own input (a web page's picture per page): `another` true adds one beside those it has; `id` (as list_widgets gives it) moves or changes that one; neither is its first. `index` is its place among the space's widgets (0 first; none, last). `input` is what its tool is called with, `size` its columns and rows in the space's grid; none keeps what it had.",
    input: Schema.Struct({
      app: Schema.String,
      name: Schema.String,
      space: SpaceId,
      id: Schema.optionalKey(Schema.String),
      another: Schema.optionalKey(Schema.Boolean),
      index: Schema.optionalKey(Schema.Finite),
      input: Schema.optionalKey(WidgetInput),
      size: Schema.optionalKey(WidgetSize),
    }),
  },
  (input) =>
    Effect.gen(function* placing() {
      const space = yield* named(input.space)
      const done = yield* command(PlaceWidget.type, { ...input, space })
      const brain = yield* Brain
      // Its placements now, so a new one's id is at hand to move or remove it by.
      const its = (yield* brain.read(placementsRead)).filter(
        (w) => w.app === input.app && w.name === input.name,
      )
      return { ...done, placements: its }
    }),
)

const unplace = tool(
  "remove_widget",
  {
    closed: true,
    description:
      "Take a widget out of its space: `id` (as list_widgets gives it) one placement of a widget placed more than once; none, its first.",
    input: Schema.Struct({
      app: Schema.String,
      name: Schema.String,
      id: Schema.optionalKey(Schema.String),
    }),
  },
  (input) => command(RemoveWidget.type, input),
)

const SHOWN =
  "Shown in the chat above your reply: don't describe it; say only what it doesn't. `place_widget` with this `widget` puts it among a space's widgets."

const PARTS =
  'A2UI 1.0 components, flat, each with an `id`, one `root`, children by id. Basic: Text (Markdown; a `# ` heading; variant caption), Image, Icon, Row, Column, List, Card, Tabs, Modal, Divider, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput, Video, AudioPlayer. Switch\'s: Line, Slot, Field, Title, Gallery {images: [{url, description?}]} (pictures in a row that scrolls sideways), and charts taking plain data, each with optional prefix, suffix and height: BarChart {labels, series: [{name, values}] (1 to 8), stacked?, horizontal?}, LineChart and AreaChart {labels, series, stacked?}, Sparkline {values}, DonutChart {slices: [{label, value}]}, ScatterChart {series: [{name, points: [[x, y]]}] (1 to 3), xLabel?, yLabel?}, Histogram {values, bins?}, CalendarHeatmap {days: [{date: YYYY-MM-DD, value}]}, Meter {label?, value, max? (100)}. A property may be bound to `data`: {"@path": "/x"}.'

/** What the agent made to show, as it's kept, or why it can't be. */
const madeView = (input: {
  readonly title?: string
  readonly components?: readonly Record<string, unknown>[]
  readonly data?: Record<string, unknown>
  readonly page?: string
  readonly height?: number
  readonly bypass?: string
}) =>
  Effect.gen(function* making() {
    const title = input.title?.trim() ?? ""
    if (title === "") {
      return yield* new Rejected({ reason: "Give what you make a title" })
    }
    // Its words, not its data: no em dash (brain's dashes.ts).
    const dashed = yield* dashesIn(
      "show_widget",
      [title, ...stringsIn(input.components ?? []), input.page ?? ""],
      input.bypass,
    )
    if (dashed !== null) {
      return yield* new Rejected({ reason: `Not shown. ${dashed}` })
    }
    if (input.page === undefined) {
      const made = surfaceOf(input.components ?? [], input.data)
      return "wrong" in made
        ? yield* new Rejected({ reason: made.wrong })
        : ({ title, surface: made.surface } satisfies View)
    }
    if (input.height === undefined) {
      return yield* new Rejected({
        reason: "Give the page its height: preview_html's contentHeight",
      })
    }
    const prepared = preparePage(input.page)
    if ("wrong" in prepared) {
      return yield* new Rejected({ reason: prepared.wrong })
    }
    const height = Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, input.height))
    return { title, page: withHeight(prepared.page, height) } satisfies View
  })

const show = tool(
  "show_widget",
  {
    closed: true,
    description: `Show UI in a space's chat. An app's widget: \`app\`, \`name\`, \`input\` (only widgets whose surfaces include chat). Or one you make, with a short \`title\`: \`components\` (and their \`data\`) for what the parts can say, fast and in the house look; or a self-contained HTML \`page\` for drawing they can't, checked first with preview_html, its \`height\` the contentHeight that gave. ${PARTS} Page: ${PAGE_GUIDE}`,
    input: Schema.Struct({
      space: SpaceId,
      app: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      input: Schema.optionalKey(WidgetInput),
      title: Schema.optionalKey(Schema.String),
      components: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      page: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(PAGE_MAX))),
      height: Schema.optionalKey(Schema.Finite),
      bypass: Bypass,
    }),
  },
  (input) =>
    Effect.gen(function* showing() {
      const { app, name } = input
      // A task's work goes to its parent in its report, as its words do (autonomy app.ts say).
      const brain = yield* Brain
      const caller = yield* Caller
      if (caller.thread !== null && (yield* brain.read(unheardRead, caller.thread ?? ""))) {
        return yield* new Rejected({
          reason:
            "In a task, what you show answers the user's words to it, and none have reached it: what's for them goes in your report, or an item when it needs their hands.",
        })
      }
      const space = yield* placed(input.space)
      const made = [input.components, input.page].filter((x) => x !== undefined).length
      if (made + (app === undefined && name === undefined ? 0 : 1) !== 1) {
        return yield* new Rejected({
          reason: "Give one: an app's widget (app and name), components, or a page",
        })
      }
      if (app !== undefined || name !== undefined) {
        const gateway = yield* Gateway
        const offered = gateway
          .widgets()
          .find((w) => w.app === app && w.name === name && w.surfaces.includes("chat"))
        if (!offered || app === undefined || name === undefined) {
          return yield* new Rejected({ reason: `No chat widget ${app ?? ""}/${name ?? ""}` })
        }
        const widget = { app, name, ...(input.input !== undefined && { input: input.input }) }
        return yield* command(PostMessage.type, { space, text: offered.title, widget })
      }
      const view = yield* madeView(input)
      const widget = { app: brainName, name: yield* keepView(view) }
      const posted = yield* command(PostMessage.type, { space, text: view.title, widget })
      return { ...posted, widget, said: SHOWN }
    }),
)

const previewHtml = tool(
  "preview_html",
  {
    description: `Check an HTML page before show_widget shows it: a picture of it at \`width\` (240 to 1600; 400 by default, a phone's chat, wider on a desktop) in \`appearance\` dark (default) or light, its contentHeight, and its console. ${PAGE_GUIDE}`,
    readOnly: true,
    input: Schema.Struct({
      page: Schema.String.check(Schema.isMaxLength(PAGE_MAX)),
      width: Schema.optionalKey(Schema.Finite),
      appearance: Schema.optionalKey(Schema.Literals(["dark", "light"])),
    }),
  },
  (input) =>
    Effect.gen(function* previewing() {
      const prepared = preparePage(input.page)
      if ("wrong" in prepared) {
        return yield* new Rejected({ reason: prepared.wrong })
      }
      const width = Math.round(Math.min(1600, Math.max(240, input.width ?? 400)))
      const appearance = input.appearance ?? "dark"
      const preview = yield* Preview
      const shot = yield* preview
        .capture({
          page: themedPage(prepared.page, appearance, PAGE_THEME[appearance]),
          width,
          appearance,
        })
        .pipe(Effect.mapError((reason) => new Rejected({ reason })))
      const said = {
        width,
        contentHeight: shot.contentHeight,
        capturedHeight: shot.capturedHeight,
        console: shot.console,
      }
      return answer(said, [
        { type: "image", data: shot.png, mimeType: "image/png" },
        { type: "text", text: JSON.stringify(said) },
      ])
    }),
)

const who = tool("user", { description: "Who the user is: name and about.", readOnly: true }, () =>
  Effect.gen(function* reading() {
    const brain = yield* Brain
    return { user: yield* brain.read(userRead) }
  }),
)

const describe = tool(
  "describe_user",
  {
    description:
      "Set the user's name, or `about`: a line or two of lasting facts about them. Either may be left out.",
    input: Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      about: Schema.optionalKey(Schema.String),
    }),
  },
  (input) => command(DescribeUser.type, input),
)

const folder = tool(
  "folder",
  {
    closed: true,
    description:
      "Set a space's project folder on a machine (an empty path clears it). Its turns, and those of spaces inside it, run on a machine that has it, in it.",
    input: Schema.Struct({ space: SpaceId, machine: Schema.String, path: Schema.String }),
  },
  (input) =>
    Effect.flatMap(named(input.space), (id) =>
      command(SetSpaceFolder.type, { id, machine: input.machine, path: input.path }),
    ),
)

const folders = tool(
  "folders",
  {
    description: "Each space's project folders, by machine.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const brain = yield* Brain
      const found = yield* brain.read(foldersRead)
      return { folders: found }
    }),
)

export const brainApp = defineApp<Blobs | Brain | Gateway | Pages | Preview>({
  name: brainName,
  version: "1",
  instructions: "Switch's brain: one ordered log of everything, its spaces, and who the user is.",
  tools: [
    query,
    spaces,
    create,
    rename,
    moveSpace,
    archive,
    react,
    move,
    remove,
    widgets,
    place,
    unplace,
    show,
    previewHtml,
    publish,
    pagesTool,
    who,
    describe,
    folder,
    folders,
  ],
})
