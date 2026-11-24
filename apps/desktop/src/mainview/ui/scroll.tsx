// From T3 Code apps/web/src/components/chat/MessagesTimeline.tsx (its LegendList, position memory and scroll handling) and ChatView.tsx's scroll to end, in Switch's scroll area and look.
// A conversation's column: it opens at its latest, follows new and streaming lines while it's at the
// end and stops once the user scrolls up, shows Latest while it's away, and pages older history in
// at the top without moving.
import { LegendList } from "@legendapp/list/react"
import type { LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react"
import { ScrollArea, ScrollAreaContent, ScrollAreaViewport } from "@ui-sdk/react/scroll-area"
import { useLayoutEffect, useRef, useState } from "react"
import type { Key, ReactNode } from "react"

import { onFollow } from "./follow-end.ts"
import { Button } from "./kit/button.tsx"
import { Scrollbar } from "./scrollbar.tsx"
import {
  readTimelinePosition,
  rememberTimelinePosition,
  startTimelinePositionRestore,
} from "./timeline-position.ts"
import { attachTimelineViewport, resolveTimelineIsAtEnd } from "./timeline-viewport.ts"
import type { TimelineViewport } from "./timeline-viewport.ts"
import { useOverflow } from "./use-overflow.ts"
import { useTimelineFollow } from "./use-timeline-follow.ts"

const MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, footerLayout: true, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions
const MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true }

export const Scroll = <T,>({
  conversation,
  label,
  items,
  keyOf,
  render,
  tail,
  onTop,
  onLaidOut,
  focus,
}: {
  conversation: string
  label: string
  items: readonly T[]
  keyOf: (item: T) => Key
  /** An item, with the space above it: rows sit edge to edge. */
  render: (item: T) => ReactNode
  /** What follows the last item: what's live. */
  tail?: ReactNode
  onTop?: () => void
  /** Its rows have laid out once. */
  onLaidOut?: () => void
  /** An item to bring into view, by key, once it's there. */
  focus?: Key | null
}) => {
  const listRef = useRef<LegendListRef | null>(null)
  const viewportRef = useRef<TimelineViewport | null>(null)
  const remembered = readTimelinePosition(conversation)
  const {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    scrollToEnd,
    navigate,
    onIsAtEndChange,
    attachTimelineViewport: attachFollow,
  } = useTimelineFollow(listRef, conversation, remembered?.atEnd !== false)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const { over, content } = useOverflow()
  const keyExtractor = (item: T) => String(keyOf(item))

  const rememberPosition = () => {
    const list = listRef.current
    const state = list?.getState()
    const element = list?.getScrollableNode()
    const isAtEnd = resolveTimelineIsAtEnd(state)
    if (!state || !element || isAtEnd === null || state.data !== items) {
      return isAtEnd
    }
    const first = items[state.start]
    const row: unknown = state.elementAtIndex(state.start)
    if (first !== undefined && row instanceof HTMLElement) {
      rememberTimelinePosition(
        conversation,
        {
          rowId: keyExtractor(first),
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
        },
        timelineLiveFollowEnabled,
      )
    }
    return isAtEnd
  }

  const handleScroll = () => {
    const isAtEnd = rememberPosition()
    if (isAtEnd !== null) {
      onIsAtEndChange(isAtEnd)
    }
  }

  // A line brought into view (⌘F's match, one opened from ⌘K) leaves the end.
  const focused =
    focus === null || focus === undefined ? -1 : items.findIndex((item) => keyOf(item) === focus)
  useLayoutEffect(() => {
    if (focused !== -1) {
      navigate(true)
      void listRef.current?.scrollToIndex({ index: focused, animated: false, viewPosition: 0.5 })
    }
  }, [focused, navigate])

  return (
    <ScrollArea data-conversation={conversation} className="@container relative min-h-0 flex-1">
      <ScrollAreaViewport
        ref={(el) => {
          setScroller(el)
          if (!el) {
            return () => null
          }
          const viewport = attachTimelineViewport(el)
          viewportRef.current = viewport
          const detach = attachFollow(viewport)
          const unfollow = onFollow(conversation, () => {
            scrollToEnd()
          })
          return () => {
            unfollow()
            detach()
            viewport.dispose()
            if (viewportRef.current === viewport) {
              viewportRef.current = null
            }
          }
        }}
        aria-label={label}
        className="size-full overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
      >
        <ScrollAreaContent ref={content} className="min-w-0 max-w-full">
          {scroller && (
            <LegendList<T>
              ref={(list) => {
                listRef.current = list
                return () => {
                  if (listRef.current === list) {
                    listRef.current = null
                  }
                }
              }}
              scrollElement={scroller}
              data={items}
              keyExtractor={keyExtractor}
              renderItem={({ item }) => (
                <div className="flex w-full min-w-0 max-w-full flex-col">{render(item)}</div>
              )}
              estimatedItemSize={72}
              initialScrollAtEnd={remembered?.atEnd !== false}
              onLoad={() => {
                onLaidOut?.()
                const list = listRef.current
                const viewport = viewportRef.current
                if (remembered?.atEnd === false && list && viewport) {
                  startTimelinePositionRestore({ list, viewport, position: remembered })
                }
              }}
              maintainScrollAtEnd={timelineLiveFollowEnabled && MAINTAIN_SCROLL_AT_END}
              maintainScrollAtEndThreshold={1}
              maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
              onScroll={handleScroll}
              {...(onTop && { onStartReached: onTop, onStartReachedThreshold: 0.5 })}
              className="min-w-0 max-w-full px-3 @3xl:mx-auto @3xl:max-w-column"
              ListHeaderComponent={<div className="h-3" />}
              ListFooterComponent={<div className="flex min-w-0 flex-col pb-3">{tail}</div>}
            />
          )}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <Scrollbar orientation="vertical" over={over.y} />
      {showScrollToBottom && (
        <Button
          look="key"
          aria-label="Jump to latest"
          className="absolute right-4 bottom-3"
          onPointerDown={(event) => {
            event.preventDefault()
          }}
          onClick={() => {
            scrollToEnd()
          }}
        >
          Latest ↓
        </Button>
      )}
    </ScrollArea>
  )
}
