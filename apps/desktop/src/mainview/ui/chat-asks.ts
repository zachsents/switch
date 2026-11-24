// A space's chat with its asks in it, each where it was raised (by time): open, its card; answered,
// its one line. An ask raised before the history held so far sits at its top. An ask's entry is
// keyed by when it was raised, which is what Needs you brings into view.
import type { ChatLine } from "../brain/derive.ts"
import type { ActionItem } from "../brain/items.ts"

export type Entry =
  | { readonly kind: "line"; readonly key: string; readonly seq?: number; readonly line: ChatLine }
  | {
      readonly kind: "ask"
      readonly key: string
      readonly seq: number
      readonly item: ActionItem
      readonly open: boolean
    }

export const withAsks = (
  lines: readonly ChatLine[],
  open: readonly ActionItem[],
  closed: readonly ActionItem[],
): Entry[] => {
  const asks: Entry[] = [
    ...open.map((item) => ({
      kind: "ask" as const,
      key: `ask:${item.id}`,
      seq: item.at,
      item,
      open: true,
    })),
    ...closed.map((item) => ({
      kind: "ask" as const,
      key: `ask:${item.id}`,
      seq: item.at,
      item,
      open: false,
    })),
  ].toSorted((a, b) => a.seq - b.seq)
  const out: Entry[] = []
  let next = 0
  for (const line of lines) {
    // An ask's `at` is when it was raised: it goes before the first line said after it.
    while (next < asks.length && line.time !== undefined && (asks[next]?.seq ?? 0) < line.time) {
      const ask = asks[next]
      if (ask) {
        out.push(ask)
      }
      next += 1
    }
    out.push(
      line.seq === undefined
        ? { kind: "line", key: line.key, line }
        : { kind: "line", key: line.key, seq: line.seq, line },
    )
  }
  // Those raised after the last line said, or with no history yet.
  for (const ask of asks.slice(next)) {
    out.push(ask)
  }
  return out
}
