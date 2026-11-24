// A Pick's choices: a row of keys per group, one chosen in each (for a `custom` group of swatches,
// any RRGGBB typed beside Set), and Set, which calls the extension. A TanStack Form, checked by a schema of its groups (each value one of its choices);
// Set is a mutation, and the popup closes when the extension takes it.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"

import { Spin, Stop } from "../ui/marks.tsx"
import { Tip } from "../ui/parts.tsx"
import { setMutation } from "./set-mutation.ts"
import type { Call } from "./set-mutation.ts"
import { Swatch } from "./swatch.tsx"
import { Button } from "../ui/kit/button.tsx"

interface Group {
  readonly key: string
  readonly choices: readonly string[]
  readonly swatches?: boolean | undefined
  /** Any RRGGBB too, typed under the swatches. */
  readonly custom?: boolean | undefined
}

const HEX = /^[0-9A-F]{6}$/u

/** A value the group takes: one of its choices, or for a custom group any RRGGBB. */
const takes = (g: Group, value: string) =>
  g.choices.includes(value) || (g.custom === true && HEX.test(value))

/** The chosen key outlined by a border of its own (every key keeps a clear one, so none shifts). */
const chosen = (on: boolean) => (on ? "held border-2 border-ink" : "border-2 border-transparent")

/** Each group's value is one of its choices. */
const schemaOf = (groups: readonly Group[]) =>
  Schema.toStandardSchemaV1(
    Schema.Record(Schema.String, Schema.String).check(
      Schema.makeFilter((values: Readonly<Record<string, string>>) =>
        groups.every((g) => takes(g, values[g.key] ?? "")),
      ),
    ),
  )

export const Choices = ({
  groups,
  current,
  call,
  done,
}: {
  groups: readonly Group[]
  current: Record<string, unknown>
  call: Call
  done: () => void
}) => {
  const set = useMutation(setMutation)
  /** The group any RRGGBB is typed for, on Set's line. */
  const custom = groups.find((g) => g.custom === true)
  const form = useForm({
    defaultValues: Object.fromEntries(
      groups.map((g) => {
        const now = current[g.key]
        return [
          g.key,
          typeof now === "string" && takes(g, now.toUpperCase())
            ? now.toUpperCase()
            : (g.choices[0] ?? ""),
        ]
      }),
    ),
    validators: { onChange: schemaOf(groups) },
    onSubmit: ({ value }) => {
      // Pending, Set stays at full strength (its spinner says so) and another press does nothing.
      if (set.isPending) {
        return
      }
      set.mutate({ call, values: value }, { onSuccess: done })
    },
  })
  return (
    <form
      className="flex w-[244px] flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      {groups.map((g) => (
        <form.Field key={g.key} name={g.key}>
          {(field) => (
            <div
              className="grid line-1-b"
              style={{
                gridTemplateColumns:
                  g.swatches === true
                    ? "repeat(8, minmax(0, 1fr))"
                    : `repeat(auto-fill, minmax(${g.choices.length > 5 ? 60 : 44}px, 1fr))`,
              }}
            >
              {g.choices.map((c) => {
                const key = (
                  <Button
                    look="bare"
                    key={c}
                    aria-label={g.swatches === true ? `#${c}` : c}
                    onClick={() => {
                      field.handleChange(c)
                    }}
                    className={`flex items-center justify-center text-small whitespace-nowrap text-ink outline-none hover:lit ${g.swatches === true ? "h-[30px]" : "h-line"} ${g.swatches === true ? "" : chosen(field.state.value === c)}`}
                  >
                    {g.swatches === true ? (
                      <Swatch color={c} size={16} chosen={field.state.value === c} />
                    ) : (
                      c
                    )}
                  </Button>
                )
                return g.swatches === true ? (
                  <Tip key={c} label={`#${c}`}>
                    {key}
                  </Tip>
                ) : (
                  key
                )
              })}
            </div>
          )}
        </form.Field>
      ))}
      <div className="flex h-line items-center gap-2 pr-1.5 pl-3">
        {set.isError && <Stop size={12} />}
        {set.isError ? (
          <span className="min-w-0 flex-1 truncate text-small text-ink">{set.error.message}</span>
        ) : (
          custom && (
            <form.Field name={custom.key}>
              {(field) => (
                <label className="flex h-full min-w-0 flex-1 cursor-text items-center gap-2">
                  {HEX.test(field.state.value) && !custom.choices.includes(field.state.value) && (
                    <Swatch color={field.state.value} />
                  )}
                  <input
                    value={custom.choices.includes(field.state.value) ? "" : field.state.value}
                    onChange={(e) => {
                      field.handleChange(e.target.value.replace(/^#/u, "").trim().toUpperCase())
                    }}
                    maxLength={7}
                    spellCheck={false}
                    placeholder="Hex"
                    aria-label="Hex"
                    className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-data text-ink outline-none select-text placeholder:text-ink3"
                  />
                </label>
              )}
            </form.Field>
          )
        )}
        {!set.isError && !custom && <span className="flex-1" />}
        <form.Subscribe selector={(f) => f.canSubmit}>
          {(ready) => (
            <Button look="go" type="submit" disabled={!ready} aria-busy={set.isPending}>
              {set.isPending && <Spin ink="text-white" />}
              Set
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}
