// A Select for a long list (Base UI's Combobox, its field in the list, as T3 Code's model picker
// is): the same trigger; its list floats under it with Find on top, typing narrowing it, grouped
// under small headings, the chosen one checked.
import { Combobox } from "@base-ui/react/combobox"

import { FLOAT } from "./float.ts"
import { Check, Chosen, TRIGGER, Updown } from "./select.tsx"
import type { Option } from "./select.tsx"

interface Group {
  readonly value: string
  readonly items: readonly Option[]
}

export const Pick = ({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: readonly Option[]
  onChange: (value: string) => void
  disabled?: boolean
}) => {
  const groups: readonly Group[] = [...new Set(options.map((o) => o.group ?? ""))].map((g) => ({
    value: g,
    items: options.filter((o) => (o.group ?? "") === g),
  }))
  const chosen = options.find((o) => o.value === value)
  return (
    <Combobox.Root
      items={groups}
      value={chosen ?? null}
      disabled={disabled}
      autoHighlight
      itemToStringLabel={(o: Option) => o.label}
      isItemEqualToValue={(a: Option, b: Option) => a.value === b.value}
      onValueChange={(next: Option | null) => {
        // Base UI tells of the checked one picked again too; that's no change.
        if (next && next.value !== value) {
          onChange(next.value)
        }
      }}
    >
      <Combobox.Trigger aria-label={label} className={TRIGGER}>
        <Chosen option={chosen} value={value} />
        <Updown />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="outline-none">
          <Combobox.Popup
            aria-label={label}
            className={`${FLOAT} min-w-[max(var(--anchor-width),240px)]`}
          >
            <div className="flex h-9 items-center px-inset line-2-b">
              <Combobox.Input
                placeholder="Find…"
                aria-label="Find"
                className="w-full border-0 bg-transparent p-0 text-ui text-ink outline-none select-text"
              />
            </div>
            <Combobox.Empty className="flex h-line items-center px-inset text-ui text-ink2 empty:hidden">
              Nothing
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(360px,var(--available-height))] overflow-y-auto overscroll-contain py-1 empty:hidden">
              {(group: Group) => (
                <Combobox.Group key={group.value} items={[...group.items]}>
                  {group.value !== "" && (
                    <Combobox.GroupLabel className="flex h-line items-center px-inset text-caption font-semibold text-ink3">
                      <span className="trim">{group.value}</span>
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(o: Option) => (
                      <Combobox.Item
                        key={o.value}
                        value={o}
                        disabled={o.disabled === true}
                        className="flex h-line items-center gap-1.5 pr-inset pl-2 text-ui text-ink outline-none select-none data-disabled:opacity-40 data-highlighted:lit"
                      >
                        <span className="flex w-3 flex-none justify-center">
                          <Combobox.ItemIndicator>
                            <Check />
                          </Combobox.ItemIndicator>
                        </span>
                        <span className="trim min-w-0 truncate">{o.label}</span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
