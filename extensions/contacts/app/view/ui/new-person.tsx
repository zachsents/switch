// ⌘N: a new person, by name and what else is known. Floats over the page, so it's the one rounded
// thing.
import { Dialog } from "@base-ui/react/dialog"
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"

import { newPersonForm } from "../forms.ts"
import { updateMutation } from "../mutations.ts"
import type { Stated } from "../mutations.ts"
import { Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

const FIELDS = [
  { name: "name", label: "Name" },
  { name: "phone", label: "Phone" },
  { name: "email", label: "Email" },
] as const

export const NewPerson = ({
  open,
  onOpenChange,
  onMade,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onMade: (id: string) => void
}) => {
  const create = useMutation(updateMutation)
  const form = useForm({
    defaultValues: { name: "", phone: "", email: "" },
    validators: { onSubmit: newPersonForm },
    onSubmit: async ({ value }) => {
      const add: Stated[] = FIELDS.map((f) => ({
        kind: f.name,
        value: value[f.name].trim(),
      })).filter((f) => f.value !== "")
      const made = await create.mutateAsync({ create: true, add })
      form.reset()
      onOpenChange(false)
      if (made.id !== undefined) {
        onMade(made.id)
      }
    },
  })
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        form.reset()
        create.reset()
        onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-100 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[18%] left-1/2 w-[440px] -translate-x-1/2 overflow-hidden rounded-card bg-overlay shadow-float outline-none">
          <Dialog.Title className="m-0 flex h-head items-center px-inset text-small font-semibold tracking-[0.06em] text-ink uppercase hairline-b">
            New Person
          </Dialog.Title>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            {FIELDS.map((f) => (
              <form.Field key={f.name} name={f.name}>
                {(field) => (
                  <label className="flex h-line items-center hairline-b">
                    <span className="w-label flex-none px-inset text-small text-ink2">
                      {f.label}
                    </span>
                    <input
                      autoFocus={f.name === "name"}
                      value={field.state.value}
                      onChange={(e) => {
                        field.handleChange(e.target.value)
                      }}
                      onBlur={field.handleBlur}
                      className="selectable h-full min-w-0 flex-1 border-0 bg-transparent pr-inset text-ui text-ink outline-none"
                    />
                  </label>
                )}
              </form.Field>
            ))}
            <div className="flex h-head items-center gap-2 px-inset">
              {create.error !== null && (
                <span className="flex min-w-0 items-center gap-2 text-small text-ink">
                  <Stop size={12} />
                  <span className="truncate">{create.error.message}</span>
                </span>
              )}
              <span className="ml-auto flex gap-2">
                <Dialog.Close render={<Key />}>Cancel</Dialog.Close>
                <form.Subscribe selector={(s) => s.values.name.trim() !== "" && !s.isSubmitting}>
                  {(ready) => (
                    <Key go type="submit" disabled={!ready}>
                      Create
                    </Key>
                  )}
                </form.Subscribe>
              </span>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
