// The band: one black plate across the top that's also the titlebar, its window buttons centred on
// it. ‹ ›, then the page's line as a subway map: Home's station, the spaces it sits within as
// stations joined by their ink, then the page's own ring and its name in condensed capitals in its
// ink.
import type { SpaceId } from "@switch/brain"
import { Fragment } from "react"
import type { ReactNode } from "react"

import * as derive from "../brain/derive.ts"
import { HOME } from "@switch/brain/commands"
import { useBrain } from "../brain/use-brain.ts"
import { HistoryKeys } from "./history-keys.tsx"
import { Button } from "./kit/button.tsx"
import { DRAG, NO_DRAG } from "./kit/window.ts"
import { station } from "./look.ts"
import { Ring, Stop } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { Tip } from "./parts.tsx"
import { QueryDevtoolsKey } from "./query-devtools.tsx"
import { RenameField } from "./rename-field.tsx"
import { onSpaceMenu, startRename, useRenaming } from "./spaces.ts"

/** A ring on the band, px. */
const RING = 18

/** The line between two stations, in the ink of the one it leads to. */
const Track = ({ ink }: { ink: string }) => (
  <span aria-hidden className="h-0.5 w-2.5 flex-none" style={{ background: ink }} />
)

/** A station above the page: its ring, a click away. */
const Station = ({ id }: { id: SpaceId }) => {
  const { st, name } = useBrain((s) => ({ st: station(s, id), name: s.spaces.get(id)?.name ?? "" }))
  const home = id === HOME
  return (
    <Tip label={home ? "Home ⇧⌘H" : name}>
      <Button
        look="plate"
        aria-label={home ? "Home" : name}
        onClick={() => {
          openSpace(id)
        }}
        onContextMenu={onSpaceMenu(id)}
        className={`${NO_DRAG} px-0.5!`}
      >
        <Ring
          code={st.code}
          ink={home ? "var(--color-ink2)" : st.ink}
          size={RING}
          fill="var(--color-bg)"
          type="var(--color-ink)"
          home={home}
        />
      </Button>
    </Tip>
  )
}

export const Band = ({
  space,
  title: given,
  live,
}: {
  /** The space the page is in. */
  space: SpaceId
  /** The page's own name, when it isn't the space's (a thread's title, a settings page). */
  title?: string | undefined
  live?: ReactNode
}) => {
  // An untitled page (a thread its pre-read gave no title) is its space's.
  const title = given === "" ? undefined : given
  const { way, name, st, down } = useBrain((s) => ({
    way: (title === undefined
      ? derive.above(s, space)
      : [...derive.above(s, space), s.spaces.get(space)].filter((x) => x !== undefined)
    ).map((x) => ({ id: x.id, ink: station(s, x.id).ink })),
    name: s.spaces.get(space)?.name ?? "",
    st: station(s, space),
    down: s.link === "down",
  }))
  const renaming = useRenaming()
  const home = space === HOME
  const ink = home ? "var(--color-ink)" : st.ink
  const own = title ?? (home ? "Home" : name)
  return (
    <header
      className={`${DRAG} flex h-band flex-none items-center gap-0 bg-bg pr-1.5 pl-[72px] text-ink line-1-b`}
    >
      <HistoryKeys />
      {way.map((x, i) => (
        <Fragment key={x.id}>
          {i > 0 && <Track ink={x.ink} />}
          <Station id={x.id} />
        </Fragment>
      ))}
      {title === undefined && (
        <>
          {way.length > 0 && <Track ink={ink} />}
          <span className="flex-none px-0.5">
            <Ring
              code={st.code}
              ink={ink}
              size={RING}
              fill="var(--color-bg)"
              type="var(--color-ink)"
              home={home}
            />
          </span>
        </>
      )}
      {renaming === space && title === undefined ? (
        <RenameField key={space} id={space} name={name} />
      ) : (
        <h1
          className="sign m-0 ml-1.5 min-w-0 truncate text-title"
          style={{ color: title === undefined ? ink : "var(--color-ink)" }}
        >
          {title === undefined ? (
            <Button
              look="bare"
              onDoubleClick={() => {
                startRename(space)
              }}
              onContextMenu={onSpaceMenu(space)}
              className={`${NO_DRAG} sign max-w-full truncate`}
            >
              {own}
            </Button>
          ) : (
            own
          )}
        </h1>
      )}
      {live !== undefined && <span className="ml-2 flex items-center">{live}</span>}
      <span className="ml-auto flex items-center gap-1 pl-3">
        {down && (
          <span className="flex items-center gap-1.5 text-small text-ink">
            <Stop size={12} />
            <span className="trim">Can&apos;t reach the brain</span>
          </span>
        )}
        {import.meta.env.DEV && <QueryDevtoolsKey />}
      </span>
    </header>
  )
}
