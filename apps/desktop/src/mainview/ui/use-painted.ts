// A window of one thing tells the bun process what of it is drawn on screen: its first frames (it's
// see-through until then, and is made seen), and its content (the end of its open's timing).
import { useEffect, useEffectEvent } from "react"

import { rpc } from "./use-menu.ts"

/** Tells, on the frame after the one that drew this window once `when` holds. */
const useAfterDrawn = (when: boolean, tell: () => void) => {
  const told = useEffectEvent(tell)
  useEffect(() => {
    let frame = 0
    if (when) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          told()
        })
      })
    }
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [when])
}

/** The window's first frames are drawn: it's made seen. */
export const useSeen = (drawn: boolean) => {
  useAfterDrawn(drawn, () => {
    rpc?.send.seen()
  })
}

/** Its content is drawn. */
export const usePainted = (ready: boolean) => {
  useAfterDrawn(ready, () => {
    rpc?.send.painted()
  })
}
