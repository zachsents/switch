// A line to write in: no border, its placeholder a word or two. Enter calls the extension's
// `action` with `args` and what was written under `field`, and clears it once the extension takes
// it.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"
import { z } from "zod"

import { setMutation } from "./set-mutation.ts"

const text = (x: unknown) => (typeof x === "string" ? x : "")

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

const filled = Schema.toStandardSchemaV1(
  Schema.Struct({ text: Schema.String.check(Schema.makeFilter((s: string) => s.trim() !== "")) }),
)

export const Entry = createComponentImplementation(
  {
    name: "Entry",
    schema: z.object({
      placeholder: DynamicStringSchema.optional(),
      /** The extension's tool Enter calls, what it's always given, and the argument the words go in. */
      action: z.string(),
      args: DynamicValueSchema.optional(),
      field: z.string(),
    }),
  },
  ({ props, context }) => {
    const add = useMutation(setMutation)
    const app = (context.dataContext.surface?.id ?? "").split("/")[0] ?? ""
    const form = useForm({
      defaultValues: { text: "" },
      validators: { onSubmit: filled },
      onSubmit: ({ value, formApi }) => {
        add.mutate(
          {
            call: { app, tool: props.action, args: record(props.args) },
            values: { [props.field]: value.text.trim() },
          },
          {
            onSuccess: () => {
              formApi.reset()
            },
          },
        )
      },
    })
    return (
      <form
        className="flex h-line items-center gap-2.5 pr-inset"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="text">
          {(field) => (
            <input
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              onBlur={field.handleBlur}
              disabled={add.isPending}
              placeholder={text(props.placeholder)}
              aria-label={text(props.placeholder)}
              className="h-full min-w-0 flex-1 border-0 bg-transparent py-0 pr-0 pl-inset text-ui text-ink outline-none select-text placeholder:text-ink3"
            />
          )}
        </form.Field>
        {add.error && (
          <span className="min-w-0 shrink truncate text-small text-red">{add.error.message}</span>
        )}
      </form>
    )
  },
)
