// Running: work under way in the space itself, not in the spaces inside, a line each, and
// extensions' long jobs. Work that stopped short isn't here: its end wakes the work that started it,
// which fixes it or asks (the user, Nov 23: "i wanna be messaged or shown what i'm actually needed
// for as a human being. anything else is just noise").
import type { SpaceId } from "@switch/brain"

import type { Activity } from "../brain/adapter.ts"
import * as derive from "../brain/derive.ts"
import type { Work } from "../brain/derive.ts"
import { useBrain } from "../brain/use-brain.ts"
import { ActivityRow } from "./activity-row.tsx"
import { Rested, Runner } from "./marks.tsx"
import { Quiet } from "./parts.tsx"
import { RailSection } from "./rail-section.tsx"
import { WorkRow } from "./work-row.tsx"

type Live =
  | { readonly kind: "work"; readonly w: Work }
  | { readonly kind: "activity"; readonly a: Activity }

const LiveRow = ({ x, now }: { x: Live; now: number }) => {
  if (x.kind === "work") {
    return <WorkRow w={x.w} now={now} />
  }
  return <ActivityRow a={x.a} now={now} />
}

const keyOf = (x: Live) => (x.kind === "activity" ? x.a.id : x.w.thread.id)

export const RunningSection = ({ id, now }: { id: SpaceId; now: number }) => {
  const all = useBrain((s): Live[] => [
    ...derive.work(s, id).map((w) => ({ kind: "work" as const, w })),
    ...derive.activities(s, id).map((a) => ({ kind: "activity" as const, a })),
  ])
  const count = all.length
  return (
    <RailSection mark={count > 0 ? <Runner /> : <Rested />} label="Running" count={count}>
      {all.map((x) => (
        <LiveRow key={keyOf(x)} x={x} now={now} />
      ))}
      {all.length === 0 && <Quiet />}
    </RailSection>
  )
}
