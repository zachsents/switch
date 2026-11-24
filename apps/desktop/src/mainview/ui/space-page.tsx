// A space's page under the band, one layout on every space and on Home: its rail (the spaces inside,
// Needs you, Running), its chat, and its widgets right of the chat. Nothing on it is laid out by
// hand. A narrower window folds the widgets away first; a narrow one is one column, the rail over
// the chat.
import type { SpaceId } from "@switch/brain"
import { useSyncExternalStore } from "react"

import { PaneScroll } from "./pane-scroll.tsx"
import { Rail } from "./rail.tsx"
import { SpaceChat } from "./space-chat.tsx"
import { WidgetColumn } from "./widget-column.tsx"

/** Under this window width, px, the widgets fold away. */
const WIDE = 1000
/** Under this window width, px, the page is one column. */
const NARROW = 720

/** The window's width. */
const useWidth = () =>
  useSyncExternalStore(
    (l) => {
      window.addEventListener("resize", l)
      return () => {
        window.removeEventListener("resize", l)
      }
    },
    () => document.documentElement.clientWidth,
  )

export const SpacePage = ({
  space,
  now,
  at,
  searching,
  onSearchEnd,
  onLaidOut,
}: {
  space: SpaceId
  now: number
  /** A chat line to bring into view, by seq. */
  at: number | null
  /** ⌘F's bar is open on its chat. */
  searching: boolean
  onSearchEnd: () => void
  /** Its chat has laid out once. */
  onLaidOut: () => void
}) => {
  const width = useWidth()
  const chat = (
    <SpaceChat
      space={space}
      at={at}
      searching={searching}
      onSearchEnd={onSearchEnd}
      onLaidOut={onLaidOut}
    />
  )
  if (width < NARROW) {
    return (
      <PaneScroll>
        <Rail space={space} now={now} />
        <div className="flex h-[calc(100vh-var(--spacing-band))] flex-col line-1-t">{chat}</div>
      </PaneScroll>
    )
  }
  return (
    <div className="flex min-h-0 flex-1">
      <PaneScroll label="Left sidebar" className="w-rail flex-none line-1-r">
        <Rail space={space} now={now} />
      </PaneScroll>
      <main className="flex min-w-0 flex-1 flex-col">{chat}</main>
      {width >= WIDE && <WidgetColumn space={space} />}
    </div>
  )
}
