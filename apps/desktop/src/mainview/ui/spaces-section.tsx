// The rail's Spaces: the spaces inside, warmest first, as banner rows or plain ones as the space is
// set to list them (space-view.ts). Past the first few the rest fold behind one line, as old
// Switchboard's (ui/home.rs `more_row`: 32 high), that opens them all.
import type { SpaceId } from "@switch/brain"
import { useState } from "react"

import type { SpaceRow } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Row } from "./parts.tsx"
import { RailSection } from "./rail-section.tsx"
import { SpaceBanner } from "./space-banner.tsx"
import { SpaceLine } from "./space-line.tsx"
import { insideView } from "./space-view.ts"

/** How many show before the rest fold. */
const SHOWN = 9

export const SpacesSection = ({ here, spaces }: { here: SpaceId; spaces: readonly SpaceRow[] }) => {
  const [open, setOpen] = useState(false)
  const view = useBrain((s) => insideView(s, here))
  const folds = spaces.length > SHOWN + 1
  const shown = folds && !open ? spaces.slice(0, SHOWN) : spaces
  return (
    <RailSection label="Spaces" count={spaces.length}>
      {shown.map((c) =>
        view === "banners" ? (
          <SpaceBanner key={c.id} space={c} />
        ) : (
          <SpaceLine key={c.id} space={c} />
        ),
      )}
      {folds && (
        <Row
          className="h-[32px]! gap-[9px]! px-[14px]!"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <span className="trim text-ink2">{open ? "Fewer" : `${spaces.length - SHOWN} more`}</span>
        </Row>
      )}
    </RailSection>
  )
}
