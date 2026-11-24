// A pane that scrolls, with the Mac's overlay thumb: there only when the pane has more than it
// shows, then shown while it moves or under the pointer, over the content, never taking its width.
// Its viewport is the `data-scroll` a grid measures room in.
import { ScrollArea, ScrollAreaContent, ScrollAreaViewport } from "@ui-sdk/react/scroll-area"
import type { ReactNode } from "react"

import { Scrollbar } from "./scrollbar.tsx"
import { useOverflow } from "./use-overflow.ts"

export const PaneScroll = ({
  label,
  className = "flex-1",
  children,
}: {
  label?: string
  className?: string
  children: ReactNode
}) => {
  const { over, content } = useOverflow()
  return (
    <ScrollArea className={`relative min-h-0 min-w-0 ${className}`}>
      <ScrollAreaViewport data-scroll aria-label={label} className="size-full overflow-y-auto">
        <ScrollAreaContent ref={content}>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <Scrollbar orientation="vertical" over={over.y} className="z-20" />
    </ScrollArea>
  )
}
