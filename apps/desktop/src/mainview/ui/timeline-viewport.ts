// From T3 Code apps/web/src/components/chat/timelineViewport.ts (with timelineScrollTarget.ts and MessagesTimeline.logic.ts's resolveTimelineIsAtEnd).
// The chat column's scroll node turned into one navigation signal, and the follow mode it drives.

/** How near the end, px, counts as at it: following comes back there. */
const FOLLOW_REARM_PX = 40

/** Whether the list is at its end, by its own measures; null before it has any. */
export const resolveTimelineIsAtEnd = (
  state:
    | {
        readonly contentLength?: number
        readonly scroll?: number
        readonly scrollLength?: number
        readonly isAtEnd: boolean
      }
    | undefined,
) => {
  if (!state) {
    return null
  }
  const { contentLength, scroll, scrollLength } = state
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd
  }
  return contentLength - scroll - scrollLength <= FOLLOW_REARM_PX
}

/** Whether a wheel or key on `target` moves the timeline, not a scroller inside it. */
const isTimelineScrollTarget = (
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
  wheel?: Pick<WheelEvent, "deltaX" | "shiftKey">,
) => {
  if (!(target instanceof Element) || !timeline.contains(target) || deltaY === 0) {
    return false
  }
  // Shift-wheel scrolls sideways; trackpads can add vertical noise to a horizontal swipe.
  if (wheel?.shiftKey === true || Math.abs(wheel?.deltaX ?? 0) > Math.abs(deltaY)) {
    return false
  }
  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") {
      continue
    }
    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight
    if (
      canScroll ||
      style.overscrollBehaviorY === "contain" ||
      style.overscrollBehaviorY === "none"
    ) {
      return false
    }
  }
  return true
}

export type TimelineScrollDirection = "up" | "down"

/**
 * One user attempt to move the timeline. Gestures come from the viewport's own listeners;
 * "command" is a UI action about to move it (a line brought into view, Latest).
 */
export type TimelineNavigation =
  | { readonly source: "wheel"; readonly direction: TimelineScrollDirection }
  | { readonly source: "touch" }
  | { readonly source: "pointer"; readonly onScrollbar: boolean }
  | { readonly source: "key"; readonly key: string; readonly direction: TimelineScrollDirection }
  | { readonly source: "command"; readonly releasesFollow: boolean }

export interface TimelineViewport {
  readonly scrollNode: HTMLElement
  /** Every consumer hears the same navigation, in subscription order. */
  readonly subscribe: (listener: (navigation: TimelineNavigation) => void) => () => void
  readonly navigate: (options: { readonly releasesFollow: boolean }) => void
  /** Follow announces letting go, so the list can remember it is reading history. */
  readonly followReleased: () => void
  readonly onFollowReleased: (listener: () => void) => () => void
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"])
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "])
// Wide enough for an overlay scrollbar, which takes no layout space.
const SCROLLBAR_HIT_PX = 16
const EDITABLE = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",")
const FLOATING = '[role="dialog"][aria-modal="true"]'

const pathHas = (event: Event, selector: string) =>
  event
    .composedPath()
    .some((target) => target instanceof Element && target.closest(selector) !== null)

/**
 * Owns the timeline scroll node's input listeners for as long as the node is mounted, and turns
 * them into one navigation signal.
 */
export const attachTimelineViewport = (
  scrollNode: HTMLElement,
): TimelineViewport & { readonly dispose: () => void } => {
  const listeners = new Set<(navigation: TimelineNavigation) => void>()
  const followReleasedListeners = new Set<() => void>()
  const emit = (navigation: TimelineNavigation) => {
    for (const listener of listeners) {
      listener(navigation)
    }
  }
  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY, event)) {
      return
    }
    emit({ source: "wheel", direction: event.deltaY < 0 ? "up" : "down" })
  }
  const handleTouchMove = () => {
    emit({ source: "touch" })
  }
  // Scrollbar drags produce no wheel or touch events; only a press at the trailing edge counts.
  const handlePointerDown = (event: PointerEvent) => {
    emit({
      source: "pointer",
      onScrollbar:
        scrollNode.getBoundingClientRect().right - event.clientX <=
        Math.max(SCROLLBAR_HIT_PX, scrollNode.offsetWidth - scrollNode.clientWidth),
    })
  }
  // Clicking message text can leave focus on body, and keyboard scrolling bypasses wheel and
  // pointer events, so scroll keys are heard window-wide.
  const handleKeyDown = (event: KeyboardEvent) => {
    let direction: TimelineScrollDirection | null = null
    if (UP_KEYS.has(event.key)) {
      direction = "up"
    } else if (DOWN_KEYS.has(event.key)) {
      direction = "down"
    }
    if (
      direction === null ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      (!scrollNode.contains(event.target) &&
        event.target !== document.body &&
        event.target !== document.documentElement) ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      pathHas(event, EDITABLE) ||
      document.querySelector(FLOATING) ||
      (scrollNode.contains(event.target) &&
        !isTimelineScrollTarget(event.target, scrollNode, direction === "up" ? -1 : 1))
    ) {
      return
    }
    emit({ source: "key", key: event.key, direction })
  }
  scrollNode.addEventListener("wheel", handleWheel, { passive: true })
  scrollNode.addEventListener("touchmove", handleTouchMove, { passive: true })
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true })
  window.addEventListener("keydown", handleKeyDown)
  return {
    scrollNode,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    navigate: ({ releasesFollow }) => {
      emit({ source: "command", releasesFollow })
    },
    followReleased: () => {
      for (const listener of followReleasedListeners) {
        listener()
      }
    },
    onFollowReleased: (listener) => {
      followReleasedListeners.add(listener)
      return () => {
        followReleasedListeners.delete(listener)
      }
    },
    dispose: () => {
      listeners.clear()
      followReleasedListeners.clear()
      scrollNode.removeEventListener("wheel", handleWheel)
      scrollNode.removeEventListener("touchmove", handleTouchMove)
      scrollNode.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    },
  }
}

/**
 * Whether a navigation can carry the viewport away from the live edge. A spurious release while
 * pinned never re-arms, so streaming stops following. Downward input counts only outside the end
 * band: streaming growth makes isAtEnd flicker false for a frame, and a gesture then must not
 * release follow.
 */
export const navigationReleasesFollow = (
  navigation: TimelineNavigation,
  viewport: { readonly contentScrollsUp: () => boolean; readonly awayFromEnd: () => boolean },
) => {
  switch (navigation.source) {
    case "wheel": {
      return navigation.direction === "up" && viewport.contentScrollsUp()
    }
    case "key": {
      return navigation.direction === "up" ? viewport.contentScrollsUp() : viewport.awayFromEnd()
    }
    case "pointer": {
      return navigation.onScrollbar ? viewport.contentScrollsUp() : viewport.awayFromEnd()
    }
    case "touch": {
      // Touch direction is not observable; an upward flick leaves the end band within its first
      // few events.
      return viewport.awayFromEnd()
    }
    case "command": {
      return navigation.releasesFollow
    }
    default: {
      navigation satisfies never
      return false
    }
  }
}

/** Whether the timeline keeps the live end in view. `atEnd` only matters once released. */
export type TimelineFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean }

export type TimelineFollowEvent =
  | { readonly type: "navigated" }
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" }

export const FOLLOWING: TimelineFollow = { mode: "following" }

export const initialTimelineFollow = (followEnd: boolean): TimelineFollow =>
  followEnd ? FOLLOWING : { mode: "released", atEnd: false }

export const transitionTimelineFollow = (
  state: TimelineFollow,
  event: TimelineFollowEvent,
): TimelineFollow => {
  switch (event.type) {
    case "navigated": {
      return state.mode === "released" ? state : { mode: "released", atEnd: true }
    }
    case "followEnd": {
      return FOLLOWING
    }
    case "reachedEnd": {
      // Navigating away while still at the end stays released until the list reports leaving and
      // returning, so a scroll key at the end cannot re-arm.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state
    }
    case "leftEnd": {
      // While following, the list leaves the end band for a frame on every streamed chunk before
      // the follow scroll catches up.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state
    }
    default: {
      event satisfies never
      return state
    }
  }
}
