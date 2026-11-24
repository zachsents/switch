// Import: another manager's export, read on this Mac. Pick its kind and the file, see what it would
// add, then add it; every item is sealed here.
import { useForm, useSelector } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"

import { SOURCES } from "../../../src/imports.ts"
import { KINDS } from "../../../src/model.ts"
import type { Source } from "../../../src/imports.ts"
import { KIND_LABELS } from "../listing.ts"
import { confirmImportMutation, pickImportMutation, previewImportMutation } from "../mutations.ts"
import { Cells } from "./cells.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

const NAMES: Record<Source, string> = {
  chrome: "Chrome",
  apple: "Apple Passwords",
  bitwarden: "Bitwarden",
  "1password": "1Password",
  csv: "CSV",
}

const kindLabel = (kind: string) => {
  const k = KINDS.find((x) => x === kind)
  return k ? KIND_LABELS[k] : kind
}

const START: { source: Source; file: string } = { source: "chrome", file: "" }

export const ImportPage = () => {
  const pick = useMutation(pickImportMutation)
  const preview = useMutation(previewImportMutation)
  const confirm = useMutation(confirmImportMutation)
  const form = useForm({
    defaultValues: START,
    onSubmit: async ({ value }) => {
      confirm.reset()
      await preview.mutateAsync(value)
    },
  })
  const file = useSelector(form.store, (s) => s.values.file)
  const failed = pick.error ?? preview.error ?? confirm.error
  const shown = preview.data
  return (
    <article className="min-h-full bg-paper">
      <Section label="Import">
        <li className="list-none">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.Field name="source">
              {(field) => (
                <label className="flex h-line items-center hairline-b">
                  <span className="w-label flex-none px-inset text-small text-ink2">From</span>
                  <select
                    value={field.state.value}
                    onChange={(e) => {
                      const s = SOURCES.find((x) => x === e.target.value)
                      if (s) {
                        field.handleChange(s)
                        preview.reset()
                      }
                    }}
                    className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent text-ui text-ink outline-none"
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {NAMES[s]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </form.Field>
            <Cells
              label="File"
              end={
                <Key
                  disabled={pick.isPending}
                  onClick={() => {
                    pick.mutate(undefined, {
                      onSuccess: (chosen) => {
                        if (chosen !== null && chosen !== "") {
                          form.setFieldValue("file", chosen)
                          preview.reset()
                        }
                      },
                    })
                  }}
                >
                  Choose
                </Key>
              }
            >
              <span className="font-mono text-small">{file}</span>
            </Cells>
            <div className="flex h-head items-center gap-2 px-inset hairline-b">
              {failed && (
                <span className="flex min-w-0 items-center gap-2 text-small text-ink">
                  <Stop size={12} />
                  <span className="truncate">{failed.message}</span>
                </span>
              )}
              <span className="ml-auto">
                <Key type="submit" disabled={file === "" || preview.isPending}>
                  Preview
                </Key>
              </span>
            </div>
          </form>
        </li>
      </Section>
      {shown && (
        <Section label="Adds" count={shown.total}>
          {shown.kinds.map((k) => (
            <Cells key={k.kind} label={kindLabel(k.kind)}>
              <span className="font-mono">{k.count}</span>
            </Cells>
          ))}
          {shown.skipped > 0 && (
            <Cells label="Already in">
              <span className="font-mono">{shown.skipped}</span>
            </Cells>
          )}
          <li className="flex h-head list-none items-center gap-3 px-inset">
            {confirm.data !== undefined && (
              <span className="font-mono text-data text-ink2">{confirm.data}</span>
            )}
            <span className="ml-auto">
              <Key
                go
                disabled={shown.total === 0 || confirm.isPending || confirm.isSuccess}
                onClick={() => {
                  confirm.mutate()
                }}
              >
                {confirm.isSuccess ? "Imported" : "Import"}
              </Key>
            </span>
          </li>
        </Section>
      )}
    </article>
  )
}
