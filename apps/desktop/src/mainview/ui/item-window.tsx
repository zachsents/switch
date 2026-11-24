// An ask in a window of its own, as old Switchboard's ask window: the band to drag it by, with where
// it's from, then the card. The window fits the card's height. Opened on an open ask, it closes itself
// once the ask closes (answered here or anywhere); opened on a closed one, it shows it read-only, as
// it was decided. Esc and ⌘W close it too. Until this window's brain has the ask, it shows what the
// main window handed it.
import { useEffect } from "react"

import { HOME } from "@switch/brain/commands"

import type { ItemWindow as Target } from "../../shared/commands.ts"
import { useBrain } from "../brain/use-brain.ts"
import { AskCard } from "./ask-card.tsx"
import { placeOf, readHeld } from "./item-held.ts"
import { DRAG } from "./kit/window.ts"
import { Ring } from "./marks.tsx"
import { useNow } from "./use-now.ts"
import { usePainted } from "./use-painted.ts"
import { closeWindow, rpc } from "./use-menu.ts"

export const ItemWindow = ({ target }: { target: Target }) => {
  const now = useNow()
  const held = readHeld(target.held)
  // Opened on a closed ask: it stays, read-only.
  const decided = held !== undefined && held.item.status !== "open"
  const { item, gone, place } = useBrain((s) => {
    const it = s.extra.actions.get(target.id)
    // Until this window's brain has caught up to the ask, it shows what it was handed.
    if (!it && held && !(s.ready && s.seq >= held.item.at)) {
      return { ...held, gone: false }
    }
    const shown = it ?? (decided ? s.extra.closed.find((c) => c.id === target.id) : undefined)
    return { item: shown, gone: s.ready && !shown, place: placeOf(s, shown?.space ?? HOME) }
  })
  usePainted(item !== undefined)
  useEffect(() => {
    if (gone) {
      closeWindow()
    }
  }, [gone])
  useEffect(() => {
    document.title = item?.title ?? "Ask"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeWindow()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
    }
  }, [item?.title])
  return (
    <div className="flex h-full flex-col">
      <header
        className={`${DRAG} flex h-band flex-none items-center gap-1.5 bg-bg pr-3 pl-[72px] line-1-b`}
      >
        {item && (
          <>
            <Ring
              code={place.code}
              ink={place.home ? "var(--color-ink)" : place.ink}
              size={18}
              fill="var(--color-bg)"
              type="var(--color-ink)"
              home={place.home}
            />
            <span
              className="sign truncate text-name"
              style={{ color: place.home ? "var(--color-ink)" : place.ink }}
            >
              {place.name}
            </span>
          </>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="px-4"
          ref={(el) => {
            // The window takes the card's height: the band, the card, nothing under it. Not while
            // a video plays full screen: the page is in WebKit's window then (frame.ts).
            const fit = () => {
              if (el && el.offsetHeight > 0 && document.fullscreenElement === null) {
                rpc?.send.fit({ height: el.offsetHeight + 30 })
              }
            }
            const observer = new ResizeObserver(fit)
            if (el) {
              // Now, as well: a window not yet on screen lays out but doesn't observe, and it comes
              // on screen at its height.
              fit()
              observer.observe(el)
            }
            return () => {
              observer.disconnect()
            }
          }}
        >
          {item && <AskCard item={item} now={now} own />}
        </div>
      </main>
    </div>
  )
}
