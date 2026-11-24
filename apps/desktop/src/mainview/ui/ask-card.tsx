// An ask in full, as old Switchboard's card: a head line (the hand, where it's from, what kind it
// is, how long ago, the model that wrote it), its title and its words as Markdown in a quieter
// size, its live view (the screen it's about, ask-portal.tsx), its files in a row, then
// what the user can do (ask-answer.tsx, or a sealed field): one green key, the options as keys, an
// Answer field, and Reply and Dismiss at the row's end. What they do is held a few seconds with Undo
// before it goes. Closed, it's read-only: how it ended as the head's mark, and what was decided
// (ask-decided.tsx) in place of what the user can do.
import type { ReactNode } from "react"
import { useState } from "react"

import type { ActionItem, Kind } from "../brain/items.ts"
import { AskAnswer } from "./ask-answer.tsx"
import { AskDecided } from "./ask-decided.tsx"
import { AskEnding } from "./ask-ending.tsx"
import { AskFiles } from "./ask-files.tsx"
import { AskPortal } from "./ask-portal.tsx"
import { AskReply } from "./ask-reply.tsx"
import { AskSealed } from "./ask-sealed.tsx"
import { Button } from "./kit/button.tsx"
import { Markdown } from "./markdown.tsx"
import { Hand, Stop } from "./marks.tsx"
import { ageOf } from "./time.ts"
import { useHeld } from "./use-held.ts"

const KIND: Record<Kind, string> = {
  task: "To do",
  question: "Question",
  approval: "Approval",
  sealed: "Secret",
}

export const AskCard = ({
  item,
  place,
  now,
  onReply,
  own = false,
}: {
  item: ActionItem
  /** In a window of its own: its videos bigger. */
  own?: boolean
  place?: ReactNode
  now: number
  /** Reply attaches it to a box instead of opening a field here. */
  onReply?: () => void
}) => {
  const { held, sent, error, hold, undo } = useHeld()
  const [replying, setReplying] = useState(false)
  const reply = (
    <Button
      look="flat"
      aria-pressed={replying}
      onClick={() => {
        if (onReply) {
          onReply()
        } else {
          setReplying(!replying)
        }
      }}
    >
      Reply
    </Button>
  )
  const keys = (
    <>
      {reply}
      <Button
        look="flat"
        onClick={() => {
          hold({ kind: "close", close: { id: item.id, status: "dismissed" } }, "Dismissed")
        }}
      >
        Dismiss
      </Button>
    </>
  )
  /** What the user can do, or what they did, held with Undo. */
  const doing = held ? (
    <div className="flex h-line items-center gap-2 text-ui text-ink">
      <span className="trim min-w-0 flex-1 truncate">{held.label}</span>
      {!sent && (
        <Button look="key" onClick={undo}>
          Undo
        </Button>
      )}
    </div>
  ) : (
    <>
      {item.kind === "sealed" ? (
        <>
          <AskSealed item={item} />
          <div className="flex items-center justify-end">{reply}</div>
        </>
      ) : (
        <AskAnswer item={item} hold={hold} aside={keys} />
      )}
      {replying && (
        <AskReply
          item={item}
          onSent={() => {
            setReplying(false)
          }}
        />
      )}
    </>
  )
  return (
    <article data-item={item.id} className="flex flex-col gap-3 pt-3 pb-3.5">
      <header className="flex h-5 items-center gap-[9px] text-small text-ink2">
        {item.status === "open" ? <Hand /> : <AskEnding item={item} />}
        {place}
        <span className="trim font-medium">{KIND[item.kind]}</span>
        <span className="trim text-caption tabular-nums text-ink3">{ageOf(now - item.at)}</span>
        {item.model && <span className="trim text-caption text-ink3">{item.model.name}</span>}
      </header>
      <div className="selectable flex flex-col gap-1">
        <p className="text-read font-medium text-ink">{item.title}</p>
        {item.body !== "" && item.body !== item.title && (
          <div className="text-ui text-ink2">
            <Markdown>{item.body}</Markdown>
          </div>
        )}
      </div>
      {item.portal && item.status === "open" && <AskPortal item={item} />}
      <AskFiles
        files={(item.attachments ?? []).filter((a) => a.option === undefined)}
        size={own ? "window" : "ask"}
      />
      {error !== null && (
        <div className="flex h-line items-center gap-2 text-small text-ink">
          <Stop size={12} />
          <span className="trim">{error}</span>
        </div>
      )}
      {item.status === "open" ? doing : <AskDecided item={item} />}
    </article>
  )
}
