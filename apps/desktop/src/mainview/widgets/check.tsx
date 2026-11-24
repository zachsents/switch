// A line that ticks off: its ring, its name and its data. The ring calls the extension's `action` with
// `args`; a done one's ring is filled and its name dimmed. A hairline under each, so lists of them
// and what follows read as one.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicBooleanSchema, DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { useMutation } from "@tanstack/react-query"
import { z } from "zod"

import { Data } from "../ui/parts.tsx"
import { setMutation } from "./set-mutation.ts"
import { Button } from "../ui/kit/button.tsx"

const text = (x: unknown) => (typeof x === "string" ? x : "")

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

export const Check = createComponentImplementation(
  {
    name: "Check",
    schema: z.object({
      label: DynamicStringSchema,
      detail: DynamicStringSchema.optional(),
      done: DynamicBooleanSchema.optional(),
      /** The extension's tool the ring calls, and what it's given. */
      action: z.string(),
      args: DynamicValueSchema.optional(),
    }),
  },
  ({ props, context }) => {
    const tick = useMutation(setMutation)
    const app = (context.dataContext.surface?.id ?? "").split("/")[0] ?? ""
    const done = props.done === true
    const detail = tick.error?.message ?? text(props.detail)
    return (
      <li className="flex h-line items-center gap-2.5 px-inset text-ui line-2-b">
        <Button
          look="bare"
          aria-label={done ? "Not done" : "Done"}
          disabled={tick.isPending}
          onClick={() => {
            tick.mutate({ call: { app, tool: props.action, args: record(props.args) }, values: {} })
          }}
          className={`size-[14px] flex-none rounded-full border-[1.5px] outline-none disabled:opacity-40 ${
            done ? "border-ink3 bg-ink3" : "border-ink2 hover:lit"
          }`}
        />
        <span className={`min-w-0 flex-1 truncate ${done ? "text-ink3" : "text-ink"}`}>
          {text(props.label)}
        </span>
        {detail !== "" && <Data>{detail}</Data>}
      </li>
    )
  },
)
