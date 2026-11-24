// A extension's long job on Running: its title, its line, when it ends, and how far along it is as a
// bar along the row's foot.

import type { Activity } from "../brain/adapter.ts"
import { Hand, Runner, Stop } from "./marks.tsx"
import { openSpace } from "./nav.ts"
import { Data, Row } from "./parts.tsx"
import { spanOf } from "./time.ts"

/** Its live mark: needs the user, failed, or running. */
const StateMark = ({ state }: { state: Activity["state"] }) => {
  if (state === "needs") {
    return <Hand />
  }
  return state === "failed" ? <Stop /> : <Runner />
}

export const ActivityRow = ({ a, now }: { a: Activity; now: number }) => (
  <Row
    className="h-work! gap-[9px]! px-[14px]!"
    onClick={() => {
      openSpace(a.space)
    }}
  >
    <StateMark state={a.state} />
    <span className="trim min-w-0 flex-1 truncate font-medium">{a.title}</span>
    {a.line !== "" && (
      <span className="trim max-w-[40%] flex-none truncate text-small text-ink2">{a.line}</span>
    )}
    {a.endsAt !== undefined && a.endsAt > now && <Data>{spanOf(a.endsAt - now, "minute")}</Data>}
    {a.endsAt === undefined && a.progress !== undefined && (
      <Data>{Math.round(a.progress * 100)}%</Data>
    )}
    {a.progress !== undefined && (
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-orange"
        style={{ width: `${Math.min(1, Math.max(0, a.progress)) * 100}%` }}
      />
    )}
  </Row>
)
