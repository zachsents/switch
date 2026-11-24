// A space inside, as the rail's line for it: its ring, its name, its live marks, on old
// Switchboard's line (ui/places.rs `render_folded_line`: 36 high, words 14 in).
import * as derive from "../brain/derive.ts"
import type { SpaceRow } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { station } from "./look.ts"
import { Hand, Ring, Runner, Unread } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { Row } from "./parts.tsx"
import { onSpaceMenu } from "./spaces.ts"

export const SpaceLine = ({ space }: { space: SpaceRow }) => {
  const { st, m } = useBrain((s) => ({
    st: station(s, space.id),
    m: derive.marks(s, space.id),
  }))
  return (
    <Row
      className="h-work! gap-[9px]! px-[14px]!"
      onClick={() => {
        openSpace(space.id)
      }}
      onContextMenu={onSpaceMenu(space.id)}
    >
      <Ring code={st.code} ink={st.ink} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="trim min-w-0 truncate font-medium">{space.name}</span>
        {m.unread && <Unread />}
      </span>
      {m.running && <Runner />}
      {m.needs > 0 && (
        <span className="flex flex-none items-center gap-1">
          <Hand />
          <span className="trim text-caption tabular-nums text-ink2">{m.needs}</span>
        </span>
      )}
    </Row>
  )
}
