// A cell that's a key: its swatch, its name (a slot's, dim) and its label (what it holds). It opens choices in groups (words, or colors as
// swatches), and Set calls the extension's `action` with `args` and what was chosen.
import { Popover } from "@base-ui/react/popover"
import { createComponentImplementation } from "@a2ui/react"
import { DynamicBooleanSchema, DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { useState } from "react"
import { z } from "zod"

import { FLOAT } from "../ui/kit/float.ts"
import { Choices } from "./choices.tsx"
import { Swatch } from "./swatch.tsx"

const group = z.object({
  key: z.string(),
  choices: z.array(z.string()),
  /** The choices are RRGGBB colors. */
  swatches: z.boolean().optional(),
  /** Any RRGGBB too, typed under the swatches. */
  custom: z.boolean().optional(),
})

const text = (x: unknown) => (typeof x === "string" ? x : "")

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

export const Pick = createComponentImplementation(
  {
    name: "Pick",
    schema: z.object({
      label: DynamicStringSchema,
      swatch: DynamicStringSchema.optional(),
      /** In use now. */
      strong: DynamicBooleanSchema.optional(),
      title: DynamicStringSchema.optional(),
      groups: z.array(group),
      /** What each group holds now, by key. */
      current: DynamicValueSchema.optional(),
      /** The extension's tool Set calls, and what it's always given. */
      action: z.string(),
      args: DynamicValueSchema.optional(),
    }),
  },
  ({ props, context }) => {
    const [open, setOpen] = useState(false)
    const app = (context.dataContext.surface?.id ?? "").split("/")[0] ?? ""
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className="flex h-line min-w-0 items-center gap-1.5 px-inset text-left outline-none line-1-r last:border-r-0 hover:lit data-popup-open:held"
          aria-label={`${text(props.title)} ${text(props.label)}`.trim()}
        >
          {text(props.swatch) !== "" && <Swatch color={text(props.swatch)} />}
          {text(props.title) !== "" && (
            <span className="flex-none text-caption font-semibold text-ink3">
              {text(props.title)}
            </span>
          )}
          <span
            className={`min-w-0 truncate text-caption ${props.strong === true ? "font-semibold text-ink" : "text-ink2"}`}
          >
            {text(props.label)}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" sideOffset={4}>
            <Popover.Popup className={FLOAT}>
              <Choices
                key={JSON.stringify(props.current)}
                groups={props.groups}
                current={record(props.current)}
                call={{ app, tool: props.action, args: record(props.args) }}
                done={() => {
                  setOpen(false)
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    )
  },
)
