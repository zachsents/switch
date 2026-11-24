// The brain's sync socket, for what changes elsewhere: when a contacts event lands (the agent's
// edit, an import, an undo from chat), every contacts query goes stale and what's on screen asks
// again. The link's state is query data, written only here.
import { queryOptions } from "@tanstack/react-query"
import { Option, Schema } from "effect"

import { coreUrl } from "./core.ts"
import { queryClient } from "./query.ts"
import { CONTACTS } from "./queries.ts"

export type Link = "connecting" | "open" | "down"

const LINK = ["link"] as const

export const linkQuery = queryOptions({
  queryKey: LINK,
  queryFn: () => queryClient.getQueryData<Link>(LINK) ?? "connecting",
  initialData: (): Link => "connecting",
  staleTime: Infinity,
  gcTime: Infinity,
})

/** The extension's event types: high-rate or not, the brain sends them to a client that watches. */
const WATCHED = [
  "contacts.person_created",
  "contacts.person_updated",
  "contacts.person_merged",
  "contacts.person_split",
  "contacts.person_retired",
  "contacts.sender_unknown",
  "contacts.pushed",
  "contacts.conflicted",
  "contacts.imported",
  "contacts.undone",
]

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("snapshot"), seq: Schema.Finite }),
      Schema.Struct({
        type: Schema.Literal("events"),
        events: Schema.Array(Schema.Struct({ seq: Schema.Finite, type: Schema.String })),
      }),
    ]),
  ),
)

const BACKOFF_MIN = 250
const BACKOFF_MAX = 5000
/** How long a drop may last before it shows. */
const DOWN_AFTER = 2000

const setLink = (link: Link) => {
  queryClient.setQueryData(LINK, link)
}

let cursor: number | null = null
let backoff = BACKOFF_MIN
let downTimer: ReturnType<typeof setTimeout> | undefined

const open = () => {
  const url = new URL(coreUrl())
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/"
  url.searchParams.set("source", "contacts-app")
  if (cursor !== null) {
    url.searchParams.set("since", String(cursor))
  }
  const ws = new WebSocket(url)
  ws.addEventListener("open", () => {
    backoff = BACKOFF_MIN
    clearTimeout(downTimer)
    setLink("open")
    ws.send(JSON.stringify({ type: "watch", types: WATCHED }))
    // Back after a drop: whatever changed meanwhile.
    void queryClient.invalidateQueries({ queryKey: CONTACTS })
  })
  ws.addEventListener("message", (m) => {
    const message = typeof m.data === "string" ? Option.getOrUndefined(decode(m.data)) : undefined
    if (message?.type === "snapshot") {
      cursor = message.seq
    } else if (message?.type === "events") {
      cursor = message.events.at(-1)?.seq ?? cursor
      if (message.events.some((e) => e.type.startsWith("contacts."))) {
        void queryClient.invalidateQueries({ queryKey: CONTACTS })
      }
    }
  })
  ws.addEventListener("close", () => {
    clearTimeout(downTimer)
    downTimer = setTimeout(() => {
      setLink("down")
    }, DOWN_AFTER)
    setTimeout(open, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX)
  })
}

open()
