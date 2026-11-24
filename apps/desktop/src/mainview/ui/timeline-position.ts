// From T3 Code apps/web/src/components/chat/useTimelinePositionRestore.ts (with timelineScrollAnchoring.ts's remembered positions).
// Where each conversation was left, and the scrolls that put a list back there or at its end.
import type { LegendListRef } from "@legendapp/list/react"

import type { TimelineViewport } from "./timeline-viewport.ts"

// A streaming reply moves the end every frame, so the target may never hold still. Past this many
// frames the list's own end maintenance takes over.
const SETTLE_MAX_FRAMES = 60
const REMEMBERED_MAX = 100

export interface RememberedTimelinePosition {
  readonly rowId: string
  readonly offsetWithinRow: number
  readonly scrollOffset: number
  readonly atEnd: boolean
}

/** The next frame, once it's drawn. */
const nextFrame = async () => {
  const { promise, resolve } = Promise.withResolvers<number>()
  requestAnimationFrame(resolve)
  return await promise
}

const remembered = new Map<string, RememberedTimelinePosition>()

export const readTimelinePosition = (conversation: string) => remembered.get(conversation)

export const rememberTimelinePosition = (
  conversation: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
) => {
  remembered.delete(conversation)
  remembered.set(conversation, { ...position, atEnd: liveFollowEnabled || position.atEnd })
  if (remembered.size > REMEMBERED_MAX) {
    const oldest = remembered.keys().next().value
    if (oldest !== undefined) {
      remembered.delete(oldest)
    }
  }
}

/**
 * Index and end scrolling start from estimated row sizes, so they can stop short of a tall row.
 * Corrects against the DOM until the viewport holds the target for two layout frames, the frame
 * budget runs out, the caller cancels, or the target disappears.
 */
export const settleListScroll = async (
  list: Pick<LegendListRef, "getScrollableNode" | "scrollToOffset">,
  target: (element: HTMLElement) => number | null,
  isCancelled: () => boolean,
  frames = 1,
  stableFrames = 0,
): Promise<void> => {
  if (frames > SETTLE_MAX_FRAMES || stableFrames >= 2) {
    return
  }
  await nextFrame()
  const element = list.getScrollableNode()
  const offset = element && !isCancelled() ? target(element) : null
  if (!element || offset === null) {
    return
  }
  if (Math.abs(element.scrollTop - offset) > 1) {
    await list.scrollToOffset({ offset, animated: false })
    await settleListScroll(list, target, isCancelled, frames + 1, 0)
    return
  }
  await settleListScroll(list, target, isCancelled, frames + 1, stableFrames + 1)
}

export const measuredEndOffset = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight

/**
 * Scrolls a list opened away from its end back to where the user left it. Any navigation on the
 * viewport cancels it where it is. Returns the cancel.
 */
export const startTimelinePositionRestore = ({
  list,
  viewport,
  position,
}: {
  readonly list: LegendListRef
  readonly viewport: TimelineViewport
  readonly position: RememberedTimelinePosition
}) => {
  let cancelled = false
  const index = list.getState().indexByKey(position.rowId) ?? -1
  // Reading history: follow lets go before the restore claims the viewport.
  viewport.navigate({ releasesFollow: true })
  const stop = () => {
    cancelled = true
    unsubscribe()
  }
  const unsubscribe = viewport.subscribe(() => {
    if (cancelled) {
      return
    }
    stop()
    void list.scrollToOffset({ offset: viewport.scrollNode.scrollTop, animated: false })
  })
  const restore = async () => {
    if (index < 0) {
      await list.scrollToOffset({ offset: position.scrollOffset, animated: false })
      return
    }
    await list.scrollToIndex({
      index,
      animated: false,
      viewPosition: 0,
      viewOffset: -position.offsetWithinRow,
    })
    if (cancelled) {
      return
    }
    // Keep the saved row where it was until its measured position and the DOM agree.
    await settleListScroll(
      list,
      (element) => {
        const state = list.getState()
        const rowIndex = state.indexByKey(position.rowId)
        const row: unknown = rowIndex === undefined ? null : state.elementAtIndex(rowIndex)
        if (!(row instanceof HTMLElement)) {
          return null
        }
        return Math.max(
          0,
          Math.min(
            element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              position.offsetWithinRow,
            measuredEndOffset(element),
          ),
        )
      },
      () => cancelled,
    )
    if (!cancelled) {
      stop()
    }
  }
  void restore()
  return stop
}
