// From T3 Code apps/web/src/components/chat/useTimelineFollow.ts (its follow store, pill and scroll to end; a list here is one conversation for its life, so no visits).
// Keeps a chat following its live end, and lets the user scroll away.
import type { LegendListRef } from "@legendapp/list/react"
import { Debouncer } from "@tanstack/react-pacer"
import { useRef, useSyncExternalStore } from "react"
import type { RefObject } from "react"

import { measuredEndOffset, settleListScroll } from "./timeline-position.ts"
import {
  initialTimelineFollow,
  navigationReleasesFollow,
  resolveTimelineIsAtEnd,
  transitionTimelineFollow,
} from "./timeline-viewport.ts"
import type {
  TimelineFollow,
  TimelineFollowEvent,
  TimelineNavigation,
  TimelineViewport,
} from "./timeline-viewport.ts"

/** Latest waits this long before it shows, ms, so it doesn't flash while the list settles. */
const SHOW_LATEST_MS = 150

/**
 * A conversation's follow mode and whether Latest shows, read by scroll listeners at event time and
 * by render through useSyncExternalStore.
 */
const createTimelineFollowStore = (followEnd: boolean) => {
  let snapshot: { readonly follow: TimelineFollow; readonly latest: boolean } = {
    follow: initialTimelineFollow(followEnd),
    latest: !followEnd,
  }
  const listeners = new Set<() => void>()
  const set = (next: Partial<typeof snapshot>) => {
    const merged = { ...snapshot, ...next }
    if (merged.follow !== snapshot.follow || merged.latest !== snapshot.latest) {
      snapshot = merged
      for (const listener of listeners) {
        listener()
      }
    }
  }
  // Showing Latest waits; hiding it is immediate.
  const showing = new Debouncer(
    () => {
      set({ latest: true })
    },
    { wait: SHOW_LATEST_MS },
  )
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read: () => snapshot,
    dispatch: (event: TimelineFollowEvent) => {
      const before = snapshot.follow
      const after = transitionTimelineFollow(before, event)
      set({ follow: after })
      return { before, after }
    },
    showLatest: () => {
      showing.maybeExecute()
    },
    hideLatest: () => {
      showing.cancel()
      set({ latest: false })
    },
  }
}
type TimelineFollowStore = ReturnType<typeof createTimelineFollowStore>

/** Each conversation's store: one list shows a conversation at a time, and a page opened again
 * picks up where it was. */
const stores = new Map<string, TimelineFollowStore>()
const storeOf = (conversation: string, followEnd: boolean) => {
  const had = stores.get(conversation)
  if (had) {
    return had
  }
  const made = createTimelineFollowStore(followEnd)
  stores.set(conversation, made)
  return made
}

/** Whether the list's rows reach past the viewport, so scrolling up moves it. */
const contentOverflowsViewport = (list: LegendListRef | null) => {
  const node = list?.getScrollableNode()
  return node ? node.scrollHeight > node.clientHeight : false
}

/**
 * Keeps the timeline following the live end and lets the user scroll away. Follow lives in a
 * store the viewport's navigation signal writes, so a scroll gesture re-renders nothing unless the
 * follow mode flips.
 */
export const useTimelineFollow = (
  legendListRef: RefObject<LegendListRef | null>,
  conversation: string,
  followEnd: boolean,
) => {
  const store = storeOf(conversation, followEnd)
  const { follow, latest } = useSyncExternalStore(store.subscribe, store.read)
  const viewportRef = useRef<TimelineViewport | null>(null)

  const releaseFollowForNavigation = () => {
    const { before } = store.dispatch({ type: "navigated" })
    if (before.mode === "following") {
      viewportRef.current?.followReleased()
      legendListRef.current?.cancelScroll()
    }
  }

  const scrollToEnd = (animated = false) => {
    viewportRef.current?.navigate({ releasesFollow: false })
    store.dispatch({ type: "followEnd" })
    store.hideLatest()
    const toEnd = async () => {
      const list = legendListRef.current
      if (!list) {
        return
      }
      await list.scrollToEnd({
        animated: animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      })
      await settleListScroll(
        list,
        measuredEndOffset,
        () => store.read().follow.mode !== "following" || legendListRef.current !== list,
      )
    }
    requestAnimationFrame(() => {
      void toEnd()
    })
  }

  const awayFromEnd = () => resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false
  const handleNavigation = (navigation: TimelineNavigation) => {
    const releases = navigationReleasesFollow(navigation, {
      contentScrollsUp: () => contentOverflowsViewport(legendListRef.current),
      awayFromEnd,
    })
    if (releases) {
      releaseFollowForNavigation()
    }
  }

  /** Attached by the viewport's ref callback, so follow hears it while it exists. */
  const attachTimelineViewport = (viewport: TimelineViewport) => {
    viewportRef.current = viewport
    const unsubscribe = viewport.subscribe(handleNavigation)
    return () => {
      unsubscribe()
      if (viewportRef.current === viewport) {
        viewportRef.current = null
      }
    }
  }

  const onIsAtEndChange = (isAtEnd: boolean) => {
    if (!isAtEnd && store.read().follow.mode === "following") {
      store.hideLatest()
      return
    }
    const { before, after } = store.dispatch({ type: isAtEnd ? "reachedEnd" : "leftEnd" })
    if (after === before) {
      return
    }
    if (after.mode === "following") {
      store.hideLatest()
    } else {
      store.showLatest()
    }
  }

  return {
    showScrollToBottom: latest,
    timelineLiveFollowEnabled: follow.mode === "following",
    scrollToEnd,
    navigate: (releasesFollow: boolean) => {
      viewportRef.current?.navigate({ releasesFollow })
    },
    onIsAtEndChange,
    attachTimelineViewport,
  }
}
