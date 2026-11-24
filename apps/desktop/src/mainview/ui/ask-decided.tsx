// A closed ask's card, read-only, in place of what the user can do: each draft as it went (his edit
// included), then the option picked or the words typed.
import type { ActionItem } from "../brain/items.ts"
import { shownText } from "../brain/items.ts"

export const AskDecided = ({ item }: { item: ActionItem }) => {
  const a = item.answer
  const words = a?.choice ?? a?.text
  return (
    <div className="flex flex-col gap-3">
      {(item.drafts ?? []).map((d) => (
        <div
          key={d.name}
          className="flex flex-col overflow-hidden rounded-[8px] border border-line-2 bg-bg"
        >
          <span className="flex h-8 items-center px-3.5 text-small text-ink2 line-2-b">
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
          </span>
          <p className="selectable px-3.5 py-2 text-read whitespace-pre-wrap text-ink">
            {a?.drafts?.[d.name] ?? shownText(item, d)}
          </p>
        </div>
      ))}
      {words !== undefined && (
        <p className="selectable text-read whitespace-pre-wrap text-ink">{words}</p>
      )}
    </div>
  )
}
