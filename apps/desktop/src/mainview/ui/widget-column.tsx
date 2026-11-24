// A space's widgets, right of its chat: those placed in it that their extension offers, in their
// order, each the column's width and its own height. The column scrolls as a whole; nothing in it
// scrolls inside itself. With nothing in it to show, it's out of the page (index.css).
import type { SpaceId } from "@switch/brain"

import * as derive from "../brain/derive.ts"
import { useBrain } from "../brain/use-brain.ts"
import { keyOf, useOffered } from "../widgets/host.ts"
import { Boundary } from "./boundary.tsx"
import { PaneScroll } from "./pane-scroll.tsx"
import { WidgetCell } from "./widget-cell.tsx"

export const WidgetColumn = ({ space }: { space: SpaceId }) => {
  const offered = useOffered()
  const shown = useBrain((s) => derive.widgets(s, space)).filter((w) => offered.has(keyOf(w)))
  return (
    shown.length > 0 && (
      <div data-widgets className="flex w-widgets flex-none flex-col line-1-l">
        <PaneScroll label="Widgets">
          <div data-scroll-context className="flex flex-col">
            {shown.map((w) => (
              <Boundary key={keyOf(w)}>
                <WidgetCell app={w.app} name={w.name} />
              </Boundary>
            ))}
          </div>
        </PaneScroll>
      </div>
    )
  )
}
