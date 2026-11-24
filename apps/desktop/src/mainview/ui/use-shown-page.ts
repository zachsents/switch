// The space's page on screen. A page opened for the first time shows once its chat has laid out:
// its list draws nothing until it has measured its rows (LegendList), which a hidden <Activity>
// never lets it do, so until then the page before stays on screen and the move lands in one frame.
// Measured on the mini: shown at once, a first open blanked the chat for two frames.
import type { SpaceId } from "@switch/brain"
import { useEffect, useState } from "react"

import type { Page } from "./nav.ts"

/** The longest a first open waits for its chat, ms: an empty one never says it's laid out. */
const MOST_MS = 150

export const useShownPage = (page: Page, space: SpaceId) => {
  /** Spaces whose chat has laid out: they open in the frame they're asked for. */
  const [laid, setLaid] = useState<ReadonlySet<SpaceId>>(() => new Set([space]))
  const [shown, setShown] = useState(space)
  const want = page.kind === "space" ? space : shown
  if (want !== shown && laid.has(want)) {
    setShown(want)
  }
  const arriving = want !== shown && !laid.has(want) ? want : null
  const laidOut = (id: SpaceId) => {
    setLaid((had) => (had.has(id) ? had : new Set([...had, id])))
  }
  useEffect(() => {
    if (arriving === null) {
      return () => null
    }
    const waited = setTimeout(() => {
      setLaid((had) => new Set([...had, arriving]))
    }, MOST_MS)
    return () => {
      clearTimeout(waited)
    }
  }, [arriving])
  return { shown, arriving, laidOut }
}
