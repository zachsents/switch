// The desktop as a widget host: what extensions offer and each placed widget's A2UI messages are
// queries on the brain's `/widgets`, rendered with A2UI's basic catalog and Switch's catalog, both in
// Switch's look, and the MCP catalog, whose `McpApp` runs an MCP App in A2UI's double-iframe sandbox
// (/a2ui-sandbox/).
import { A2uiMcpApp, mcpCatalog } from "@a2ui/catalog-mcp"
import type { ReactCatalogComponent } from "@a2ui/react"
import { Catalog, MessageProcessor } from "@a2ui/web_core/v1_0"
import { throttle } from "@tanstack/react-pacer"
import { queryOptions, useQuery } from "@tanstack/react-query"

import { brainQuery, eventListeners } from "../brain/client.ts"
import { rec, str } from "../brain/json.ts"
import type { Shown } from "../brain/store.ts"
import { queryClient } from "../query.ts"
import { basic } from "./basic/catalog.ts"
import { callTool, widgetsUrl } from "./call.ts"
import { switchCatalog } from "./catalog.tsx"
import { current } from "./old-parts.ts"
import { onPageTheme, themed } from "./page-theme.ts"

/** A widget an extension offers, as `/widgets` lists it. */
export interface Offered {
  readonly app: string
  readonly name: string
  readonly title: string
  readonly refresh: readonly string[]
}

export const keyOf = (w: { readonly app: string; readonly name: string }) => `${w.app}/${w.name}`

/**
 * The app whose widgets are the views the agent made (the core's brain app): each is there for as
 * long as the brain is, offered or not, and a page among them takes this window's theme.
 */
export const MADE = "brain"

// An extension's app calls its own tools by their gateway names: `printers_camera`.
const SEP = "_"

// @a2ui/catalog-mcp 0.0.3 finds its frame with `:scope > iframe` on its shadow root, which matches
// nothing in Chrome, so McpApp never sends the app to its sandbox. Same element, found
// plainly; drop this once fixed upstream.
// Its tool calls go straight to the extension, through the brain's `/widgets/<app>/<tool>`.
const appTool = async (name: string, args: Record<string, unknown>) => {
  const [app = "", ...rest] = name.split(SEP)
  return await callTool(app, rest.join(SEP), args)
}

// Its frame sits straight in the shadow root, so the size an app asks for never reaches the
// element (FrameSizing resizes the frame's parent, which is none): the element takes it too.
class McpAppElement extends A2uiMcpApp.element {
  callTool = appTool

  requestFrameSize(width?: number, height?: number) {
    // In a widget's own window, the window decides its size.
    if (this.closest("[data-cell]")) {
      return
    }
    const original: unknown = Reflect.get(A2uiMcpApp.element.prototype, "requestFrameSize")
    if (typeof original === "function") {
      Reflect.apply(original, this, [width, height])
    }
    // As tall as its frame, which FrameSizing holds to at least 100 px.
    if (height !== undefined && height > 0) {
      this.style.height = `${Math.max(100, Math.round(height))}px`
    }
  }

  get frameElement(): HTMLIFrameElement | null {
    return this.shadowRoot?.querySelector("iframe") ?? null
  }
}
const mcp = new Catalog(
  mcpCatalog.id,
  "1.0",
  [{ ...A2uiMcpApp, tagName: "switch-mcp-app", element: McpAppElement }],
  [...mcpCatalog.functions.values()],
)

// Lit can update an element whose controller isn't made yet, or is gone as its space is switched
// away, and McpApp's `updated` hook reads it unguarded: "undefined is not an object (evaluating
// 'this.controller.props')". It's guarded to wait for its controller.
const guardUpdated = (element: unknown) => {
  if (typeof element !== "function") {
    return
  }
  const proto: unknown = Reflect.get(element, "prototype")
  if (typeof proto !== "object" || proto === null) {
    return
  }
  const updated: unknown = Reflect.get(proto, "updated")
  if (typeof updated !== "function" || Reflect.get(updated, "guarded") === true) {
    return
  }
  const guarded = function guarded(this: object, ...args: unknown[]) {
    if (Reflect.get(this, "controller") !== undefined) {
      Reflect.apply(updated, this, args)
    }
  }
  Reflect.set(guarded, "guarded", true)
  Reflect.set(proto, "updated", guarded)
}
for (const c of mcp.components.values()) {
  guardUpdated(Reflect.get(c, "element"))
}

// A widget's action is one of its extension's tools by name, its context the arguments; the surface
// id says whose (`printers/overview`).
const processor = new MessageProcessor<ReactCatalogComponent>(
  [switchCatalog, basic, mcp],
  async (action) => {
    const [app = ""] = action.surfaceId.split("/")
    await callTool(app, action.name, action.context)
  },
)

const asOffered = (raw: unknown): Offered => {
  const r = rec(raw)
  return {
    app: str(r.app),
    name: str(r.name),
    title: str(r.title),
    refresh: Array.isArray(r.refresh) ? r.refresh.map(str) : [],
  }
}

/** Gives a widget's messages its own surface id, so two extensions' surfaces never collide, and
 * reads each part Switch's catalog no longer has as what replaced it (old-parts.ts). */
const scoped = (key: string, messages: readonly unknown[]) =>
  messages.map((m) => {
    const out: Record<string, unknown> = { ...rec(m) }
    for (const kind of ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"]) {
      if (out[kind] !== undefined) {
        const body = rec(out[kind])
        out[kind] = {
          ...body,
          surfaceId: key,
          ...(Array.isArray(body.components) && {
            components: body.components.map((c) => current(rec(c))),
          }),
        }
      }
    }
    return out
  })

/** A page's data in this window's theme (page-theme.ts); any other message as it is. */
const withTheme = (message: Record<string, unknown>) => {
  const update = rec(message.updateDataModel)
  const value = rec(update.value)
  return typeof value.page === "string"
    ? { ...message, updateDataModel: { ...update, value: { ...value, page: themed(value.page) } } }
    : message
}

/** MCP Apps receive the requested view input through the standard initialized tool-input event. */
const withInput = (
  messages: readonly Record<string, unknown>[],
  key: string,
  input: Shown["input"],
) => {
  if (input === undefined) {
    return messages
  }
  const path = "/__switch_view_input"
  let fallback = false
  const bound = messages.map((message) => {
    const update = rec(message.updateComponents)
    if (!Array.isArray(update.components)) {
      return message
    }
    return {
      ...message,
      updateComponents: {
        ...update,
        components: update.components.map((raw) => {
          const component = rec(raw)
          if (component.component !== "McpApp") {
            return component
          }
          const data = rec(component.data)
          if (typeof rec(data.paths).toolInput === "string") {
            return component
          }
          fallback = true
          return { ...component, data: { ...data, paths: { ...rec(data.paths), toolInput: path } } }
        }),
      },
    }
  })
  return fallback
    ? [...bound, { version: "1.0", updateDataModel: { surfaceId: key, path, value: input } }]
    : bound
}

const placed = () => queryClient.getQueryData(brainQuery.queryKey)?.extra.widgets ?? []

/** What extensions offer, by key; asked again while a placed widget's extension hasn't connected yet. */
const offeredQuery = queryOptions({
  queryKey: ["widgets"],
  queryFn: async () => {
    const res = await fetch(widgetsUrl())
    const raw: unknown = await res.json()
    return new Map((Array.isArray(raw) ? raw : []).map(asOffered).map((w) => [keyOf(w), w]))
  },
  staleTime: Infinity,
  refetchInterval: (q) => {
    const offered = q.state.data
    return placed().some((w) => offered?.has(keyOf(w)) !== true) ? 3000 : false
  },
})

/** Where a widget's messages come from: its tool called with its input, else its placement's. */
const urlOf = (w: Shown) =>
  widgetsUrl(`/${w.app}/${w.name}`, w.input ? { input: JSON.stringify(w.input) } : {})

/**
 * A widget's messages taken into its surface under `key`, given `w`'s input, and a page the agent
 * made in this window's theme: every message the first time; after that only data, so the surface
 * and its frames stay. Answers the surface, A2UI's own model, which its view subscribes to.
 */
export const take = (key: string, raw: readonly unknown[], w?: Shown) => {
  const scopedMessages = withInput(scoped(key, raw), key, w?.input)
  const messages = w?.app === MADE ? scopedMessages.map(withTheme) : scopedMessages
  const fresh = processor.model.getSurface(key) === undefined
  processor.processMessages(
    fresh ? messages : messages.filter((m) => m.updateDataModel !== undefined),
  )
  return processor.model.getSurface(key) ?? null
}

/** A widget's surface: a placed one's under its own key, a chat's under `key`. */
export const surfaceQuery = (w: Shown, key = keyOf(w)) =>
  queryOptions({
    queryKey: ["widget", key, w.app, w.name, JSON.stringify(w.input ?? {})],
    queryFn: async () => {
      const res = await fetch(urlOf(w))
      if (!res.ok) {
        throw new Error(`No widget ${key}`)
      }
      const raw: unknown = await res.json()
      return take(key, Array.isArray(raw) ? raw : [], w)
    },
    staleTime: Infinity,
    structuralSharing: false,
  })

/** A surface from messages at hand (the gallery's), under `key`, through the same processor. */
export const heldSurfaceQuery = (key: string, messages: readonly unknown[]) =>
  queryOptions({
    queryKey: ["held", key],
    queryFn: () => {
      processor.processMessages(scoped(key, messages))
      return processor.model.getSurface(key) ?? null
    },
    staleTime: Infinity,
    structuralSharing: false,
  })

export const useOffered = () => useQuery(offeredQuery).data ?? new Map<string, Offered>()

/** A widget's data is asked again when an event it names lands, at most once per 100 ms. */
const refreshes = new Map<string, () => void>()
const refresh = (key: string) => {
  const held = refreshes.get(key)
  if (held) {
    held()
    return
  }
  const made = throttle(
    () => {
      void queryClient.invalidateQueries({ queryKey: ["widget", key] })
    },
    { wait: 100, leading: false, trailing: true },
  )
  refreshes.set(key, made)
  made()
}

eventListeners.add((e) => {
  const offered = queryClient.getQueryData(offeredQuery.queryKey)
  const p = rec(e.payload)
  if (e.type.startsWith("widget.") && offered?.has(`${str(p.app)}/${str(p.name)}`) !== true) {
    void queryClient.invalidateQueries({ queryKey: offeredQuery.queryKey })
  }
  // A placement's input may have changed: its data again.
  if (e.type === "widget.placed" || e.type === "widget.moved") {
    void queryClient.invalidateQueries({ queryKey: ["widget", `${str(p.app)}/${str(p.name)}`] })
  }
  // Every surface loaded, placed or in a chat, refreshes on the events its widget names.
  for (const q of queryClient.getQueryCache().findAll({ queryKey: ["widget"] })) {
    const [, key, app, name] = q.queryKey
    const w = offered?.get(`${String(app)}/${String(name)}`)
    if (
      typeof key === "string" &&
      w?.refresh.includes(e.type) === true &&
      processor.model.getSurface(key)
    ) {
      refresh(key)
    }
  }
})

// The theme or the system's appearance changed: the agent's pages shown again in it.
onPageTheme(() => {
  void queryClient.invalidateQueries({
    queryKey: ["widget"],
    predicate: (q) => q.queryKey[2] === MADE,
  })
})
