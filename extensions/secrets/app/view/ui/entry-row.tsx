// One line of the audit: when, who, how, which item and field, for what and where; a refusal in red.
import type { Entry } from "../../shared/rpc.ts"
import { when } from "../format.ts"
import { Stop } from "./marks.tsx"

export const EntryRow = ({ entry: e, item }: { entry: Entry; item: boolean }) => (
  <li className="flex min-h-line items-center gap-3 px-inset py-1.5 text-ui hairline-b last:after:hidden">
    <span className="w-[150px] flex-none font-mono text-data text-ink3">{when(e.at)}</span>
    <span className="w-[140px] flex-none truncate text-ink2">{e.who}</span>
    <span className="flex w-[80px] flex-none items-center gap-1.5 text-ink">
      {!e.ok && <Stop size={12} />}
      {e.use}
    </span>
    {item && (
      <span className="w-[160px] flex-none truncate font-mono text-small">{e.name || e.item}</span>
    )}
    <span className="w-[100px] flex-none truncate font-mono text-small text-ink2">{e.field}</span>
    <span className="selectable min-w-0 flex-1 truncate text-small text-ink2">
      {[e.space, e.target, e.why, e.ok ? "" : e.reason].filter(Boolean).join(" · ")}
    </span>
  </li>
)
