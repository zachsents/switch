// A chart's legend, over it: each series' key and name, in the order they're drawn. Two series or
// more always have one; a single series has none, the widget's heading names it.
import { Key } from "./key.tsx"
import type { KeyKind } from "./key.tsx"

export const Legend = ({
  items,
  kind,
}: {
  items: readonly { readonly name: string; readonly color: string }[]
  kind: KeyKind
}) =>
  items.length < 2 ? null : (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 pb-2">
      {items.map((s) => (
        <li
          key={`${s.name}-${s.color}`}
          className="flex min-w-0 items-center gap-1.5 text-small text-ink2"
        >
          <Key kind={kind} color={s.color} />
          <span className="trim min-w-0 truncate">{s.name}</span>
        </li>
      ))}
    </ul>
  )
