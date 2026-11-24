// A live picture, such as a camera's: a frame from the extension's `action` with `args` every
// `every` ms, edge to edge at `ratio`. The core answers the picture itself (`?as=picture`), and
// nothing when it's the frame this one has: a printer's camera makes a new frame of 300 KB or more
// about every two seconds, and as base64 in its JSON result, twice, it was 1 MB a second a feed.
// Only a live frame is painted (so it needs no mark saying so): none older than ten seconds, none
// while the source fails, whose words show in its place.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { z } from "zod"

import { widgetsUrl } from "./call.ts"

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

/** A frame older than this is no longer live: the picture shows nothing rather than it. */
const LIVE_MS = 10_000

/** When the core's frame was taken, which says the frame it is (the gateway's picture.ts). */
const PICTURE_AT = "X-Picture-At"

interface Held {
  /** Its address, a blob's. */
  readonly frame: string
  readonly at: number
  /** The core's name for it, sent back as the one this has. */
  readonly tag: string
}

// Each feed's last frame and when it was taken, in memory only: a feed shown again within LIVE_MS
// paints it on its first frame, then the live one as it comes; an older one is never painted.
const last = new Map<string, Held>()
const keyOf = (app: string, tool: string, args: Record<string, unknown>) =>
  `${app}/${tool}/${JSON.stringify(args)}`

/** A frame's address let go once nothing paints it. */
const release = (frame: string) => {
  setTimeout(() => {
    URL.revokeObjectURL(frame)
  }, LIVE_MS)
}

const keep = (key: string, held: Held | null) => {
  const was = last.get(key)
  if (was !== undefined && was.frame !== held?.frame) {
    release(was.frame)
  }
  if (held === null) {
    last.delete(key)
  } else {
    last.set(key, held)
  }
}

/** Frames kept on disk by an earlier version: old by definition, so gone. */
export const forgetKeptFrames = () => {
  const kept: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) ?? ""
    if (key.startsWith("switch.feed.")) {
      kept.push(key)
    }
  }
  for (const key of kept) {
    localStorage.removeItem(key)
  }
}

const liveAt = (at: number) => Date.now() - at <= LIVE_MS

/** The feed's frame now, as an address; empty when there's no live one. */
export const frameNow = async (app: string, tool: string, args: Record<string, unknown>) => {
  const key = keyOf(app, tool, args)
  const held = last.get(key)
  const res = await fetch(
    widgetsUrl(`/${app}/${tool}`, { as: "picture", ...(held !== undefined && { have: held.tag }) }),
    // Plain text, so the browser sends it without asking first (no CORS preflight).
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(args) },
  ).catch(() => {
    throw new Error("Can't reach the core")
  })
  if (!res.ok) {
    const said = await res.text().catch(() => "")
    throw new Error(said === "" ? "Didn't go through" : said)
  }
  if (res.status === 204) {
    if (held !== undefined && liveAt(held.at)) {
      return held.frame
    }
    keep(key, null)
    return ""
  }
  const tag = res.headers.get(PICTURE_AT)
  const picture = await res.blob()
  // When it was taken, if the extension says (ms): an old frame is no picture.
  const said = Number(tag)
  const at = Number.isFinite(said) && said > 0 ? said : Date.now()
  if (tag === null || picture.size === 0 || !liveAt(at)) {
    keep(key, null)
    return ""
  }
  const frame = URL.createObjectURL(picture)
  keep(key, { frame, at, tag })
  return frame
}

const frameQuery = (app: string, tool: string, args: Record<string, unknown>, every: number) => {
  const held = last.get(keyOf(app, tool, args))
  return queryOptions({
    queryKey: ["feed", app, tool, args],
    queryFn: async () => await frameNow(app, tool, args),
    ...(held !== undefined && liveAt(held.at) && { initialData: held.frame }),
    // The held frame is old at once: the live one is asked for straight away.
    initialDataUpdatedAt: 0,
    refetchInterval: every,
    retry: false,
  })
}

export const Feed = createComponentImplementation(
  {
    name: "Feed",
    schema: z.object({
      /** The extension's tool a frame comes from, and what it's given. */
      action: z.string(),
      args: DynamicValueSchema.optional(),
      every: z.number().optional(),
      /** Width over height: 16 / 9. */
      ratio: z.number().optional(),
    }),
  },
  ({ props, context }) => {
    const app = (context.dataContext.surface?.id ?? "").split("/")[0] ?? ""
    const args = record(props.args)
    const frame = useQuery(frameQuery(app, props.action, args, Math.max(250, props.every ?? 1000)))
    return (
      <div
        data-feed
        className="relative block w-full overflow-hidden bg-black"
        style={{ aspectRatio: props.ratio ?? 16 / 9 }}
      >
        {!frame.isError && frame.data !== undefined && frame.data !== "" && (
          <img
            src={frame.data}
            alt=""
            decoding="sync"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {frame.error && (
          <span className="absolute inset-0 flex items-center justify-center px-inset text-small text-white">
            <span className="trim">{frame.error.message}</span>
          </span>
        )}
      </div>
    )
  },
)
