// What may use which secrets: each grant's subject, scope and uses, removable, and a line to add
// one. Each change carries a proof made here, after the Mac's own check.
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Schema } from "effect"

import { KINDS } from "../../../src/model.ts"
import type { ShownItem } from "../../shared/rpc.ts"
import { grantMutation } from "../mutations.ts"
import { membersQuery } from "../queries.ts"
import { Flat } from "./field-row.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

const USES = ["fill", "env", "file", "http"] as const

const filled = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
const validate = Schema.toStandardSchemaV1(
  Schema.Struct({
    subject: filled,
    scope: filled,
    uses: Schema.Array(Schema.Literals(USES)).check(Schema.isMinLength(1)),
  }),
)

const INPUT =
  "selectable h-full min-w-0 flex-1 border-0 bg-transparent px-inset font-mono text-small text-ink outline-none"

export const GrantsPage = ({ items }: { items: readonly ShownItem[] }) => {
  const { data } = useQuery(membersQuery)
  const change = useMutation(grantMutation)
  const grants = data?.grants ?? []
  const titleOf = (scope: string) =>
    scope.startsWith("item:") ? (items.find((i) => i.id === scope.slice(5))?.title ?? scope) : scope
  const form = useForm({
    defaultValues: {
      subject: "agent",
      scope: "all",
      uses: ["fill"] as readonly (typeof USES)[number][],
    },
    validators: { onSubmit: validate },
    onSubmit: async ({ value }) => {
      await change.mutateAsync({
        op: "add",
        grant: {
          id: "",
          subject: value.subject.trim(),
          scope: value.scope.trim(),
          uses: value.uses,
        },
      })
      form.reset()
    },
  })
  const subjects = ["agent", ...(data?.extensions ?? []).map((s) => `extension:${s.name}`)]
  const scopes = [
    "all",
    ...KINDS.map((k) => `kind:${k}`),
    ...[...new Set(items.flatMap((i) => i.tags))].map((t) => `tag:${t}`),
    ...[...new Set(items.map((i) => i.folder).filter(Boolean))].map((f) => `folder:${f}`),
  ]
  return (
    <article className="min-h-full bg-paper">
      <Section label="Grants" count={grants.length}>
        {grants.map((g) => (
          <li key={g.id} className="flex h-line items-center gap-3 px-inset hairline-b">
            <span className="w-[180px] flex-none truncate font-mono text-small text-ink">
              {g.subject}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-ink">{titleOf(g.scope)}</span>
            <span className="w-[160px] flex-none font-mono text-data text-ink2">
              {g.uses.join(" ")}
            </span>
            <Flat
              disabled={change.isPending}
              onClick={() => {
                change.mutate({ op: "remove", grant: g })
              }}
            >
              Remove
            </Flat>
          </li>
        ))}
        <li className="list-none">
          <form
            className="flex h-line items-center"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.Field name="subject">
              {(field) => (
                <>
                  <input
                    aria-label="Subject"
                    list="grant-subjects"
                    value={field.state.value}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                    }}
                    className={`${INPUT} w-[180px] flex-none`}
                  />
                  <datalist id="grant-subjects">
                    {subjects.map((s) => (
                      <option key={s} value={s} aria-label={s} />
                    ))}
                  </datalist>
                </>
              )}
            </form.Field>
            <form.Field name="scope">
              {(field) => (
                <>
                  <input
                    aria-label="Scope"
                    list="grant-scopes"
                    value={field.state.value}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                    }}
                    className={INPUT}
                  />
                  <datalist id="grant-scopes">
                    {scopes.map((s) => (
                      <option key={s} value={s} aria-label={s} />
                    ))}
                  </datalist>
                </>
              )}
            </form.Field>
            <form.Field name="uses">
              {(field) => (
                <span className="flex flex-none items-center gap-2 pr-3">
                  {USES.map((u) => (
                    <label
                      key={u}
                      className="flex items-center gap-1 font-mono text-data text-ink2"
                    >
                      <input
                        type="checkbox"
                        checked={field.state.value.includes(u)}
                        onChange={(e) => {
                          field.handleChange(
                            e.target.checked
                              ? [...field.state.value, u]
                              : field.state.value.filter((x) => x !== u),
                          )
                        }}
                        className="size-3.5 accent-current"
                      />
                      {u}
                    </label>
                  ))}
                </span>
              )}
            </form.Field>
            {change.error && (
              <span className="flex min-w-0 items-center gap-2 pr-3 text-small text-ink">
                <Stop size={12} />
                <span className="truncate">{change.error.message}</span>
              </span>
            )}
            <span className="pr-inset">
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(busy) => (
                  <Key type="submit" disabled={busy}>
                    Add
                  </Key>
                )}
              </form.Subscribe>
            </span>
          </form>
        </li>
      </Section>
    </article>
  )
}
