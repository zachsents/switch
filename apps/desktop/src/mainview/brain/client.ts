// The one connection to the brain, feeding the query cache: the snapshot and live events go
// straight in with `setQueryData` (TanStack's way for a socket), so views read them with queries
// and never fetch. Commands, pages and analytics go back out over the same socket.
import type { StoredEvent } from "@switch/brain"
import { queryOptions } from "@tanstack/react-query"
import { Option, Schema } from "effect"
import { castDraft, enableMapSet, produce } from "immer"
import type { Draft } from "immer"

import { EventId, SpaceId } from "@switch/brain/commands"

import { queryClient } from "../query.ts"
import { onAuth } from "./auth.ts"
import { connect } from "./connection.ts"
import * as outbox from "./outbox.ts"
import * as history from "./history.ts"
import { apply, empty, fromSnapshot, Replies, warmFrom } from "./store.ts"
import type { Pending, State } from "./store.ts"

const { QUIET } = outbox

enableMapSet()

const BRAIN = ["brain"] as const

/**
 * The synced state: only the socket writes it. Anything that asks it to fetch (a reset, the
 * devtools) gets what's held, never a request.
 */
export const brainQuery = queryOptions({
  queryKey: BRAIN,
  queryFn: () => queryClient.getQueryData<State>(BRAIN) ?? empty(),
  initialData: empty,
  staleTime: Infinity,
  gcTime: Infinity,
})

/** Changes the synced state through an immer draft. */
export const change = (recipe: (draft: Draft<State>) => void) => {
  queryClient.setQueryData(brainQuery.queryKey, (prev) => produce(prev ?? empty(), recipe))
}

/** Told of each event as it lands: widgets refresh on the events they name. */
export const eventListeners = new Set<(e: StoredEvent) => void>()

const Shown = Schema.Struct({
  space: Schema.String,
  text: Schema.String,
})
const decodeShown = Schema.decodeUnknownOption(Shown)
const decodeView = Schema.decodeUnknownOption(
  Schema.Struct({ replyTo: Schema.optionalKey(Replies) }),
)

/** The messages kept in the outbox, as the chat shows them. */
const keptMessages = () =>
  outbox.kept().flatMap((e): Pending[] => {
    const p = Option.getOrNull(decodeShown(e.payload))
    if (e.name !== "message.post" || p === null) {
      return []
    }
    const replyTo = Option.getOrNull(decodeView(e.view))?.replyTo ?? []
    return [
      {
        id: e.id,
        space: SpaceId.make(p.space),
        text: p.text,
        files: (e.files ?? []).filter((f) => f.blob === undefined).map((f) => f.name),
        failed: e.rejected !== undefined,
        ...(replyTo.length > 0 && { replyTo }),
      },
    ]
  })

let shown = ""
/** The chat's pending messages follow the outbox: kept, sent, said no to, or given back. */
const followOutbox = () => {
  const now = keptMessages()
  const sig = JSON.stringify(now)
  if (sig === shown) {
    return
  }
  shown = sig
  change((s) => {
    const ids = new Set(now.map((p) => p.id))
    for (const p of s.pending.values()) {
      if (!ids.has(p.id) && p.landed === undefined) {
        s.pending.delete(p.id)
      }
    }
    for (const p of now) {
      s.pending.set(p.id, castDraft(p))
    }
  })
}

const connection = connect({
  onSnapshot: (seq, given) => {
    queryClient.setQueryData(brainQuery.queryKey, (prev) =>
      produce(fromSnapshot(prev ?? empty(), seq, given), (draft) => {
        warmFrom(draft, given)
      }),
    )
    history.fromSnapshot(queryClient, given)
    performance.mark("switch:ready")
  },
  onEvents: (events) => {
    change((draft) => {
      apply(draft, events)
    })
    for (const e of events) {
      history.fold(queryClient, e)
      for (const l of eventListeners) {
        l(e)
      }
    }
  },
  onLink: (link) => {
    change((draft) => {
      draft.link = link
    })
  },
  // Its line is in once the log reaches `seq`; it shows as sent till then.
  onReceipt: (id, seq) => {
    change((draft) => {
      const p = draft.pending.get(id)
      if (p && draft.seq >= seq) {
        draft.pending.delete(id)
      } else if (p) {
        p.landed = seq
      }
    })
  },
})
followOutbox()
outbox.subscribe(followOutbox)
onAuth(followOutbox)

/** Resolves with the seq, or rejects with the brain's reason. */
// A test copy run beside the live app (outbox.ts `QUIET`): nothing it does reaches the brain. What it
// changes shows in it alone, as each command's change shows before the brain answers.
export const command = async (type: string, payload: unknown, id: string = crypto.randomUUID()) =>
  QUIET ? 0 : await connection.command(EventId.make(id), type, payload)

/** Older history: a space's chat or a thread's transcript, before a seq. */
export const page = async (name: string, args: unknown) => await connection.page(name, args)

export const emit = async (event: string, payload: unknown, id?: string) => {
  if (!QUIET) {
    await connection.emit(event, payload, id)
  }
}

/** The event types widgets refresh on: high-rate streams come to the desktop only for them. */
export const watch = (types: readonly string[]) => {
  connection.watch(types)
}
