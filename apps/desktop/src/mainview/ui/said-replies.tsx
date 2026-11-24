// What a bubble replies to, inset at its top in order (a click goes to it), each with the user's
// reply to it under it, before the bubble's general words; and the reactions on its words: each
// underlined in its badge's color, the badge at their end.
import type { SpaceId } from "@switch/brain"
import { useState } from "react"

import type { Part, Reply } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Button } from "./kit/button.tsx"
import { Hand } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { Badge } from "./tapback.tsx"
import { openItemWindow } from "./use-menu.ts"

const AskInset = ({ id, title }: { id: string; title: string | undefined }) => {
  const { name, space } = useBrain((s) => {
    const item =
      s.extra.actions.get(id) ?? s.extra.revising.get(id) ?? s.extra.closed.find((c) => c.id === id)
    return {
      name: item?.title ?? title ?? "",
      space: item ? (s.spaces.get(item.space)?.name ?? "") : "",
    }
  })
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Hand size={12} />
      <span className="min-w-0 truncate">{name}</span>
      {space !== "" && <span className="flex-none opacity-70">{space}</span>}
    </span>
  )
}

export const ReplyInsets = ({
  replies,
  right,
  here,
  words,
}: {
  replies: readonly Reply[]
  right: boolean
  here: SpaceId
  /** The bubble has general words after them. */
  words: boolean
}) => (
  <div className={`mt-0.5 flex flex-col gap-1.5 ${words ? "mb-1.5" : ""}`}>
    {replies.map((r) => (
      <div
        key={r.kind === "quote" ? `q:${String(r.seq)}:${r.text}` : `a:${r.id}`}
        className="flex min-w-0 flex-col gap-1"
      >
        <Button
          look="bare"
          onClick={() => {
            if (r.kind === "quote") {
              openSpace(here, r.seq)
            } else {
              openItemWindow(r.id)
            }
          }}
          className={`-mx-1.5 block w-[calc(100%+0.75rem)] cursor-pointer rounded-[10px] px-2 py-1 text-left text-small ${right ? "bg-black/20 text-white/90" : "bg-ink/8 text-ink2"}`}
        >
          {r.kind === "quote" ? (
            <span
              className={`line-clamp-3 border-l-2 pl-2 whitespace-pre-wrap ${right ? "border-white/60" : "border-ink3"}`}
            >
              {r.text}
            </span>
          ) : (
            <AskInset id={r.id} title={r.title} />
          )}
        </Button>
        {(r.reply ?? "").trim() !== "" && (
          <div className="wrap-anywhere whitespace-pre-wrap">{(r.reply ?? "").trim()}</div>
        )}
      </div>
    ))}
  </div>
)

interface Spot {
  readonly x: number
  readonly y: number
  readonly w: number
}

interface Mark {
  readonly part: Part
  readonly lines: readonly Spot[]
  /** Where its words end. */
  readonly end: { readonly x: number; readonly y: number }
}

/** The text nodes holding `text` in `root`, spaces aside (the words may be laid out in blocks). */
const segmentsOf = (root: Element, text: string) => {
  const needle = text.replaceAll(/\s+/gu, "")
  const at: { node: Text; offset: number }[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!(n instanceof Text)) {
      continue
    }
    const node = n
    const s = node.data
    for (let i = 0; i < s.length; i += 1) {
      if (!/\s/u.test(s.charAt(i))) {
        at.push({ node, offset: i })
      }
    }
  }
  const start = at
    .map((c) => c.node.data.charAt(c.offset))
    .join("")
    .indexOf(needle)
  if (needle === "" || start === -1) {
    return []
  }
  const chars = at.slice(start, start + needle.length)
  const out: { node: Text; from: number; to: number }[] = []
  for (const c of chars) {
    const last = out.at(-1)
    if (last?.node === c.node) {
      last.to = c.offset + 1
    } else {
      out.push({ node: c.node, from: c.offset, to: c.offset + 1 })
    }
  }
  return out
}

/** Where each part's words are drawn in the bubble, as far as they show. */
const measure = (bubble: Element, parts: readonly Part[]): Mark[] => {
  const words = bubble.querySelector("[data-words]")
  if (!words) {
    return []
  }
  const box = bubble.getBoundingClientRect()
  const shown = words.getBoundingClientRect()
  return parts.flatMap((part) => {
    const rects = segmentsOf(words, part.text).flatMap((seg) => {
      const range = document.createRange()
      range.setStart(seg.node, seg.from)
      range.setEnd(seg.node, seg.to)
      return [...range.getClientRects()].filter((r) => r.width > 0 && r.bottom <= shown.bottom + 1)
    })
    const last = rects.at(-1)
    return last
      ? [
          {
            part,
            lines: rects.map((r) => ({ x: r.left - box.left, y: r.bottom - box.top, w: r.width })),
            end: { x: last.right - box.left, y: last.top - box.top },
          },
        ]
      : []
  })
}

export const PartMarks = ({
  parts,
  right,
  ink,
}: {
  parts: readonly Part[]
  /** The bubble is the user's. */
  right: boolean
  ink: string
}) => {
  const [drawn, setDrawn] = useState<{ key: string; marks: readonly Mark[] }>({
    key: "",
    marks: [],
  })
  const ref = (el: HTMLSpanElement | null) => {
    const bubble = el?.parentElement ?? null
    const draw = () => {
      if (!bubble) {
        return
      }
      const marks = measure(bubble, parts)
      const key = JSON.stringify(marks)
      setDrawn((had) => (had.key === key ? had : { key, marks }))
    }
    const seen = new ResizeObserver(draw)
    if (bubble) {
      seen.observe(bubble)
    }
    draw()
    return () => {
      seen.disconnect()
    }
  }
  // The user's in their ink (white on their own bubble); the agent's in its gray.
  const colors = right
    ? { user: "white", agent: "var(--color-bubble)" }
    : { user: ink, agent: "var(--color-ink3)" }
  const colorOf = (p: Part) => colors[p.side]
  return (
    <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0">
      {drawn.marks.map((m) => (
        <span key={`${m.part.side}:${m.part.text}`}>
          {m.lines.map((l) => (
            <span
              key={`${String(l.x)}:${String(l.y)}`}
              className="absolute border-t-2"
              style={{ left: l.x, top: l.y - 1, width: l.w, borderColor: colorOf(m.part) }}
            />
          ))}
          <span className="absolute" style={{ left: m.end.x - 4, top: m.end.y - 12 }}>
            <Badge reaction={m.part.reaction} mine={m.part.side === "user"} ink={ink} small />
          </span>
        </span>
      ))}
    </span>
  )
}
