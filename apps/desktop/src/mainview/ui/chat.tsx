// What's said in a chat, as iMessage: a bubble each, the user's on the right in their ink and the
// agent's on the left in gray, the last of a run with its tail; and a space's chat line with what
// it bears on. The column is scroll.tsx; the box is box.tsx; the run and the times over lines are
// space-chat.tsx's.
import type { SpaceId, ThreadId } from "@switch/brain"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import type { ReactNode, RefObject } from "react"

import type { ChatLine } from "../brain/derive.ts"
import { retryMutation } from "../brain/mutations.ts"
import { restore } from "../brain/outbox.ts"
import type { Part, Reply } from "../brain/store.ts"
import type { Reaction, Reactions } from "@switch/brain/commands"
import { useBrain } from "../brain/use-brain.ts"
import { ChatWidget } from "../widgets/chat-widget.tsx"
import { Attached, Sending } from "./attached.tsx"
import { Button } from "./kit/button.tsx"
import { station } from "./look.ts"
import { Markdown } from "./markdown.tsx"
import { NotDelivered, Ring, Stop } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { QuietLine } from "./quiet-line.tsx"
import { SaidBar, Tapbacks } from "./said-bar.tsx"
import { PartMarks, ReplyInsets } from "./said-replies.tsx"
import { Badges } from "./tapback.tsx"
import { dayOf, timeOf } from "./time.ts"
import { useNow } from "./use-now.ts"
import { useBubble } from "./use-bubble.ts"
import { rpc } from "./use-menu.ts"

/** The tail, on a bubble's bottom corner: it fills the corner and curls out past the edge. */
const Tail = ({ right, ink }: { right: boolean; ink: string | undefined }) => (
  <svg
    width="24"
    height="18"
    viewBox="0 0 24 18"
    aria-hidden
    className={`absolute bottom-0 -z-10 ${right ? "-right-1.5" : "-left-1.5 -scale-x-100"} ${ink === undefined ? "text-bubble" : ""}`}
    style={ink === undefined ? undefined : { color: ink }}
  >
    <path
      d="M18 0C18 9 19 14 24 18C19 18.5 15 17.5 12 15.5C10 17 6 18 0 18L0 0Z"
      fill="currentColor"
    />
  </svg>
)

/** The agent at work on its answer, as iMessage's typing bubble: three dots, lit in turn. */
export const Typing = () => (
  <div className="flex min-w-0 flex-col pt-3">
    <output
      aria-label="Typing"
      className="relative isolate flex items-center gap-1 self-start rounded-bubble bg-bubble px-3.5 py-3"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-2 rounded-full bg-ink3 animate-[typing_1.2s_steps(1)_infinite]"
          style={{ animationDelay: `${i * 0.4}s` }}
        />
      ))}
      <Tail right={false} ink={undefined} />
    </output>
  </div>
)

/** Whether an element's words run past its clamp. */
const useClamped = () => {
  const [clamped, setClamped] = useState(false)
  const observe = (el: HTMLElement) => {
    const seen = new ResizeObserver(() => {
      setClamped(el.scrollHeight > el.clientHeight + 1)
    })
    seen.observe(el)
    return () => {
      seen.disconnect()
    }
  }
  const ref = (el: HTMLElement | null) => (el ? observe(el) : undefined)
  return { clamped, ref }
}

/** A line whole: its words, then its detail when it has one. */
const wholeOf = (text: string, detail: string | undefined) =>
  detail === undefined || detail === "" ? text : `${text}\n\n${detail}`

/** The whole of a long line: in a window of its own, else here. */
const useReading = (title: string) => {
  const [whole, setWhole] = useState(false)
  const read = (text: string) => {
    if (rpc) {
      rpc.send.read({ title, text })
    } else {
      setWhole(true)
    }
  }
  return { whole, read }
}

interface SaidProps {
  who: "user" | "agent"
  ink: string
  children: string
  /** A reply's longer version, opened from More. */
  detail?: string | undefined
  dim?: boolean
  streaming?: boolean
  /** When it was said, with its seq once it's in the log: the bar beside it under the pointer. */
  time?: number | undefined
  seq?: number | undefined
  /** The last of its run: it has the tail. */
  tail?: boolean
  reactions?: Reactions | undefined
  title?: string
  /** What it replies to, inset at its top; `here` is the chat it's in. */
  replyTo?: readonly Reply[] | undefined
  here?: SpaceId | undefined
  /** Reactions to words of it. */
  parts?: readonly Part[] | undefined
  /** The display name of the model that wrote it, beside its time. */
  model?: string | undefined
}

/** The user's words: plain, clamped to a few lines; a click reads them whole. */
const UserWords = ({ text, title }: { text: string; title: string }) => {
  const { clamped, ref } = useClamped()
  const { whole, read } = useReading(title)
  const words = (
    <div
      ref={ref}
      data-words
      className={`wrap-anywhere whitespace-pre-wrap ${whole ? "" : "line-clamp-6"}`}
    >
      {text}
    </div>
  )
  return clamped && !whole ? (
    <Button
      look="bare"
      onClick={() => {
        read(text)
      }}
      className="block cursor-pointer text-left select-text"
    >
      {words}
    </Button>
  ) : (
    words
  )
}

/** The agent's words as Markdown: its detail, or past a screen's worth, opens from More. */
const AgentWords = ({
  text,
  detail,
  streaming,
  title,
}: {
  text: string
  detail: string | undefined
  streaming: boolean
  title: string
}) => {
  const { clamped, ref } = useClamped()
  const { whole, read } = useReading(title)
  const more = detail !== undefined && detail !== ""
  const shown = whole ? wholeOf(text, detail) : text
  return (
    <>
      <div ref={ref} data-words className={whole || streaming ? "" : "line-clamp-24"}>
        <Markdown streaming={streaming}>{shown}</Markdown>
      </div>
      {(more ?? clamped) && !whole && (
        <Button
          look="flat"
          onClick={() => {
            read(wholeOf(text, detail))
          }}
          className="mt-0.5 -ml-1.5 text-ink"
        >
          More
        </Button>
      )}
    </>
  )
}

/** The bar beside a bubble shows under the pointer. */
const BAR_AT_REST = "invisible group-focus-within/said:visible group-hover/said:visible"

/** Beside a bubble: its time and Copy under the pointer, and its tapbacks once it's in the log. */
const Beside = ({
  time,
  model,
  text,
  right,
  seq,
  mine,
  bubble,
  reacting,
  onReacting,
}: {
  time: number | undefined
  model: string | undefined
  text: string
  right: boolean
  seq: number | undefined
  mine: Reaction | undefined
  bubble: RefObject<HTMLDivElement | null>
  reacting: boolean
  onReacting: (open: boolean) => void
}) => (
  <>
    {time !== undefined && (
      <SaidBar time={time} model={model} text={text} right={right} className={BAR_AT_REST} />
    )}
    {seq !== undefined && (
      <Tapbacks seq={seq} mine={mine} bubble={bubble} open={reacting} onOpenChange={onReacting} />
    )}
  </>
)

/** A bubble's words, with what they reply to over them and the reactions on them. */
const Inside = ({
  replyTo,
  here,
  parts,
  right,
  ink,
  hasWords,
  children,
}: {
  replyTo: readonly Reply[] | undefined
  here: SpaceId | undefined
  parts: readonly Part[] | undefined
  right: boolean
  ink: string
  /** It has general words of its own, apart from replies under what it replies to. */
  hasWords: boolean
  children: ReactNode
}) => (
  <>
    {replyTo && here !== undefined && (
      <ReplyInsets replies={replyTo} right={right} here={here} words={hasWords} />
    )}
    {hasWords && children}
    {parts && <PartMarks parts={parts} right={right} ink={ink} />}
  </>
)

/** One said thing, as iMessage's: over its words the I-beam, off them the arrow (use-bubble.ts
 * says what a press does where). A found line is only brought into view, never marked. */
export const Said = ({
  who,
  ink,
  children,
  detail,
  dim = false,
  streaming = false,
  time,
  seq,
  tail = true,
  reactions,
  title = "",
  replyTo,
  here,
  parts,
  model,
}: SaidProps) => {
  const right = who === "user"
  const { bubble, ref, reacting, setReacting } = useBubble(seq)
  const reacted = (reactions?.user ?? reactions?.agent) !== undefined
  const words = right ? (
    <UserWords text={children} title={title} />
  ) : (
    <AgentWords text={children} detail={detail} streaming={streaming} title={title} />
  )
  // Three quarters of the column, less the room its time, model and buttons take beside it.
  return (
    <div
      className={`group/said relative flex ${model === undefined ? "max-w-[min(75%,calc(100%-7.5rem))]" : "max-w-[min(75%,calc(100%-12rem))]"} min-w-0 flex-col ${right ? "items-end self-end" : "items-start self-start"} ${reacted ? "mt-3.5" : ""}`}
    >
      <div
        ref={ref}
        data-seq={seq}
        className={`relative isolate max-w-full min-w-0 cursor-auto rounded-bubble px-3 py-1.5 text-read select-text ${right ? "text-white" : "bg-bubble text-ink"} ${dim ? "opacity-60" : ""}`}
        style={right ? { background: ink } : undefined}
      >
        <Inside
          replyTo={replyTo}
          here={here}
          parts={parts}
          right={right}
          ink={ink}
          hasWords={children !== ""}
        >
          {words}
        </Inside>
        {tail && <Tail right={right} ink={right ? ink : undefined} />}
        {reactions && reacted && <Badges reactions={reactions} right={right} ink={ink} />}
      </div>
      <Beside
        time={time}
        model={model}
        text={wholeOf(children, detail)}
        right={right}
        seq={seq}
        mine={reactions?.user}
        bubble={bubble}
        reacting={reacting}
        onReacting={setReacting}
      />
    </div>
  )
}

/** The other spaces a line bears on, each a link. */
const Mentioned = ({ ids, right }: { ids: readonly SpaceId[]; right: boolean }) => {
  const spaces = useBrain((s) =>
    ids.map((id) => ({ id, ...station(s, id), name: s.spaces.get(id)?.name })),
  )
  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-small text-ink2 ${right ? "self-end" : "self-start"}`}
    >
      {spaces.map((st) => (
        <Button
          key={st.id}
          look="flat"
          onClick={() => {
            openSpace(st.id)
          }}
          className="-mx-1 px-1!"
        >
          <Ring code={st.code} ink={st.ink} size={14} home={st.id === "home"} />
          <span className="trim">{st.name}</span>
        </Button>
      ))}
    </div>
  )
}

/** How a line sits under the one before: in its run, apart, or after a gap with the time over it. */
export type Lead =
  | { readonly kind: "run" }
  | { readonly kind: "apart" }
  | { readonly kind: "gap"; readonly time: number }

/** The time over a line after a gap: "Today 9:12 PM", "Friday, Nov 20 9:12 PM". */
const GapTime = ({ time }: { time: number }) => {
  const today = dayOf(useNow()) === dayOf(time)
  return (
    <div className="pt-4 pb-2 text-center text-caption font-medium text-ink2 tabular-nums">
      {today ? "Today" : dayOf(time)} {timeOf(time)}
    </div>
  )
}

/** One line of a space's chat, in the user's ink for the space (`mine`). */
interface LineProps {
  line: ChatLine
  mine: string
  here: SpaceId
  title: string
  lead: Lead
  /** The last of its run. */
  tail: boolean
  /** The chat thread whose turn answering this line failed: Not Delivered under it. */
  undelivered?: ThreadId | null
}

/** The space over a line, by its lead: a gap's is its time's. */
const ABOVE: Record<Lead["kind"], string> = { run: "pt-0.5", apart: "pt-3", gap: "" }

export const LineView = (props: LineProps) => (
  <div data-key={props.line.key} className={`flex min-w-0 flex-col ${ABOVE[props.lead.kind]}`}>
    {props.lead.kind === "gap" && <GapTime time={props.lead.time} />}
    <SaidLine {...props} />
  </div>
)

/** iMessage's Not Delivered under the user's message; a click runs the failed turn again. */
const NotDeliveredRow = ({ thread }: { thread: ThreadId }) => {
  const retry = useMutation(retryMutation)
  return (
    <Button
      look="flat"
      disabled={retry.isPending}
      onClick={() => {
        retry.mutate({ thread })
      }}
      className="mt-1 gap-1.5 self-end text-small text-red"
    >
      <span className="trim">Not Delivered</span>
      <NotDelivered size={14} />
    </Button>
  )
}

const SaidLine = ({ line, mine, here, title, tail, undelivered }: LineProps) => (
  <>
    {line.quiet && <QuietLine quiet={line.quiet} line={line} />}
    {!line.quiet && line.widget && <ChatWidget shown={line.widget.shown} seq={line.widget.seq} />}
    {!line.quiet && !line.widget && (line.text !== "" || line.replyTo !== undefined) && (
      <Said
        who={line.who}
        ink={mine}
        dim={line.pending !== undefined}
        title={title}
        tail={tail}
        detail={line.detail}
        reactions={line.reactions}
        seq={line.seq}
        replyTo={line.replyTo}
        here={here}
        parts={line.parts}
        model={line.model}
        {...(line.time !== undefined && { time: line.time })}
      >
        {line.text}
      </Said>
    )}
    {line.edited === true && !line.quiet && (
      <div className="mt-1 self-start px-1 text-small text-ink2">Edited</div>
    )}
    {line.attachments && (
      <Attached files={line.attachments} right={line.who === "user"} under={line.text !== ""} />
    )}
    {line.pending && line.pending.files.length > 0 && <Sending names={line.pending.files} />}
    {line.pending?.failed === true && (
      // Its words and files back in the box, to change and send again.
      <Button
        look="bare"
        onClick={() => {
          const p = line.pending
          if (p) {
            restore(p.id, `space:${p.space}`)
          }
        }}
        className="mt-1 flex items-center gap-1.5 self-end text-small text-red"
      >
        <Stop size={12} />
        Not sent
      </Button>
    )}
    {undelivered && <NotDeliveredRow thread={undelivered} />}
    {line.also.length > 0 && <Mentioned ids={line.also} right={line.who === "user"} />}
  </>
)
