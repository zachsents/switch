// Every kind of record in Switchboard's log, counted with its date range, beside what it becomes.
import { Effect } from "effect"

import { groupOf, ruleOf, whyOf } from "./rules.ts"
import { num, str, Switchboard } from "./source.ts"

export interface Line {
  readonly group: string
  readonly kind: string
  readonly n: number
  readonly first: number
  readonly last: number
  readonly as: string
  readonly why: string
}

const PAGE = 50_000

export const inventory = Effect.gen(function* counting() {
  const sb = yield* Switchboard
  const head = yield* sb.head
  const lines = new Map<string, Line>()
  const pages: number[] = []
  for (let lo = 0; lo < head; lo += PAGE) {
    pages.push(lo)
  }
  yield* Effect.forEach(
    pages,
    (lo) =>
      Effect.map(
        sb.query(
          `records | where seq > ${lo} and seq <= ${lo + PAGE} | summarize n = count(), a = min(at), b = max(at) by stream, kind`,
        ),
        (rows) => {
          for (const r of rows) {
            const stream = str(r.stream)
            const kind = str(r.kind)
            const group = groupOf(stream)
            const key = `${group} ${kind}`
            const rule = ruleOf(stream, kind)
            const had = lines.get(key)
            const { route } = rule
            lines.set(key, {
              group,
              kind,
              n: (had?.n ?? 0) + num(r.n),
              first: Math.min(had?.first ?? Infinity, num(r.a)),
              last: Math.max(had?.last ?? 0, num(r.b)),
              as: rule.as,
              why: whyOf(route),
            })
          }
        },
      ),
    { concurrency: 4, discard: true },
  )
  return [...lines.values()].toSorted((a, b) => b.n - a.n)
})

const day = (t: number) =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })

export const table = (lines: readonly Line[]) =>
  [
    "| Switchboard | Kind | Records | From | To | Switch | Why |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
    ...lines.map(
      (l) =>
        `| ${l.group} | ${l.kind} | ${l.n} | ${day(l.first)} | ${day(l.last)} | ${l.as} | ${l.why} |`,
    ),
  ].join("\n")
