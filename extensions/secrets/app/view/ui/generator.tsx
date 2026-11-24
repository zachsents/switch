// The password generator: a style (random, or Apple's xxxxxx-xxxxxx-xxxxxx, or a PIN), its length,
// digits and symbols; a new one on every change and on Regenerate. Alone it copies; in the editor
// it fills the field.
import { useForm, useSelector } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"

import type { Generate } from "../../shared/rpc.ts"
import { copyTextMutation } from "../mutations.ts"
import { generateQuery } from "../queries.ts"
import { Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

const STYLES = [
  ["random", "Random"],
  ["apple", "Apple"],
  ["pin", "PIN"],
] as const

const START: Generate = { style: "random", length: 24, digits: true, symbols: true }

const Check = ({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) => (
  <label className="flex h-line items-center gap-2 pr-4 text-ui text-ink">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        onChange(e.target.checked)
      }}
      className="size-4 accent-current"
    />
    {label}
  </label>
)

export const Generator = ({ onUse }: { onUse?: (value: string) => void }) => {
  const form = useForm({ defaultValues: START })
  const options = useSelector(form.store, (s) => s.values)
  const made = useQuery(generateQuery(options))
  const copy = useMutation(copyTextMutation)
  const failed = made.error ?? copy.error
  const value = made.data ?? ""
  const ranged = options.style === "pin" ? [4, 12] : [8, 64]
  return (
    <div>
      <div className="selectable flex min-h-[64px] items-center px-inset py-3 font-mono text-read break-all text-ink hairline-b">
        {value}
      </div>
      <form.Field name="style">
        {(field) => (
          <div className="flex h-line items-center gap-1 px-inset hairline-b">
            {STYLES.map(([style, label]) => (
              <button
                key={style}
                type="button"
                onClick={() => {
                  field.handleChange(style)
                  form.setFieldValue("length", style === "pin" ? 6 : 24)
                }}
                className={`h-7 rounded-chip px-2.5 text-small outline-none hover:bg-wash ${field.state.value === style ? "bg-selection text-ink" : "text-ink2"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </form.Field>
      {options.style !== "apple" && (
        <form.Field name="length">
          {(field) => (
            <label className="flex h-line items-center gap-3 px-inset hairline-b">
              <span className="w-label flex-none text-small text-ink2">Length</span>
              <input
                type="range"
                min={ranged[0]}
                max={ranged[1]}
                value={field.state.value}
                onChange={(e) => {
                  field.handleChange(Number(e.target.value))
                }}
                className="min-w-0 flex-1 accent-current"
              />
              <span className="w-8 flex-none text-right font-mono text-data text-ink3">
                {field.state.value}
              </span>
            </label>
          )}
        </form.Field>
      )}
      {options.style === "random" && (
        <div className="flex items-center px-inset hairline-b">
          <form.Field name="digits">
            {(field) => (
              <Check label="Digits" checked={field.state.value} onChange={field.handleChange} />
            )}
          </form.Field>
          <form.Field name="symbols">
            {(field) => (
              <Check label="Symbols" checked={field.state.value} onChange={field.handleChange} />
            )}
          </form.Field>
        </div>
      )}
      <div className="flex h-head items-center gap-2 px-inset">
        {failed && (
          <span className="flex min-w-0 items-center gap-2 text-small text-ink">
            <Stop size={12} />
            <span className="truncate">{failed.message}</span>
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <Key
            onClick={() => {
              void made.refetch()
            }}
          >
            Regenerate
          </Key>
          {onUse ? (
            <Key
              go
              disabled={value === ""}
              onClick={() => {
                onUse(value)
              }}
            >
              Use
            </Key>
          ) : (
            <Key
              go
              disabled={value === "" || copy.isPending}
              onClick={() => {
                copy.mutate(value)
              }}
            >
              {copy.isSuccess ? "Copied" : "Copy"}
            </Key>
          )}
        </span>
      </div>
    </div>
  )
}
