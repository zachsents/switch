// One choice of a short list (Base UI's Select): its words and a ⌃⌄, bare like a flat key and lit
// under the pointer; its list floats at once under it, grouped under small headings, the chosen one
// checked. A chosen option in a group reads with its group after it ("opus Claude"). A long list
// is a Pick (pick.tsx), the same with Find.
import { Select as Base } from "@base-ui/react/select"

import { FLOAT } from "./float.ts"

export interface Option {
  readonly value: string
  readonly label: string
  /** Its heading in the list. */
  readonly group?: string
  readonly disabled?: boolean
}

export const TRIGGER =
  "inline-flex h-key max-w-full min-w-0 items-center gap-1.5 rounded-key px-1.5 text-ui text-ink outline-none select-none hover:lit focus-visible:focused disabled:pointer-events-none disabled:opacity-40 data-[popup-open]:held"

export const Updown = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden className="block flex-none text-ink3">
    <path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" fill="currentColor" />
  </svg>
)

export const Check = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="block">
    <path d="m2.5 8.5 4 4 7-9" fill="none" stroke="currentColor" strokeWidth="1.75" />
  </svg>
)

/** The chosen option on the trigger: its label, its group after it. */
export const Chosen = ({ option, value }: { option: Option | undefined; value: string }) => (
  <>
    <span className="trim min-w-0 truncate">{option?.label ?? value}</span>
    {option?.group !== undefined && (
      <span className="trim flex-none text-ink2">{option.group}</span>
    )}
  </>
)

const Item = ({ option }: { option: Option }) => (
  <Base.Item
    value={option.value}
    label={option.label}
    disabled={option.disabled === true}
    className="flex h-line items-center gap-1.5 pr-inset pl-2 text-ui text-ink outline-none select-none data-disabled:opacity-40 data-highlighted:lit"
  >
    <span className="flex w-3 flex-none justify-center">
      <Base.ItemIndicator>
        <Check />
      </Base.ItemIndicator>
    </span>
    <Base.ItemText className="trim min-w-0 truncate">{option.label}</Base.ItemText>
  </Base.Item>
)

export const Select = ({
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
  const groups = [...new Set(options.flatMap((o) => (o.group === undefined ? [] : [o.group])))]
  return (
    <Base.Root
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        // Base UI tells of the checked one picked again too; that's no change.
        if (next !== null && next !== value) {
          onChange(next)
        }
      }}
    >
      <Base.Trigger aria-label={label} className={TRIGGER}>
        <Chosen option={options.find((o) => o.value === value)} value={value} />
        <Updown />
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner
          alignItemWithTrigger={false}
          align="start"
          sideOffset={4}
          className="outline-none"
        >
          <Base.Popup className={`${FLOAT} min-w-[var(--anchor-width)]`}>
            <Base.List className="max-h-[min(360px,var(--available-height))] overflow-y-auto overscroll-contain py-1">
              {options
                .filter((o) => o.group === undefined)
                .map((o) => (
                  <Item key={o.value} option={o} />
                ))}
              {groups.map((group) => (
                <Base.Group key={group}>
                  <Base.GroupLabel className="flex h-line items-center px-inset text-caption font-semibold text-ink3">
                    <span className="trim">{group}</span>
                  </Base.GroupLabel>
                  {options
                    .filter((o) => o.group === group)
                    .map((o) => (
                      <Item key={o.value} option={o} />
                    ))}
                </Base.Group>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
