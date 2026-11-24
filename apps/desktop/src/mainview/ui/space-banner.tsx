// A space inside, as a banner row: a little taller than a plain one, its cover behind it, and on
// black plates over the cover (as a tile's were) its ring and name at the left and its live marks at
// the right, so they read on any cover. The row opens the space; a right-click its menu.
import { coreUrl } from "../brain/auth.ts"
import * as derive from "../brain/derive.ts"
import type { SpaceRow } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Button } from "./kit/button.tsx"
import { station } from "./look.ts"
import { Hand, Ring, Runner } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { onSpaceMenu } from "./spaces.ts"

export const SpaceBanner = ({ space }: { space: SpaceRow }) => {
  const { st, m } = useBrain((s) => ({
    st: station(s, space.id),
    m: derive.marks(s, space.id),
  }))
  return (
    <li className="min-w-0 line-2-t">
      <Button
        look="row"
        aria-label={space.name}
        onClick={() => {
          openSpace(space.id)
        }}
        onContextMenu={onSpaceMenu(space.id)}
        className="h-[48px]! items-stretch! p-0! hover:bg-transparent!"
      >
        <span className="relative flex size-full items-center justify-between overflow-hidden">
          {space.cover !== undefined && (
            <img
              src={coreUrl(`/blobs/${space.cover}`)}
              alt=""
              decoding="sync"
              className="absolute inset-0 block size-full bg-bg object-cover"
            />
          )}
          <span className="relative flex min-w-0 items-center gap-2 rounded-r-[6px] bg-black py-1.5 pr-2.5 pl-[14px] text-white">
            <Ring code={st.code} ink={st.ink} fill="var(--color-black)" type="var(--color-white)" />
            <span className="sign min-w-0 truncate text-name">{space.name}</span>
            {m.unread && (
              <span aria-hidden className="block size-[7px] flex-none rounded-full bg-white" />
            )}
          </span>
          {(m.running || m.needs > 0) && (
            <span className="relative mr-[8px] flex flex-none items-center gap-[10px] rounded-[6px] bg-black px-[8px] py-[5px] text-white">
              {m.running && <Runner paper="var(--color-black)" />}
              {m.needs > 0 && (
                <span className="flex items-center gap-[4px]">
                  <Hand />
                  <span className="text-small leading-[18px] tabular-nums">{m.needs}</span>
                </span>
              )}
            </span>
          )}
        </span>
      </Button>
    </li>
  )
}
