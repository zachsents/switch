// One choice of a few, side by side (Base UI's ToggleGroup): equal heights, one line-1 around them,
// line-2 between; the chosen one is pressed in. Choosing never moves anything: every segment keeps
// its width and weight whichever is chosen.
import { Toggle } from "@base-ui/react/toggle"
import { ToggleGroup } from "@base-ui/react/toggle-group"

export interface Option {
  readonly value: string
  readonly label: string
}

export const Segmented = ({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly Option[]
  value: string
  onChange: (value: string) => void
}) => (
  <ToggleGroup
    aria-label={label}
    value={[value]}
    onValueChange={(next) => {
      const [picked] = next
      if (typeof picked === "string") {
        onChange(picked)
      }
    }}
    className="inline-flex h-key overflow-hidden rounded-key border border-line-1"
  >
    {options.map((o, i) => (
      <Toggle
        key={o.value}
        value={o.value}
        className={`flex h-full items-center px-2.5 text-small font-medium text-ink2 outline-none select-none hover:lit focus-visible:focused data-[pressed]:held data-[pressed]:text-ink ${i > 0 ? "border-l border-line-1" : ""}`}
      >
        <span className="trim">{o.label}</span>
      </Toggle>
    ))}
  </ToggleGroup>
)
