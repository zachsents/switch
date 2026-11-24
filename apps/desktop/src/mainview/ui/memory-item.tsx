// One memory on the memory page: its line, and opened, its words to edit, Save and Forget.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"
import { useState } from "react"
import type { KeyboardEvent } from "react"

import { editMemoryMutation, forgetMutation } from "../brain/mutations.ts"
import type { MemoryRow } from "../brain/system.ts"
import { Data } from "./parts.tsx"
import { Button } from "./kit/button.tsx"

const filled = Schema.String.check(Schema.makeFilter((s: string) => s.trim() !== ""))
const memoryForm = Schema.toStandardSchemaV1(Schema.Struct({ description: filled, body: filled }))

const Editor = ({ m, close }: { m: MemoryRow; close: () => void }) => {
  const edit = useMutation(editMemoryMutation)
  const forget = useMutation(forgetMutation)
  const form = useForm({
    defaultValues: { description: m.description, body: m.body },
    validators: { onSubmit: memoryForm },
    onSubmit: ({ value }) => {
      edit.mutate({ id: m.id, ...value }, { onSuccess: close })
    },
  })
  const error = edit.error ?? forget.error
  const escape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close()
    }
  }
  return (
    <form
      className="flex flex-col line-1-b"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="description">
        {(field) => (
          <input
            autoFocus
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
            }}
            onBlur={field.handleBlur}
            onKeyDown={escape}
            aria-label="Line"
            className="h-line border-0 bg-transparent px-inset text-ui text-ink outline-none select-text line-2-b"
          />
        )}
      </form.Field>
      <form.Field name="body">
        {(field) => (
          <textarea
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
            }}
            onBlur={field.handleBlur}
            onKeyDown={escape}
            aria-label="Body"
            rows={Math.min(14, Math.max(4, field.state.value.split("\n").length + 1))}
            className="resize-none border-0 bg-transparent px-inset py-2 text-read text-ink outline-none select-text"
          />
        )}
      </form.Field>
      <div className="flex h-line items-center gap-2.5 px-inset hairline-t">
        {error && <span className="min-w-0 truncate text-small text-red">{error.message}</span>}
        <span className="ml-auto" />
        <Button
          look="key"
          disabled={forget.isPending}
          onClick={() => {
            forget.mutate({ id: m.id })
          }}
        >
          Forget
        </Button>
        <Button look="key" onClick={close}>
          Cancel
        </Button>
        <form.Subscribe selector={(f) => f.canSubmit}>
          {(can) => (
            <Button look="go" type="submit" disabled={!can || edit.isPending}>
              Save
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}

export const MemoryItem = ({ m }: { m: MemoryRow }) => {
  const [open, setOpen] = useState(false)
  return (
    <li>
      {open ? (
        <Editor
          m={m}
          close={() => {
            setOpen(false)
          }}
        />
      ) : (
        <Button
          look="bare"
          title={m.body}
          onClick={() => {
            setOpen(true)
          }}
          className="flex h-line w-full items-center gap-2.5 bg-transparent px-inset text-left text-ui text-ink outline-none hover:lit focus-visible:focused"
        >
          <span className="min-w-0 flex-1 truncate">{m.description || m.id}</span>
          {m.uses > 0 && <Data>{m.uses}</Data>}
        </Button>
      )}
    </li>
  )
}
