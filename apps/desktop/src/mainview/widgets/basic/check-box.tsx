// A2UI's CheckBox as old Switchboard drew one (plain's a2ui-gpui): a small raised key, solid ink with
// a check once it's ticked, and its words beside it, on a line with a line-2 under it as the house's
// Check is; the whole line ticks it (Base UI's Checkbox). Ticking writes to the data model, as in
// A2UI's own; what its checks find wrong shows under it.
import { Checkbox } from "@base-ui/react/checkbox"
import { createComponentImplementation } from "@a2ui/react"
import { CheckBoxApi } from "@a2ui/web_core/v1_0"

import { Check } from "../../ui/kit/select.tsx"
import { share } from "./flex.ts"
import { useHeld } from "./held.ts"
import { Problems } from "./problems.tsx"
import { wordsOf } from "./words.ts"

/** A box to tick, a small raised key; ticked, solid ink. */
export const BOX =
  "flex size-3.5 flex-none items-center justify-center rounded-key border border-key-border bg-bg outline-none focus-visible:focused data-checked:border-ink data-checked:bg-ink data-checked:text-bg data-unchecked:hover:lit"

export const CheckBox = createComponentImplementation(CheckBoxApi, ({ props }) => {
  const [on, set] = useHeld(props.value === true, props.setValue)
  return (
    <div className="flex flex-col line-2-b" style={share(props.weight)}>
      <label className="flex min-h-line items-center gap-2.5 px-inset text-ui text-ink">
        <Checkbox.Root checked={on} onCheckedChange={set} className={BOX}>
          <Checkbox.Indicator>
            <Check />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <span className="trim min-w-0 flex-1">{wordsOf(props.label)}</span>
      </label>
      <Problems errors={props.validationErrors} />
    </div>
  )
})
