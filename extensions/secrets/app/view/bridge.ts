// The bun process, over Electrobun's RPC: it holds the vault, and the view asks it for everything.
// Commands from the menu bar come in, as does word that something changed.
import { Electroview } from "electrobun/view"
import { useEffect, useEffectEvent } from "react"

import type { AppRPC, Command } from "../shared/rpc.ts"
import { queryClient, SECRETS } from "./query.ts"

const listeners = new Set<(c: Command) => void>()

export const rpc = Electroview.defineRPC<AppRPC>({
  // Long enough for Touch ID, or the Mac's password.
  maxRequestTime: 120_000,
  handlers: {
    requests: {},
    messages: {
      command: (c) => {
        for (const l of listeners) {
          l(c)
        }
      },
      changed: () => {
        void queryClient.invalidateQueries({ queryKey: SECRETS })
      },
    },
  },
})

void new Electroview({ rpc })

/** The bun process's answers to the view's asks. */
export const ask = rpc.request

/** Runs what the menu bar asks. */
export const useBridge = (run: (c: Command) => void) => {
  const chosen = useEffectEvent(run)
  useEffect(() => {
    const l = (c: Command) => {
      chosen(c)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
}
