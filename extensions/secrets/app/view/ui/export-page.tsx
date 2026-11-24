// Export: every item opened here, after the Mac's own check, written in the clear to a file the
// user picks, as CSV or JSON. Each is recorded in the audit as exported.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"

import { exportMutation } from "../mutations.ts"
import { Cells } from "./cells.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

const FORMATS = ["csv", "json"] as const

const START: { format: (typeof FORMATS)[number] } = { format: "csv" }

export const ExportPage = () => {
  const write = useMutation(exportMutation)
  const form = useForm({
    defaultValues: START,
    onSubmit: async ({ value }) => {
      await write.mutateAsync(value.format)
    },
  })
  return (
    <article className="min-h-full bg-paper">
      <Section label="Export">
        <li className="list-none">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.Field name="format">
              {(field) => (
                <div className="flex h-line items-center hairline-b">
                  <span className="w-label flex-none px-inset text-small text-ink2">Format</span>
                  {FORMATS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => {
                        field.handleChange(f)
                      }}
                      className={`mr-1 h-7 rounded-chip px-2.5 text-small uppercase outline-none hover:bg-wash ${field.state.value === f ? "bg-selection text-ink" : "text-ink2"}`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </form.Field>
            {write.data !== undefined && write.data !== null && (
              <Cells label="Written">
                <span className="font-mono text-small">{write.data}</span>
              </Cells>
            )}
            <div className="flex h-head items-center gap-2 px-inset">
              {write.error && (
                <span className="flex min-w-0 items-center gap-2 text-small text-ink">
                  <Stop size={12} />
                  <span className="truncate">{write.error.message}</span>
                </span>
              )}
              <span className="ml-auto">
                <form.Subscribe selector={(s) => s.isSubmitting}>
                  {(busy) => (
                    <Key go type="submit" disabled={busy}>
                      Export
                    </Key>
                  )}
                </form.Subscribe>
              </span>
            </div>
          </form>
        </li>
      </Section>
    </article>
  )
}
