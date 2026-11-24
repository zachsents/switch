// A2UI's DateTimeInput as a field's line (the house's fields): its label in ink2, then the system's
// date and time fields, as in A2UI's own, bare in the house's words (an unset one in a placeholder's
// ink, as A2UI's own evens out WebKit's), a line-2 under it. A date unless
// it asks for only a time. What's picked goes to the data model in ISO 8601 as A2UI's own writes it:
// a date, a time, or both, keeping the other half of what was there (today's date, midnight).
import { createComponentImplementation } from "@a2ui/react"
import { DateTimeInputApi } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"
import { useHeld } from "./held.ts"
import { Problems } from "./problems.tsx"
import { wordsOf } from "./words.ts"

const FIELD = "h-line border-0 bg-transparent p-0 text-ui outline-none select-text"

const textOf = (x: unknown) => (typeof x === "string" ? x : "")

/** A value's date or time as its field takes one, as A2UI's own reads it: no zone, no seconds. */
const part = (value: string, kind: "date" | "time") => {
  if (value.includes("T")) {
    const [date = "", time = ""] = value.split("T")
    return kind === "date" ? date.slice(0, 10) : time.slice(0, 5)
  }
  if (kind === "date") {
    return value.includes("-") ? value.slice(0, 10) : ""
  }
  return value.includes(":") ? value.slice(0, 5) : ""
}

/** The time a new date keeps, or the date a new time does, as A2UI's own writes them. */
const timeKept = (value: string) => {
  if (value.includes("T")) {
    return value.split("T")[1] ?? ""
  }
  return value.includes(":") ? value : "00:00:00"
}
const dateKept = (value: string) => {
  if (value.includes("T")) {
    return value.split("T")[0] ?? ""
  }
  return value.includes("-") ? value : Temporal.Now.plainDateISO().toString()
}

export const DateTimeInput = createComponentImplementation(DateTimeInputApi, ({ props }) => {
  const time = props.enableTime === true
  const date = props.enableDate ?? !time
  const [value, set] = useHeld(textOf(props.value), props.setValue)
  const label = wordsOf(props.label)
  const min = textOf(props.min)
  const max = textOf(props.max)
  return (
    <div className="flex flex-col line-2-b" style={share(props.weight)}>
      <label className="flex h-line items-center gap-2.5 px-inset text-ui">
        {label && <span className="trim flex-none text-ink2">{label}</span>}
        {date && (
          <input
            type="date"
            value={part(value, "date")}
            min={part(min, "date") || undefined}
            max={part(max, "date") || undefined}
            onChange={(e) => {
              set(time ? `${e.target.value}T${timeKept(value)}` : e.target.value)
            }}
            className={`${FIELD} ${part(value, "date") ? "text-ink" : "text-ink3"}`}
          />
        )}
        {time && (
          <input
            type="time"
            value={part(value, "time")}
            min={part(min, "time") || undefined}
            max={part(max, "time") || undefined}
            onChange={(e) => {
              set(date ? `${dateKept(value)}T${e.target.value}:00` : e.target.value)
            }}
            className={`${FIELD} ${part(value, "time") ? "text-ink" : "text-ink3"}`}
          />
        )}
      </label>
      <Problems errors={props.validationErrors} />
    </div>
  )
})
