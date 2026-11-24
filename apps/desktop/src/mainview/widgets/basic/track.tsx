// A value along a line, pressed or dragged to (Base UI's Slider), as old Switchboard drew a slider
// (plain's a2ui-gpui): a 3 px track in the line color, filled in ink to the value, under a round
// raised knob.
import { Slider } from "@base-ui/react/slider"

export const Track = ({
  label,
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (value: number) => void
}) => (
  <Slider.Root
    value={value}
    min={min}
    max={max}
    step={step}
    disabled={disabled}
    thumbAlignment="edge"
    onValueChange={(next) => {
      if (typeof next === "number") {
        onChange(next)
      }
    }}
    className="min-w-0 flex-1 data-disabled:opacity-40"
  >
    <Slider.Control className="flex h-line touch-none items-center select-none">
      <Slider.Track className="h-[3px] w-full rounded-full bg-line-1">
        <Slider.Indicator className="rounded-full bg-ink" />
        <Slider.Thumb
          aria-label={label}
          className="size-3.5 rounded-full border border-key-border bg-bg outline-none hover:lit has-[:focus-visible]:focused"
        />
      </Slider.Track>
    </Slider.Control>
  </Slider.Root>
)
