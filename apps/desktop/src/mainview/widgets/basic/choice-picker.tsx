// A2UI's ChoicePicker. Its label as a field's, in ink2 on a line; when it's `filterable`, a Find line
// under it as the house Pick has (its words narrow the options). The options down, each a line with
// a box to tick when several may be chosen, a round one when one is, as old Switchboard drew them
// (plain's a2ui-gpui), with a line-2 under each as the house Check's; or as chips, keys across that
// wrap, the chosen ones pressed in (DESIGN.md: what's chosen is held). Choosing writes what's chosen
// to the data model, as in A2UI's own.
import { Checkbox } from "@base-ui/react/checkbox"
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { Toggle } from "@base-ui/react/toggle"
import { createComponentImplementation } from "@a2ui/react"
import { ChoicePickerApi } from "@a2ui/web_core/v1_0"
import { useState } from "react"

import { buttonLook } from "../../ui/kit/button.tsx"
import { Check } from "../../ui/kit/select.tsx"
import { BOX } from "./check-box.tsx"
import { share } from "./flex.ts"
import { useHeld } from "./held.ts"
import { Problems } from "./problems.tsx"
import { wordsOf } from "./words.ts"

/** A round box to choose, a small raised key; chosen, solid ink with a dot. */
const RING =
  "flex size-3.5 flex-none items-center justify-center rounded-full border border-key-border bg-bg outline-none focus-visible:focused data-checked:border-ink data-checked:bg-ink data-unchecked:hover:lit"

const OPTION = "flex h-line items-center gap-2.5 px-inset text-ui text-ink line-2-b"

/** What's chosen, as A2UI's own reads it: a list of values, or one. */
const chosenOf = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string")
  }
  return typeof value === "string" ? [value] : []
}

export const ChoicePicker = createComponentImplementation(ChoicePickerApi, ({ props }) => {
  const [find, setFind] = useState("")
  const [chosen, set] = useHeld(chosenOf(props.value), props.setValue)
  const several = props.variant === "multipleSelection"
  const choose = (value: string) => {
    if (!several) {
      set([value])
    } else if (chosen.includes(value)) {
      set(chosen.filter((v) => v !== value))
    } else {
      set([...chosen, value])
    }
  }
  const label = wordsOf(props.label)
  const options = props.options
    .map((o) => ({ value: o.value, label: wordsOf(o.label) }))
    .filter((o) => props.filterable !== true || o.label.toLowerCase().includes(find.toLowerCase()))
  const choices = () => {
    if (props.displayStyle === "chips") {
      return (
        <div className="flex flex-wrap gap-1.5 px-inset py-1 line-2-b">
          {options.map((o) => (
            <Toggle
              key={o.value}
              pressed={chosen.includes(o.value)}
              onPressedChange={() => {
                choose(o.value)
              }}
              className={buttonLook("key", "data-pressed:held")}
            >
              <span className="trim">{o.label}</span>
            </Toggle>
          ))}
        </div>
      )
    }
    if (several) {
      return options.map((o) => (
        <label key={o.value} className={OPTION}>
          <Checkbox.Root
            checked={chosen.includes(o.value)}
            onCheckedChange={() => {
              choose(o.value)
            }}
            className={BOX}
          >
            <Checkbox.Indicator>
              <Check />
            </Checkbox.Indicator>
          </Checkbox.Root>
          <span className="trim min-w-0 flex-1 truncate">{o.label}</span>
        </label>
      ))
    }
    return (
      <RadioGroup
        value={chosen[0] ?? null}
        onValueChange={(value) => {
          if (typeof value === "string") {
            choose(value)
          }
        }}
        className="flex flex-col"
      >
        {options.map((o) => (
          <label key={o.value} className={OPTION}>
            <Radio.Root value={o.value} className={RING}>
              <Radio.Indicator className="size-[5px] rounded-full bg-bg" />
            </Radio.Root>
            <span className="trim min-w-0 flex-1 truncate">{o.label}</span>
          </label>
        ))}
      </RadioGroup>
    )
  }
  return (
    <div className="flex flex-col" style={share(props.weight)}>
      {label && (
        <div className="flex h-line items-center px-inset text-ui text-ink2">
          <span className="trim">{label}</span>
        </div>
      )}
      {props.filterable === true && (
        <label className="flex h-line items-center px-inset line-2-b">
          <input
            value={find}
            onChange={(e) => {
              setFind(e.target.value)
            }}
            placeholder="Find…"
            aria-label="Find"
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-ink outline-none select-text placeholder:text-ink3"
          />
        </label>
      )}
      {choices()}
      <Problems errors={props.validationErrors} />
    </div>
  )
})
