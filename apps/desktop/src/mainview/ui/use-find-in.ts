// ⌘F's state for one chat: the words (a TanStack Form field), the brain's matches in the whole
// history, and which is current, counted from the latest. Enter steps back in time, ⇧Enter forward.
import type { SpaceId } from "@switch/brain"
import { useForm, useSelector } from "@tanstack/react-form"
import { useDebouncedValue } from "@tanstack/react-pacer"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { findInQuery } from "../brain/find.ts"
import { findForm } from "../brain/forms.ts"

export const useFindIn = (space: SpaceId) => {
  const form = useForm({ defaultValues: { query: "" }, validators: { onChange: findForm } })
  const query = useSelector(form.store, (f) => f.values.query.trim())
  const [settled] = useDebouncedValue(query, { wait: 120 })
  const found = useQuery(findInQuery(space, settled))
  const seqs = settled === "" ? [] : (found.data ?? [])
  // Kept with the words it was for: new words start again at the latest.
  const [at, setAt] = useState({ query: "", n: 0 })
  const n = at.query === settled && at.n < seqs.length ? at.n : 0
  return {
    form,
    count: seqs.length,
    /** Which match is current, from 1, counting from the latest. */
    current: seqs.length === 0 ? 0 : n + 1,
    seq: seqs.at(-1 - n) ?? null,
    ready: settled === query && !found.isFetching,
    /** One back in time (1) or forward (-1), wrapping. */
    step: (by: 1 | -1) => {
      if (seqs.length > 0) {
        setAt({ query: settled, n: (n + by + seqs.length) % seqs.length })
      }
    },
  }
}

export type FindIn = ReturnType<typeof useFindIn>
