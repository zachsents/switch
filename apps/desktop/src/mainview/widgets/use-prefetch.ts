// Every placed widget's surface, fetched once its extension offers it, so a space opens with its
// widgets already drawn on the first frame, not empty, then filled.
import { useEffect } from "react"

import { forgetKeptFrames } from "./feed.tsx"
import { memoriesQuery } from "../brain/system.ts"
import { useNeeds } from "../ui/connections.ts"
import { useBrain } from "../brain/use-brain.ts"
import { queryClient } from "../query.ts"
import { keyOf, surfaceQuery, useOffered } from "./host.ts"

export const usePrefetch = () => {
  // The settings pages' data, so each opens drawn, never filled in after.
  useNeeds()
  useEffect(() => {
    queryClient.query(memoriesQuery).catch(() => null)
    forgetKeptFrames()
  }, [])
  const offered = useOffered()
  const placed = useBrain((s) =>
    s.extra.widgets
      .map((w) => keyOf(w))
      .toSorted()
      .join(" "),
  )
  const ready = [...offered.keys()].toSorted().join(" ")
  useEffect(() => {
    const here = new Set(ready.split(" "))
    for (const key of placed.split(" ")) {
      const [app = "", name = ""] = key.split("/")
      if (here.has(key)) {
        queryClient.query(surfaceQuery({ app, name })).catch(() => null)
      }
    }
  }, [placed, ready])
}
