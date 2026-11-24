// A space's chat: its master thread, keeping to its latest like a chat, its asks in it where they
// were raised, and the box as the whole bottom cell. ⌘F's bar is its top cell; a line found, here
// or from ⌘K, is brought into view.
import type { SpaceId } from "@switch/brain"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import { messageForm } from "../brain/forms.ts"
import { editMutation, postMutation } from "../brain/mutations.ts"
import { HOME } from "@switch/brain/commands"
import * as derive from "../brain/derive.ts"
import { useBrain } from "../brain/use-brain.ts"
import { useChat } from "../brain/use-chat.ts"
import { AskInChat } from "./ask-in-chat.tsx"
import { Box } from "./box.tsx"
import { ReplyRows } from "./reply-rows.tsx"
import { answered, clearReplies, replyingTo, useReplying } from "./replying.ts"
import { WordsBar } from "./words-bar.tsx"
import { withAsks } from "./chat-asks.ts"
import { runs } from "./runs.ts"
import { LineView, Typing } from "./chat.tsx"
import { FindBar } from "./find-bar.tsx"
import { station } from "./look.ts"
import { Scroll } from "./scroll.tsx"
import { followScroll } from "./follow-end.ts"
import { useFindIn } from "./use-find-in.ts"
import { useNow } from "./use-now.ts"
import { useRead } from "./use-read.ts"

export const SpaceChat = ({
  space,
  at,
  searching,
  onSearchEnd,
  onLaidOut,
}: {
  space: SpaceId
  /** A line to bring into view, by seq. */
  at: number | null
  /** ⌘F's bar is open. */
  searching: boolean
  onSearchEnd: () => void
  onLaidOut: () => void
}) => {
  const find = useFindIn(space)
  const now = useNow()
  const target = searching ? find.seq : at
  const { lines, older } = useChat(space, target)
  const post = useMutation(postMutation)
  useRead(space)
  const edit = useMutation(editMutation)
  // The seq of the message being edited in the box.
  const [editing, setEditing] = useState<number | null>(null)
  const last = lines.findLast((l) => l.who === "user" && !l.widget)
  // The message the chat's turn answered: their last one here.
  const lastSaid = lines.findLast((l) => l.who === "user" && !l.widget && l.home === space)
  const recall = () => {
    if (last?.seq === undefined || last.home !== space || last.pending) {
      return null
    }
    setEditing(last.seq)
    return last.text
  }
  const { name, ink, asks, closed, ready, since, undelivered } = useBrain((s) => ({
    ready: s.ready,
    undelivered: derive.undelivered(s, space),
    since: derive.typingSince(s, space),
    name: s.spaces.get(space)?.name ?? "Chat",
    ink: space === HOME ? "var(--color-home)" : station(s, space).ink,
    asks: [...s.extra.actions.values()].filter((a) => a.space === space),
    closed: s.extra.closed.filter((a) => a.space === space),
  }))
  // Typing until its reply lands.
  const typing = since !== null && !lines.some((l) => l.who === "agent" && (l.time ?? 0) >= since)
  const replies = useReplying(space)
  const entries = withAsks(lines, asks, closed)
  const { leads, ends } = runs(entries)
  const focus = target === null ? null : (entries.find((e) => e.seq === target)?.key ?? null)
  return (
    <section data-chat={space} className="relative flex min-h-0 flex-1 flex-col">
      {ready && entries.length === 0 && (
        <p className="pointer-events-none absolute inset-0 m-0 flex items-center justify-center text-ui text-ink2">
          <span className="trim">No messages</span>
        </p>
      )}
      {searching && <FindBar find={find} onClose={onSearchEnd} />}
      <Scroll
        conversation={`space:${space}`}
        label={name}
        items={entries}
        keyOf={(e) => e.key}
        render={(e) =>
          e.kind === "line" ? (
            <LineView
              line={e.line}
              mine={ink}
              here={space}
              title={name}
              lead={leads.get(e.key) ?? { kind: "apart" }}
              tail={ends.has(e.key)}
              undelivered={e.line.key === lastSaid?.key ? undelivered : null}
            />
          ) : (
            <div className="flex min-w-0 flex-col pt-3">
              <AskInChat item={e.item} open={e.open} now={now} />
            </div>
          )
        }
        onTop={older}
        onLaidOut={onLaidOut}
        focus={focus}
        tail={typing && <Typing />}
      />
      <WordsBar space={space} />
      <Box
        attach
        place={`space:${space}`}
        above={<ReplyRows space={space} />}
        more={answered(replies)}
        placeholder={space === HOME ? "Talk to Switch…" : `Talk to Switch about ${name}…`}
        schema={messageForm}
        onRecall={recall}
        editing={editing !== null}
        onCancel={() => {
          setEditing(null)
        }}
        error={edit.error?.message}
        onSend={(words, files) => {
          edit.reset()
          followScroll(`space:${space}`)
          if (editing === null) {
            post.mutate({
              id: crypto.randomUUID(),
              space,
              ...words,
              files,
              replyTo: replyingTo(space),
            })
            clearReplies(space)
          } else {
            edit.mutate({ seq: editing, text: words.text })
            setEditing(null)
          }
        }}
      />
    </section>
  )
}
