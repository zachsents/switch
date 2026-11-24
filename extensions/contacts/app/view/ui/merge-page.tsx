// People picked to merge: the one to keep, then Merge folds the others into them. Undo splits
// them again.
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { pretty } from "../../../src/text.ts"
import { useSeen } from "../bridge.ts"
import { mergeMutation } from "../mutations.ts"
import { peopleQuery } from "../queries.ts"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

export const MergePage = ({
  picked,
  onDone,
  onCancel,
}: {
  picked: readonly string[]
  onDone: (into: string) => void
  onCancel: () => void
}) => {
  const { data: people = [] } = useQuery(peopleQuery)
  const merge = useMutation(mergeMutation)
  const chosen = picked.flatMap((id) => people.filter((p) => p.id === id))
  // The one with the most known about them, unless the user picks another.
  const most = chosen.toSorted((a, b) => b.fields.length - a.fields.length)[0]?.id ?? null
  const [keep, setKeep] = useState<string | null>(null)
  const into = keep !== null && picked.includes(keep) ? keep : most
  useSeen("contacts/merge", undefined)
  return (
    <article className="min-h-full bg-paper">
      <Section
        label="Merge"
        count={chosen.length}
        action={
          <>
            <Key
              go
              disabled={into === null || chosen.length < 2 || merge.isPending}
              onClick={() => {
                if (into !== null) {
                  merge.mutate(
                    { into, from: picked.filter((id) => id !== into) },
                    {
                      onSuccess: () => {
                        onDone(into)
                      },
                    },
                  )
                }
              }}
            >
              Merge
            </Key>
            <Key onClick={onCancel}>Cancel</Key>
          </>
        }
      >
        {chosen.map((p) => (
          <li key={p.id} className="hairline-b last:after:hidden">
            <button
              type="button"
              onClick={() => {
                setKeep(p.id)
              }}
              className={`flex min-h-line w-full items-center gap-3 px-inset py-2 text-left outline-none hover:bg-wash focus-visible:bg-selection ${into === p.id ? "bg-selection" : "bg-transparent"}`}
            >
              <span
                className={`size-3 flex-none rounded-full border-2 ${into === p.id ? "border-ink bg-ink" : "border-ink3"}`}
              />
              <span className="w-[200px] flex-none truncate text-ui font-medium text-ink">
                {p.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-small text-ink2">
                {p.fields
                  .filter((f) => f.kind !== "name")
                  .map((f) => pretty(f))
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
        {merge.error !== null && (
          <li className="flex h-line items-center gap-2.5 px-inset text-small text-ink">
            <Stop size={12} />
            {merge.error.message}
          </li>
        )}
      </Section>
    </article>
  )
}
