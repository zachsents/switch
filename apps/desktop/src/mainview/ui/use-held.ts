// What the user did with an item, held a few seconds for Undo before it goes. Leaving the card
// sends it at once; Undo drops it. It's kept in the outbox from the click, so the app going in
// between (an update relaunching it, its window closing) can't lose it: another window or the
// next start sends it.
import { useMutation } from "@tanstack/react-query"
import { useEffect, useEffectEvent, useRef, useState } from "react"

import { commandOf, doneMutation } from "../brain/item-mutations.ts"
import type { Done } from "../brain/item-mutations.ts"
import * as outbox from "../brain/outbox.ts"

const HOLD_MS = 5000

export const useHeld = () => {
  const done = useMutation(doneMutation)
  const [held, setHeld] = useState<{
    readonly id: string
    readonly done: Done
    readonly label: string
  } | null>(null)
  const undoing = useRef(false)
  const send = useEffectEvent((id: string, d: Done) => {
    done.mutate(
      { id, done: d },
      {
        // Not a command the brain would take: nothing to send again.
        onError: () => {
          outbox.drop(id)
        },
      },
    )
  })
  useEffect(() => {
    undoing.current = false
    if (held === null) {
      return () => {
        undoing.current = false
      }
    }
    let sent = false
    const go = () => {
      if (!sent) {
        sent = true
        send(held.id, held.done)
      }
    }
    const timer = setTimeout(go, HOLD_MS)
    return () => {
      clearTimeout(timer)
      if (!undoing.current) {
        go()
      }
    }
  }, [held])
  return {
    /** What's held, until it fails and the keys come back. */
    held: done.isError ? null : held,
    /** It went: too late for Undo here. */
    sent: done.isPending || done.isSuccess,
    error: done.isError ? done.error.message : null,
    hold: (d: Done, label: string) => {
      done.reset()
      const id = crypto.randomUUID()
      outbox.keep({ id, ...commandOf(d), due: Date.now() + HOLD_MS })
      setHeld({ id, done: d, label })
    },
    undo: () => {
      undoing.current = true
      if (held) {
        outbox.drop(held.id)
      }
      setHeld(null)
    },
  }
}
