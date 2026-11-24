// What the agent makes to show: an A2UI surface of the basic catalog's and Switch's parts, or a
// page (page.ts). Kept as a blob, so the same view is one blob, named by its hash; it's the brain
// app's widget of that name (`brain/<hash>`), shown in a chat or placed in a space like any app's.
import { Blobs, hashOf } from "@switch/brain"
import { Effect, Option, Schema } from "effect"
import {
  BASIC_CATALOG,
  BASIC_PARTS,
  MCP_CATALOG,
  Rejected,
  SWITCH_CATALOG,
  SWITCH_PARTS,
} from "switch-ext-kit"

/** The brain app's name: the app a view the agent makes is a widget of. */
export const brainName = "brain"

/** A view as it's kept: its title, and its surface's messages or its page. */
const View = Schema.Union([
  Schema.Struct({ title: Schema.String, surface: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ title: Schema.String, page: Schema.String }),
])
export type View = typeof View.Type

const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(View))

const SURFACE = "view"

/** Every part, by catalog. */
const PARTS: Record<string, Record<string, Schema.Decoder<unknown>>> = {
  [BASIC_CATALOG]: BASIC_PARTS,
  [SWITCH_CATALOG]: SWITCH_PARTS,
}

/** What every component may carry beside its part's own properties (A2UI's ComponentCommon). */
const COMMON = new Set([
  "id",
  "component",
  "catalogId",
  "accessibility",
  "@accessibility",
  "metadata",
])

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

/** The catalog a part is in, the basic one first. */
const catalogOf = (part: string) => {
  if (part in BASIC_PARTS) {
    return BASIC_CATALOG
  }
  return part in SWITCH_PARTS ? SWITCH_CATALOG : undefined
}

/** The ids a component's properties point at: its child, children, a tab's, a template's. */
const refsOf = (props: Record<string, unknown>) => {
  const ids: string[] = []
  for (const key of ["child", "trigger", "content"]) {
    const id = props[key]
    if (typeof id === "string") {
      ids.push(id)
    }
  }
  const { children } = props
  if (Array.isArray(children)) {
    ids.push(...children.filter((c): c is string => typeof c === "string"))
  } else if (typeof record(children).componentId === "string") {
    ids.push(String(record(children).componentId))
  }
  if (Array.isArray(props.tabs)) {
    ids.push(
      ...props.tabs.map((t) => record(t).child).filter((c): c is string => typeof c === "string"),
    )
  }
  return ids
}

/**
 * A surface's messages from its components and data model, each component in the catalog that
 * has its part (the basic one first: `Row` is its layout row unless `catalogId` says Switch's), or
 * what's wrong with them, every problem at once.
 */
export const surfaceOf = (
  components: readonly Record<string, unknown>[],
  data: Record<string, unknown> | undefined,
) => {
  const wrong: string[] = []
  const ids = new Set<string>()
  const placed = components.map((c) => {
    const id = typeof c.id === "string" ? c.id : ""
    const part = typeof c.component === "string" ? c.component : ""
    const where = `${part || "A component"} ${id === "" ? "" : `'${id}'`}`.trim()
    if (id === "") {
      wrong.push(`${where}: no id`)
    } else if (ids.has(id)) {
      wrong.push(`${where}: its id is taken`)
    }
    ids.add(id)
    const catalog = typeof c.catalogId === "string" ? c.catalogId : catalogOf(part)
    const schema = catalog === undefined ? undefined : PARTS[catalog]?.[part]
    if (!schema) {
      wrong.push(
        `${where}: no such part. Basic: ${Object.keys(BASIC_PARTS).join(", ")}. Switch's: ${Object.keys(SWITCH_PARTS).join(", ")}.`,
      )
      return c
    }
    const props = Object.fromEntries(Object.entries(c).filter(([key]) => !COMMON.has(key)))
    const checked = Schema.decodeUnknownResult(schema)(props, {
      errors: "all",
      onExcessProperty: "error",
    })
    if (checked._tag === "Failure") {
      wrong.push(`${where}: ${checked.failure.message}`)
    }
    return catalog === BASIC_CATALOG ? c : { ...c, catalogId: catalog }
  })
  if (!ids.has("root")) {
    wrong.push("No component has the id 'root'")
  }
  for (const c of components) {
    for (const ref of refsOf(c)) {
      if (!ids.has(ref)) {
        wrong.push(`${String(c.component)} '${String(c.id)}': no component '${ref}'`)
      }
    }
  }
  if (wrong.length > 0) {
    return { wrong: wrong.join("\n") } as const
  }
  return {
    surface: [
      { version: "1.0", createSurface: { surfaceId: SURFACE, catalogId: BASIC_CATALOG } },
      { version: "1.0", updateComponents: { surfaceId: SURFACE, components: placed } },
      ...(data === undefined
        ? []
        : [{ version: "1.0", updateDataModel: { surfaceId: SURFACE, path: "/", value: data } }]),
    ],
  } as const
}

/** Keeps a view; its name is its blob's hash. */
export const keepView = (view: View) =>
  Effect.gen(function* keeping() {
    const blobs = yield* Blobs
    const stored = yield* blobs
      .put(Response.json(view).body ?? new ReadableStream())
      .pipe(Effect.mapError((reason) => new Rejected({ reason })))
    return stored.hash
  })

/** A kept view by its name, or none. */
export const readView = (name: string) =>
  Effect.gen(function* reading() {
    const blobs = yield* Blobs
    const hash = hashOf(name)
    const at = hash === null ? null : yield* blobs.path(hash)
    if (at === null) {
      return Option.none<View>()
    }
    return decodeView(yield* Effect.promise(async () => await Bun.file(at).text()))
  })

/**
 * A view as a widget's A2UI messages: its surface as made, or its page in McpApp, the page in the
 * data model, where a client puts its own theme into it.
 */
export const messagesOf = (view: View): readonly unknown[] =>
  "surface" in view
    ? view.surface
    : [
        { version: "1.0", createSurface: { surfaceId: SURFACE, catalogId: MCP_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: SURFACE,
            components: [
              {
                id: "root",
                component: "McpApp",
                title: view.title,
                htmlContent: { "@path": "/page" },
              },
            ],
          },
        },
        {
          version: "1.0",
          updateDataModel: {
            surfaceId: SURFACE,
            path: "/",
            value: { page: view.page },
          },
        },
      ]
