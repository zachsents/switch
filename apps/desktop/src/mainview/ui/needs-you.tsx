// Needs you: the space's own open asks, not those of the spaces inside, a row each as old
// Switchboard's (its space's ring, its title, its age). A row opens its ask in a window of its own.
import type { SpaceId } from "@switch/brain"
import { HOME } from "@switch/brain/commands"

import * as derive from "../brain/derive.ts"
import type { ActionItem } from "../brain/items.ts"
import { useBrain } from "../brain/use-brain.ts"
import { station } from "./look.ts"
import { Hand, Ring } from "./marks.tsx"
import { Quiet, Row } from "./parts.tsx"
import { RailSection } from "./rail-section.tsx"
import { ageOf, whenOf } from "./time.ts"
import { openItemWindow } from "./use-menu.ts"

const AskRow = ({ a, now }: { a: ActionItem; now: number }) => {
  const st = useBrain((s) => station(s, a.space))
  return (
    <Row
      className="h-ask! gap-[9px]! px-[14px]!"
      onClick={() => {
        openItemWindow(a.id)
      }}
    >
      <Ring code={st.code} ink={st.ink} home={a.space === HOME} />
      <span className="trim min-w-0 flex-1 truncate font-semibold">{a.title}</span>
      <time
        dateTime={new Date(a.at).toISOString()}
        title={whenOf(a.at)}
        className="trim flex-none text-caption tabular-nums text-ink3"
      >
        {ageOf(now - a.at)}
      </time>
    </Row>
  )
}

export const NeedsYou = ({ here, now }: { here: SpaceId; now: number }) => {
  const asks = useBrain((s) => derive.actions(s, here))
  return (
    <RailSection mark={<Hand />} label="Needs you" count={asks.length}>
      {asks.map((a) => (
        <AskRow key={a.id} a={a} now={now} />
      ))}
      {asks.length === 0 && <Quiet />}
    </RailSection>
  )
}
