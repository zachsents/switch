// An ask's live view (core/portal.ts), as Switchboard's portal on a Mac: the card shows the screen
// live while it's on screen, and a click on it opens the controller over the whole window, where
// clicks, drags, the wheel and typing go to that Mac. Opening it brings the ask's tab to the front
// there. The view is the core's own page (@switch/portal), in a frame; it says when it ends, and the
// controller closes. The card's picture pauses while the controller is open.
import { Dialog } from "@base-ui/react/dialog"
import { useState } from "react"

import { portalUrl } from "../brain/auth.ts"
import type { ActionItem } from "../brain/items.ts"
import { Button } from "./kit/button.tsx"

/** Whether a message from a view's frame is its end, for this item. */
const endOf = (item: string, e: MessageEvent) => {
  const d: unknown = e.data
  return typeof d === "object" && d !== null && "portal" in d && d.portal === item && "ended" in d
}

export const AskPortal = ({ item }: { item: ActionItem }) => {
  const [seen, setSeen] = useState(false)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        look="bare"
        aria-label="Screen"
        className="relative block aspect-video w-full overflow-hidden bg-black"
        onClick={() => {
          setOpen(true)
        }}
        ref={(el: HTMLElement | null) => {
          // It streams only while it's on screen.
          const watcher = new IntersectionObserver(([entry]) => {
            setSeen(entry?.isIntersecting === true)
          })
          if (el) {
            watcher.observe(el)
          }
          return () => {
            watcher.disconnect()
          }
        }}
      >
        {seen && !open && (
          <iframe
            title={item.title}
            src={portalUrl(item.id, true)}
            sandbox="allow-scripts"
            className="pointer-events-none absolute inset-0 size-full border-0"
          />
        )}
      </Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Popup className="fixed inset-0 z-50 flex flex-col bg-black outline-none">
            <div className="flex h-line flex-none items-center gap-2 bg-bg px-3 line-1-b">
              <Dialog.Title className="trim min-w-0 flex-1 truncate text-ui font-medium text-ink">
                {item.title}
              </Dialog.Title>
              <Dialog.Close render={<Button look="flat" />}>Close</Dialog.Close>
            </div>
            <iframe
              title={item.title}
              src={portalUrl(item.id, false)}
              sandbox="allow-scripts"
              className="min-h-0 w-full flex-1 border-0"
              ref={(el) => {
                const ended = (e: MessageEvent) => {
                  if (el && e.source === el.contentWindow && endOf(item.id, e)) {
                    setOpen(false)
                  }
                }
                addEventListener("message", ended)
                el?.addEventListener("load", () => {
                  el.focus()
                })
                return () => {
                  removeEventListener("message", ended)
                }
              }}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
