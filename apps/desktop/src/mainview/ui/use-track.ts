// UI analytics: what the user looked at, how long, and where they went next.
import type { BackedOut, Dwelled, Switched, Viewed } from "switch-ext-kit"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useEffectEvent, useRef } from "react"

import { emitMutation } from "../brain/mutations.ts"
import type { Page } from "./nav.ts"

const SURFACE = {
  space: "desktop/space",
  thread: "desktop/thread",
} as const satisfies Record<Page["kind"], string>

/** Quicker than this, leaving is backing out; longer, a dwell. */
const BACKED_OUT_MS = 2000

export const useTrack = (page: Page) => {
  const { mutate } = useMutation(emitMutation)
  const last = useRef<Page | null>(null)
  const opened = useEffectEvent((at: Page) => {
    const where = { surface: SURFACE[at.kind], item: at.id } satisfies typeof Viewed.payload.Type
    const prev = last.current
    if (prev && prev.kind === at.kind && prev.id !== at.id) {
      mutate({
        event: "ui.switched",
        payload: {
          surface: where.surface,
          from: prev.id,
          to: at.id,
        } satisfies typeof Switched.payload.Type,
      })
    }
    mutate({ event: "ui.viewed", payload: where })
    last.current = at
    const since = Date.now()
    return () => {
      const ms = Math.max(0, Date.now() - since)
      mutate(
        ms < BACKED_OUT_MS
          ? {
              event: "ui.backed_out",
              payload: { ...where, ms } satisfies typeof BackedOut.payload.Type,
            }
          : {
              event: "ui.dwelled",
              payload: { ...where, ms } satisfies typeof Dwelled.payload.Type,
            },
      )
    }
  })
  useEffect(() => opened(page), [page])
}
