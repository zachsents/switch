// What the box replies to, a pair each above what the user types: a quote's words, or an ask (its
// mark, title and space), as they are, and under it the user's own reply to it. A click anywhere on
// the pair puts the cursor in that reply; Enter sends the whole message, ⇧Enter breaks the line; ✕
// takes the pair off.
import type { SpaceId } from "@switch/brain"
import { useForm } from "@tanstack/react-form"
import { Textarea } from "@ui-sdk/react/textarea"

import type { Reply } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Button } from "./kit/button.tsx"
import { Hand } from "./marks.tsx"
import { answer, detachReply, useReplying } from "./replying.ts"

const Quote = ({ text }: { text: string }) => (
  <span className="line-clamp-2 min-w-0 flex-1 border-l-2 border-ink3 pl-2 whitespace-pre-wrap">
    {text}
  </span>
)

const Ask = ({ id, title }: { id: string; title: string | undefined }) => {
  const { name, space } = useBrain((s) => {
    const item =
      s.extra.actions.get(id) ?? s.extra.revising.get(id) ?? s.extra.closed.find((c) => c.id === id)
    return {
      name: item?.title ?? title ?? "",
      space: item ? (s.spaces.get(item.space)?.name ?? "Home") : "",
    }
  })
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Hand size={12} />
      <span className="trim min-w-0 truncate text-ink">{name}</span>
      <span className="trim flex-none text-ink3">{space}</span>
    </span>
  )
}

/** The user's reply to one of them, kept with it as it's typed. */
const Answer = ({ space, at, reply }: { space: SpaceId; at: number; reply: string }) => {
  const form = useForm({ defaultValues: { reply } })
  return (
    <form.Field name="reply">
      {(field) => (
        <Textarea
          data-answer
          autoResize
          rows={1}
          name={field.name}
          value={field.state.value}
          onValueChange={(value) => {
            field.handleChange(value)
            answer(space, at, value)
          }}
          onBlur={field.handleBlur}
          submitShortcut="enter"
          onSubmit={() => {
            document
              .querySelector<HTMLTextAreaElement>(`[data-chat="${space}"] [data-box]`)
              ?.form?.requestSubmit()
          }}
          placeholder="Reply…"
          aria-label="Reply"
          className="max-h-40 min-h-key w-full resize-none border-0 bg-transparent py-[1px] text-read text-ink outline-none select-text"
        />
      )}
    </form.Field>
  )
}

const Pair = ({ space, at, reply }: { space: SpaceId; at: number; reply: Reply }) => (
  <div className="flex min-w-0 items-start gap-2 pr-1 pl-3 line-2-b">
    <label className="flex min-w-0 flex-1 cursor-text flex-col gap-1 pt-1.5 pb-1">
      <span className="flex min-h-line min-w-0 items-center text-small text-ink2">
        {reply.kind === "quote" ? (
          <Quote text={reply.text} />
        ) : (
          <Ask id={reply.id} title={reply.title} />
        )}
      </span>
      <span className="pl-2.5">
        <Answer space={space} at={at} reply={reply.reply ?? ""} />
      </span>
    </label>
    <Button
      look="flat"
      aria-label="Remove"
      className="mt-1.5"
      onClick={() => {
        detachReply(space, at)
      }}
    >
      ✕
    </Button>
  </div>
)

export const ReplyRows = ({ space }: { space: SpaceId }) => {
  const replies = useReplying(space)
  return replies.map((r, i) => (
    <Pair
      key={r.kind === "quote" ? `q:${r.seq}:${r.text}` : `a:${r.id}`}
      space={space}
      at={i}
      reply={r}
    />
  ))
}
