// A2UI's TextField as the house's fields are (Settings' rows, the Entry part): its label in ink2 at the
// start of a line, the words bare beside it, a line-2 under the cell, and the whole cell the field's
// (DESIGN.md: a field's whole cell takes the cursor). Long text writes under its label. What's
// typed goes to the data model as it's typed, and a number or a password field is one, as in
// A2UI's own; what its checks find wrong shows under it.
import { createComponentImplementation } from "@a2ui/react"
import { TextFieldApi } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"
import { useHeld } from "./held.ts"
import { Problems } from "./problems.tsx"
import { wordsOf } from "./words.ts"

const TYPE = {
  shortText: "text",
  longText: "text",
  number: "number",
  obscured: "password",
} as const

const WORDS =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-ink outline-none select-text placeholder:text-ink3"

export const TextField = createComponentImplementation(TextFieldApi, ({ props }) => {
  const [value, set] = useHeld(wordsOf(props.value), props.setValue)
  const label = wordsOf(props.label)
  const placeholder = wordsOf(props.placeholder)
  const long = props.variant === "longText"
  return (
    <div className="flex flex-col line-2-b" style={share(props.weight)}>
      <label
        className={`flex px-inset text-ui ${long ? "flex-col pb-1" : "min-h-line items-center gap-2.5"}`}
      >
        {label && (
          <span className={`trim flex-none text-ink2 ${long ? "flex h-line items-center" : ""}`}>
            {label}
          </span>
        )}
        {long ? (
          <textarea
            value={value}
            rows={3}
            placeholder={placeholder}
            onChange={(e) => {
              set(e.target.value)
            }}
            className={`${WORDS} resize-none`}
          />
        ) : (
          <input
            type={TYPE[props.variant ?? "shortText"]}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              set(e.target.value)
            }}
            className={`${WORDS} h-line`}
          />
        )}
      </label>
      <Problems errors={props.validationErrors} />
    </div>
  )
})
