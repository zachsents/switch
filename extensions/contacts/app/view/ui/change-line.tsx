// One batch of changes: when, why, what it did, and its undo. An undone one is struck through.
import { useMutation } from "@tanstack/react-query"

import { day } from "../../../src/text.ts"
import { undoMutation } from "../mutations.ts"
import { Cells, sourceName } from "./cells.tsx"
import { Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

export interface Batch {
  readonly batch: string
  readonly reason: string
  readonly at: number
  readonly undone: boolean
  /** What it did, in a few words. */
  readonly did?: string
}

/** Today's as its time, earlier ones as their day. */
const when = (ms: number) => {
  const zone = Temporal.Now.timeZoneId()
  const at = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
  if (at.toPlainDate().equals(Temporal.Now.plainDateISO(zone))) {
    return at.toPlainTime().toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })
  }
  return day(ms)
}

/** A batch's reason with a book's name as people write it: "import apple" as "Import Apple". */
const reasonOf = (reason: string) => {
  if (reason.startsWith("undo ")) {
    return "Undo"
  }
  const words = reason.split(" ").map((w) => sourceName(w))
  const [first = ""] = words
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ")
}

export const ChangeLine = ({ change }: { change: Batch }) => {
  const undo = useMutation(undoMutation)
  return (
    <Cells
      label={<span className="font-mono text-data">{when(change.at)}</span>}
      struck={change.undone}
      end={
        change.undone ? undefined : (
          <Key
            disabled={undo.isPending}
            onClick={() => {
              undo.mutate(change.batch)
            }}
          >
            Undo
          </Key>
        )
      }
    >
      {reasonOf(change.reason)}
      {change.did !== undefined && change.did !== "" && (
        <span className="ml-2 font-mono text-data text-ink3">{change.did}</span>
      )}
      {undo.error !== null && (
        <span className="ml-2 inline-flex items-center gap-1.5 text-small text-ink">
          <Stop size={12} />
          {undo.error.message}
        </span>
      )}
    </Cells>
  )
}
