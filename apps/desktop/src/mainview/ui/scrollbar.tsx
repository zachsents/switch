// Every scroll area's bar, the Mac's overlay thumb: there only when its content overflows that way
// by its content's own size (use-overflow.ts) and the area's own measure, then shown while it moves or under the pointer, over the content.
import { ScrollAreaScrollbar, ScrollAreaThumb } from "@ui-sdk/react/scroll-area"

const PLACE = {
  vertical: { bar: "top-0 right-0 bottom-0 w-2.5", shown: "data-overflow-y:flex", thumb: "w-full" },
  horizontal: {
    bar: "right-0 bottom-0 left-0 h-2.5",
    shown: "data-overflow-x:flex",
    thumb: "h-full",
  },
}

export const Scrollbar = ({
  orientation,
  over,
  className = "",
}: {
  orientation: keyof typeof PLACE
  over: boolean
  className?: string
}) => (
  <ScrollAreaScrollbar
    orientation={orientation}
    className={`absolute hidden p-0.5 opacity-0 data-visible:opacity-100 ${PLACE[orientation].bar} ${over ? PLACE[orientation].shown : ""} ${className}`}
  >
    <ScrollAreaThumb className={`rounded-full bg-ink3/50 ${PLACE[orientation].thumb}`} />
  </ScrollAreaScrollbar>
)
