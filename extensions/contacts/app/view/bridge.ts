// The bun process, over Electrobun's RPC: commands from the menu bar and the agent come in, what
// the user saw goes out as UI events, and the agent can ask what's shown. Outside Electrobun (a
// browser) there's no bun process, and shortcuts answer instead.
import { Electroview } from "electrobun/view"
import { useEffect, useEffectEvent } from "react"

import type { AppRPC, Command, Seen, Shown } from "../shared/commands.ts"

const listeners = new Set<(c: Command) => void>()
let shownNow: () => Shown = () => ({
  page: "people",
  person: null,
  query: "",
  listed: 0,
  picked: [],
})

const rpc =
  "__electrobun" in window
    ? Electroview.defineRPC<AppRPC>({
        maxRequestTime: 5000,
        handlers: {
          requests: { shown: () => shownNow() },
          messages: {
            command: (c) => {
              for (const l of listeners) {
                l(c)
              }
            },
          },
        },
      })
    : undefined

if (rpc) {
  void new Electroview({ rpc })
}

/** Runs what the menu bar or the agent asks, and answers what's shown. */
export const useBridge = (run: (c: Command) => void, shown: () => Shown) => {
  const chosen = useEffectEvent(run)
  const answer = useEffectEvent(shown)
  useEffect(() => {
    const l = (c: Command) => {
      chosen(c)
    }
    listeners.add(l)
    shownNow = () => answer()
    return () => {
      listeners.delete(l)
    }
  }, [])
}

/** Tells Switch the user is looking at `item` on `surface`, and how long they stayed. */
export const useSeen = (surface: string, item: string | undefined) => {
  useEffect(() => {
    const at = performance.now()
    const where: Seen = item === undefined ? { surface } : { surface, item }
    rpc?.send.seen(where)
    return () => {
      rpc?.send.left({ ...where, ms: Math.round(performance.now() - at) })
    }
  }, [surface, item])
}
