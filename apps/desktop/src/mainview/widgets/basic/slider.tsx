// A2UI's Slider as a field's line (the house's fields): its label in ink2, the track as old Switchboard
// drew one (track.tsx), and its value as figures at the line's end, as old Switchboard's showed it
// (whole with `steps` or when whole, else to a tenth); a line-2 under it. `steps` snaps it to that
// many divisions, as in A2UI's own, else to whole numbers, as a range input's are. Moving it writes
// to the data model; what its checks find wrong shows under it.
import { createComponentImplementation } from "@a2ui/react"
import { SliderApi } from "@a2ui/web_core/v1_0"

import { Data } from "../../ui/parts.tsx"
import { share } from "./flex.ts"
import { useHeld } from "./held.ts"
import { Problems } from "./problems.tsx"
import { Track } from "./track.tsx"
import { wordsOf } from "./words.ts"

/** Its value within its range, the least when it has none, as old Switchboard's read it. */
const within = (value: unknown, min: number, max: number) =>
  typeof value === "number" ? Math.min(max, Math.max(min, value)) : min

export const Slider = createComponentImplementation(SliderApi, ({ props }) => {
  const min = props.min ?? 0
  const max = Math.max(min, props.max)
  const [value, set] = useHeld(within(props.value, min, max), props.setValue)
  const label = wordsOf(props.label)
  const divisions =
    props.steps !== undefined && props.steps > 0 && max > min ? props.steps : undefined
  return (
    <div className="flex flex-col line-2-b" style={share(props.weight)}>
      <div className="flex h-line items-center gap-2.5 px-inset text-ui">
        {label && <span className="trim flex-none text-ink2">{label}</span>}
        <Track
          label={label || "Value"}
          value={value}
          min={min}
          max={max}
          step={divisions === undefined ? 1 : (max - min) / divisions}
          onChange={set}
        />
        <Data>
          {value.toLocaleString(undefined, {
            maximumFractionDigits: divisions !== undefined || Number.isInteger(value) ? 0 : 1,
          })}
        </Data>
      </div>
      <Problems errors={props.validationErrors} />
    </div>
  )
})
