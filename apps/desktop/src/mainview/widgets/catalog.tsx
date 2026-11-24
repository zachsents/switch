// Switch's own A2UI catalog: the house components, drawn as DESIGN.md says. An extension's widget
// uses them by this catalog's id, beside A2UI's basic catalog (basic/catalog.ts).
import { createComponentImplementation } from "@a2ui/react"
import {
  BASIC_FUNCTIONS,
  Catalog,
  DynamicBooleanSchema,
  DynamicNumberSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { Hand, Runner, Warn } from "../ui/marks.tsx"
import { Data } from "../ui/parts.tsx"
import { spanOf } from "../ui/time.ts"
import { useNow } from "../ui/use-now.ts"
import { charts } from "./charts/charts.ts"
import { Check } from "./check.tsx"
import { Entry } from "./entry.tsx"
import { Feed } from "./feed.tsx"
import { Gallery } from "./pictures.tsx"
import { Pick } from "./pick.tsx"
import { Playing } from "./playing.tsx"
import { Row } from "./row.tsx"

/** The same id as `SWITCH_CATALOG` in switch-ext-kit. */
export const SWITCH_CATALOG = "https://switch.ax/catalogs/v1/catalog.json"

/** One line: its mark, its name, and a time that runs while it does (`left` down, `elapsed` up). */
const Line = createComponentImplementation(
  {
    name: "Line",
    schema: z.object({
      label: DynamicStringSchema,
      running: DynamicBooleanSchema.optional(),
      ringing: DynamicBooleanSchema.optional(),
      left: DynamicNumberSchema.optional(),
      elapsed: DynamicNumberSchema.optional(),
      /** When the times were read, in ms. */
      asOf: DynamicNumberSchema.optional(),
    }),
  },
  ({ props }) => {
    const running = props.running === true
    const now = useNow(1000, running)
    const since = running ? Math.max(0, now - (props.asOf ?? now)) : 0
    let time: string | undefined
    if (typeof props.left === "number") {
      time = spanOf(props.left - since)
    } else if (typeof props.elapsed === "number") {
      time = spanOf(props.elapsed + since)
    }
    return (
      <li className="flex h-line items-center gap-2.5 px-inset text-ui text-ink">
        {props.ringing === true && <Hand />}
        {running && <Runner />}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {time !== undefined && <Data>{time}</Data>}
      </li>
    )
  },
)

/** A line in time: when, its live marks, what. */
const Slot = createComponentImplementation(
  {
    name: "Slot",
    schema: z.object({
      time: DynamicStringSchema,
      title: DynamicStringSchema,
      running: DynamicBooleanSchema.optional(),
      needsYou: DynamicBooleanSchema.optional(),
      conflict: DynamicBooleanSchema.optional(),
    }),
  },
  ({ props }) => (
    <li className="flex h-line items-center gap-2.5 px-inset text-ui text-ink">
      <span className="w-[68px] flex-none text-caption text-ink2 tabular-nums">{props.time}</span>
      {props.needsYou === true && <Hand />}
      {props.running === true && <Runner />}
      {props.conflict === true && <Warn />}
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
    </li>
  ),
)

/** A line of label and value, with a red triangle when it's worth a look. */
const Field = createComponentImplementation(
  {
    name: "Field",
    schema: z.object({
      label: DynamicStringSchema,
      value: DynamicStringSchema,
      alert: DynamicBooleanSchema.optional(),
    }),
  },
  ({ props }) => (
    // Its value whole: on the same line when it fits, else on its own under the label.
    <li className="flex min-h-line flex-wrap items-center gap-x-2.5 px-inset py-1.5 text-ui text-ink">
      {props.alert === true && <Warn />}
      <span className="min-w-0 truncate">{props.label}</span>
      {props.value !== "" && (
        <span className="ml-auto text-caption whitespace-nowrap text-ink3 tabular-nums">
          {props.value}
        </span>
      )}
    </li>
  ),
)

/** What a card is about, in reading size, with a hand when it needs the user. */
const Title = createComponentImplementation(
  {
    name: "Title",
    schema: z.object({ label: DynamicStringSchema, needsYou: DynamicBooleanSchema.optional() }),
  },
  ({ props }) => (
    <h2 className="m-0 flex min-h-line items-center gap-2.5 px-inset py-2 text-read font-semibold text-ink">
      {props.needsYou === true && <Hand />}
      <span className="min-w-0 flex-1">{props.label}</span>
    </h2>
  ),
)

// A2UI's basic functions too, `formatString` and the rest: a call that names no catalog runs in its
// surface's (A2UI v1.0), so a property bound by a call works on Switch's surfaces as the kit says.
export const switchCatalog = new Catalog(
  SWITCH_CATALOG,
  "1.0",
  [Line, Row, Pick, Slot, Field, Feed, Gallery, Title, Check, Entry, Playing, ...charts],
  BASIC_FUNCTIONS,
)
