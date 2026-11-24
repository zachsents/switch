// A space's rail, the same on every page: the spaces inside it, then Needs you and Running, each
// only this space's own rows. Needs you and Running always show, so each is always where it was.
import type { SpaceId } from "@switch/brain"

import * as derive from "../brain/derive.ts"
import { useBrain } from "../brain/use-brain.ts"
import { NeedsYou } from "./needs-you.tsx"
import { RunningSection } from "./running-section.tsx"
import { SpacesSection } from "./spaces-section.tsx"

export const Rail = ({ space, now }: { space: SpaceId; now: number }) => {
  const inside = useBrain((s) => derive.children(s, space))
  return (
    <div data-scroll-context className="flex flex-col [&>*+*]:line-section-t">
      {inside.length > 0 && <SpacesSection here={space} spaces={inside} />}
      <NeedsYou here={space} now={now} />
      <RunningSection id={space} now={now} />
    </div>
  )
}
