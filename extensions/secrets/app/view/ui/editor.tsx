// An item, new or as it is, to edit: its kind's fields and any of the user's own, URLs with how
// they match, notes, tags, folder and spaces. A concealed value left blank keeps what it holds;
// Reveal fills it in to change, Generate makes one. Saved whole, sealed in the bun process.
import { Popover } from "@base-ui/react/popover"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import { useState } from "react"
import type { ReactNode } from "react"

import { CONCEALED, FIELD_TYPES, KINDS, TEMPLATES } from "../../../src/model.ts"
import type { FieldType, Kind } from "../../../src/model.ts"
import { NOTES } from "../../shared/rpc.ts"
import type { FieldDraft, ItemDraft, ShownItem } from "../../shared/rpc.ts"
import { KIND_NAMES } from "../listing.ts"
import { ask } from "../bridge.ts"
import { saveMutation } from "../mutations.ts"
import { itemQuery } from "../queries.ts"
import { openItem } from "../route.ts"
import { DOTS, Flat } from "./field-row.tsx"
import { Generator } from "./generator.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

const MATCHES = ["domain", "host", "exact"] as const

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  email: "Email",
  url: "URL",
  phone: "Phone",
  date: "Date",
  month: "Month",
  year: "Year",
  password: "Password",
  concealed: "Concealed",
  totp: "One-time code",
  "card-number": "Card number",
  cvc: "Security code",
  pin: "PIN",
  ssn: "SSN",
  "private-key": "Private key",
}
type Match = (typeof MATCHES)[number]

interface EditField {
  id: string
  label: string
  type: FieldType
  value: string
  /** It holds a concealed value the view hasn't seen: blank keeps it. */
  kept: boolean
}

interface Values {
  kind: Kind
  title: string
  name: string
  fields: EditField[]
  /** `key` only keeps each line's inputs its own while lines come and go. */
  urls: { key: string; url: string; match: Match }[]
  notes: string
  notesKept: boolean
  tags: string
  folder: string
  spaces: string
  favorite: boolean
  /** The add-field line. */
  newLabel: string
  newType: FieldType
}

const templateOf = (kind: Kind): EditField[] =>
  TEMPLATES[kind].map(([id, label, type]) => ({ id, label, type, value: "", kept: false }))

const valuesOf = (item: ShownItem | null, kind: Kind): Values => ({
  kind: item?.kind ?? kind,
  title: item?.title ?? "",
  name: item?.name ?? "",
  fields: item
    ? item.fields.map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        value: f.value,
        kept: f.concealed && f.set,
      }))
    : templateOf(kind),
  urls: item
    ? item.urls.map((u) => ({ key: crypto.randomUUID(), url: u.url, match: u.match ?? "domain" }))
    : [],
  notes: "",
  notesKept: item?.notes ?? false,
  tags: item?.tags.join(", ") ?? "",
  folder: item?.folder ?? "",
  spaces: item?.spaces.join(", ") ?? "",
  favorite: item?.favorite ?? false,
  newLabel: "",
  newType: "text",
})

const listOf = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

const draftOf = (id: string | null, v: Values): ItemDraft => {
  const fields: FieldDraft[] = v.fields.map((f) =>
    f.kept && f.value === ""
      ? { id: f.id, label: f.label, type: f.type }
      : { id: f.id, label: f.label, type: f.type, value: f.value },
  )
  return {
    ...(id !== null && { id }),
    kind: v.kind,
    title: v.title,
    name: v.name,
    fields,
    urls: v.urls.filter((u) => u.url.trim()).map((u) => ({ url: u.url.trim(), match: u.match })),
    ...(!(v.notesKept && v.notes === "") && { notes: v.notes }),
    tags: listOf(v.tags),
    folder: v.folder,
    spaces: listOf(v.spaces),
    favorite: v.favorite,
  }
}

/** A custom field's id from its label, unlike any the item has. */
const idFor = (label: string, taken: readonly EditField[]) => {
  const base =
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "") || "field"
  let id = base
  let n = 2
  while (taken.some((f) => f.id === id) || id === NOTES) {
    id = `${base}_${n}`
    n += 1
  }
  return id
}

const validTitle = Schema.toStandardSchemaV1(Schema.String.check(Schema.isNonEmpty()))

const INPUT =
  "selectable h-full min-w-0 flex-1 border-0 bg-transparent pr-3 text-ui text-ink outline-none"
const SELECT =
  "h-full flex-none appearance-none border-0 bg-transparent px-inset text-small text-ink2 outline-none hover:bg-wash focus-visible:bg-selection"

const Line = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex h-line items-center hairline-b">
    <span className="w-label flex-none px-inset text-small text-ink2">{label}</span>
    {children}
  </label>
)

const GeneratePop = ({ onUse }: { onUse: (v: string) => void }) => {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="flex h-7 flex-none items-center rounded-chip px-2 text-small text-ink2 outline-none hover:bg-wash hover:text-ink focus-visible:bg-selection">
        Generate
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-[420px] overflow-hidden rounded-card bg-overlay shadow-float outline-none transition-opacity duration-100 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Generator
              onUse={(v) => {
                onUse(v)
                setOpen(false)
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export const Editor = ({ id, kind }: { id: string | null; kind: Kind }) => {
  const { data: item } = useQuery({ ...itemQuery(id ?? ""), enabled: id !== null })
  if (id !== null && item === undefined) {
    return null
  }
  return <EditorForm key={id ?? `new:${kind}`} id={id} item={item ?? null} kind={kind} />
}

const EditorForm = ({
  id,
  item,
  kind,
}: {
  id: string | null
  item: ShownItem | null
  kind: Kind
}) => {
  const save = useMutation(saveMutation)
  const reveal = useMutation({
    mutationFn: async (field: string) => (id === null ? "" : await ask.reveal({ id, field })),
  })
  const form = useForm({
    defaultValues: valuesOf(item, kind),
    onSubmit: async ({ value }) => {
      const saved = await save.mutateAsync(draftOf(id, value))
      openItem(saved)
    },
  })
  const failed = save.error ?? reveal.error
  return (
    <form
      className="min-h-full bg-paper"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <header className="flex h-head items-center gap-3 px-inset hairline-b">
        <form.Field name="title" validators={{ onSubmit: validTitle }}>
          {(field) => (
            <input
              aria-label="Title"
              placeholder="Title"
              autoFocus
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              className="selectable h-full min-w-0 flex-1 border-0 bg-transparent text-name font-semibold text-ink outline-none"
            />
          )}
        </form.Field>
        {failed && (
          <span className="flex min-w-0 items-center gap-2 text-small text-ink">
            <Stop size={12} />
            <span className="truncate">{failed.message}</span>
          </span>
        )}
        <Key
          onClick={() => {
            history.back()
          }}
        >
          Cancel
        </Key>
        <form.Subscribe selector={(s) => s.values.title.trim() !== "" && !s.isSubmitting}>
          {(ready) => (
            <Key go type="submit" disabled={!ready}>
              Save
            </Key>
          )}
        </form.Subscribe>
      </header>

      <Section label="Item">
        <li className="list-none">
          {id === null && (
            <form.Field name="kind">
              {(field) => (
                <Line label="Kind">
                  <select
                    value={field.state.value}
                    onChange={(e) => {
                      const next = KINDS.find((k) => k === e.target.value)
                      if (next) {
                        field.handleChange(next)
                        // Its template's fields, keeping what was typed into any the kinds share.
                        const typed = form.getFieldValue("fields")
                        form.setFieldValue(
                          "fields",
                          templateOf(next).map((f) => typed.find((t) => t.id === f.id) ?? f),
                        )
                      }
                    }}
                    className={`${SELECT} flex-1 pl-0 text-ui text-ink`}
                  >
                    {KINDS.filter((k) => k !== "file").map((k) => (
                      <option key={k} value={k}>
                        {KIND_NAMES[k]}
                      </option>
                    ))}
                  </select>
                </Line>
              )}
            </form.Field>
          )}
          <form.Field name="name">
            {(field) => (
              <Line label="Name">
                <input
                  placeholder="From title"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value.toLowerCase())
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Line>
            )}
          </form.Field>
        </li>
      </Section>

      <Section label="Fields">
        <form.Field name="fields" mode="array">
          {(fields) => (
            <li className="list-none">
              {fields.state.value.map((f, i) => (
                <div key={f.id} className="flex h-line items-center hairline-b">
                  <form.Field name={`fields[${i}].label`}>
                    {(label) => (
                      <input
                        aria-label="Label"
                        value={label.state.value}
                        onChange={(e) => {
                          label.handleChange(e.target.value)
                        }}
                        className="selectable h-full w-label flex-none border-0 bg-transparent px-inset text-small text-ink2 outline-none"
                      />
                    )}
                  </form.Field>
                  <form.Field name={`fields[${i}].value`}>
                    {(value) => (
                      <>
                        <input
                          aria-label={f.label}
                          type={CONCEALED.has(f.type) && f.type !== "totp" ? "password" : "text"}
                          placeholder={f.kept ? DOTS : ""}
                          autoComplete="off"
                          spellCheck={false}
                          value={value.state.value}
                          onChange={(e) => {
                            value.handleChange(e.target.value)
                          }}
                          className={`${INPUT} ${CONCEALED.has(f.type) ? "font-mono" : ""}`}
                        />
                        <span className="flex flex-none items-center gap-1 pr-inset">
                          {f.kept && value.state.value === "" && (
                            <Flat
                              disabled={reveal.isPending}
                              onClick={() => {
                                reveal.mutate(f.id, { onSuccess: value.handleChange })
                              }}
                            >
                              Reveal
                            </Flat>
                          )}
                          {(f.type === "password" ||
                            f.type === "pin" ||
                            f.type === "concealed") && <GeneratePop onUse={value.handleChange} />}
                          <Flat
                            onClick={() => {
                              fields.removeValue(i)
                            }}
                          >
                            ×
                          </Flat>
                        </span>
                      </>
                    )}
                  </form.Field>
                </div>
              ))}
              <div className="flex h-line items-center">
                <form.Field name="newLabel">
                  {(label) => (
                    <input
                      aria-label="New field"
                      placeholder="Add field"
                      value={label.state.value}
                      onChange={(e) => {
                        label.handleChange(e.target.value)
                      }}
                      className="selectable h-full w-label flex-none border-0 bg-transparent px-inset text-small text-ink outline-none"
                    />
                  )}
                </form.Field>
                <form.Field name="newType">
                  {(type) => (
                    <select
                      aria-label="Type"
                      value={type.state.value}
                      onChange={(e) => {
                        const t = FIELD_TYPES.find((x) => x === e.target.value)
                        if (t) {
                          type.handleChange(t)
                        }
                      }}
                      className={`${SELECT} min-w-0 flex-1 pl-0`}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  )}
                </form.Field>
                <form.Subscribe selector={(s) => s.values.newLabel.trim() !== ""}>
                  {(ready) => (
                    <span className="pr-inset">
                      <Key
                        disabled={!ready}
                        onClick={() => {
                          const label = form.getFieldValue("newLabel").trim()
                          fields.pushValue({
                            id: idFor(label, fields.state.value),
                            label,
                            type: form.getFieldValue("newType"),
                            value: "",
                            kept: false,
                          })
                          form.setFieldValue("newLabel", "")
                        }}
                      >
                        Add
                      </Key>
                    </span>
                  )}
                </form.Subscribe>
              </div>
            </li>
          )}
        </form.Field>
      </Section>

      <Section label="URLs">
        <form.Field name="urls" mode="array">
          {(urls) => (
            <li className="list-none">
              {urls.state.value.map((u, i) => (
                <div key={u.key} className="flex h-line items-center hairline-b">
                  <form.Field name={`urls[${i}].match`}>
                    {(match) => (
                      <select
                        aria-label="Match"
                        value={match.state.value}
                        onChange={(e) => {
                          const m = MATCHES.find((x) => x === e.target.value)
                          if (m) {
                            match.handleChange(m)
                          }
                        }}
                        className={`${SELECT} w-label`}
                      >
                        <option value="domain">Domain</option>
                        <option value="host">Host</option>
                        <option value="exact">Exact</option>
                      </select>
                    )}
                  </form.Field>
                  <form.Field name={`urls[${i}].url`}>
                    {(url) => (
                      <input
                        aria-label="URL"
                        placeholder="https://"
                        value={url.state.value}
                        onChange={(e) => {
                          url.handleChange(e.target.value)
                        }}
                        className={INPUT}
                      />
                    )}
                  </form.Field>
                  <span className="pr-inset">
                    <Flat
                      onClick={() => {
                        urls.removeValue(i)
                      }}
                    >
                      ×
                    </Flat>
                  </span>
                </div>
              ))}
              <div className="flex h-line items-center px-inset">
                <Key
                  onClick={() => {
                    urls.pushValue({ key: crypto.randomUUID(), url: "", match: "domain" })
                  }}
                >
                  Add URL
                </Key>
              </div>
            </li>
          )}
        </form.Field>
      </Section>

      <Section label="Notes">
        <form.Field name="notes">
          {(notes) => (
            <li className="flex list-none items-start">
              <textarea
                aria-label="Notes"
                placeholder={form.getFieldValue("notesKept") ? DOTS : "Notes"}
                value={notes.state.value}
                onChange={(e) => {
                  notes.handleChange(e.target.value)
                }}
                rows={5}
                className="selectable min-h-[120px] min-w-0 flex-1 resize-y border-0 bg-transparent px-inset py-2.5 text-ui text-ink outline-none"
              />
              {form.getFieldValue("notesKept") && notes.state.value === "" && (
                <span className="py-1.5 pr-inset">
                  <Flat
                    disabled={reveal.isPending}
                    onClick={() => {
                      reveal.mutate(NOTES, { onSuccess: notes.handleChange })
                    }}
                  >
                    Reveal
                  </Flat>
                </span>
              )}
            </li>
          )}
        </form.Field>
      </Section>

      <Section label="Filed">
        <li className="list-none">
          <form.Field name="folder">
            {(field) => (
              <Line label="Folder">
                <input
                  placeholder="None"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value)
                  }}
                  className={INPUT}
                />
              </Line>
            )}
          </form.Field>
          <form.Field name="tags">
            {(field) => (
              <Line label="Tags">
                <input
                  placeholder="None"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value)
                  }}
                  className={INPUT}
                />
              </Line>
            )}
          </form.Field>
          <form.Field name="spaces">
            {(field) => (
              <Line label="Spaces">
                <input
                  placeholder="Every space"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value)
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Line>
            )}
          </form.Field>
          <form.Field name="favorite">
            {(field) => (
              <Line label="Favorite">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.checked)
                  }}
                  className="size-4 accent-current"
                />
              </Line>
            )}
          </form.Field>
        </li>
      </Section>
    </form>
  )
}
