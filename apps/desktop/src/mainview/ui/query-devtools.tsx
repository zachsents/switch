// TanStack Query's devtools, in a dev build only: a key at the band's end opens its panel along the
// window's foot. Nothing floats over the page while it's shut, at any width.
import { lazy, Suspense, useSyncExternalStore } from "react"

import { Button } from "./kit/button.tsx"
import { NO_DRAG } from "./kit/window.ts"

const Panel = lazy(async () => {
  const { ReactQueryDevtoolsPanel } = await import("@tanstack/react-query-devtools")
  return { default: ReactQueryDevtoolsPanel }
})

let open = false
const listeners = new Set<() => void>()

const setOpen = (next: boolean) => {
  open = next
  for (const l of listeners) {
    l()
  }
}

const useOpen = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => open,
  )

/** The band's key: opens or shuts the panel. */
export const QueryDevtoolsKey = () => {
  const on = useOpen()
  return (
    <Button
      look="plate"
      aria-pressed={on}
      onClick={() => {
        setOpen(!on)
      }}
      className={NO_DRAG}
    >
      Query
    </Button>
  )
}

/** The panel along the window's foot, while it's open. */
export const QueryDevtoolsPanel = () => {
  const on = useOpen()
  if (!on) {
    return null
  }
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 h-[40vh] line-1-t">
      <Suspense>
        <Panel
          style={{ height: "100%" }}
          onClose={() => {
            setOpen(false)
          }}
        />
      </Suspense>
    </div>
  )
}
