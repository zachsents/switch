// ⌘K: spaces, and what was said or kept that holds the words. Its input is a TanStack Form field;
// a new space it makes is a mutation, shown at once.
import type { SpaceId } from "@switch/brain"
import { Combobox } from "@base-ui/react/combobox"
import { Dialog } from "@base-ui/react/dialog"
import { useForm, useSelector } from "@tanstack/react-form"
import { useId } from "react"
import { useDebouncedValue } from "@tanstack/react-pacer"
import { useMutation, useQuery } from "@tanstack/react-query"

import { findQuery } from "../brain/find.ts"
import { findForm } from "../brain/forms.ts"
import { actMutation } from "../brain/mutations.ts"
import { useBrain } from "../brain/use-brain.ts"
import { groups } from "./palette-choices.tsx"
import type { Choice, Group } from "./palette-choices.tsx"
import { FLOAT } from "./kit/float.ts"

export const Palette = ({
  here,
  open,
  onOpenChange,
}: {
  here: SpaceId
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const acting = useMutation(actMutation)
  const form = useForm({ defaultValues: { query: "" }, validators: { onChange: findForm } })
  const close = () => {
    onOpenChange(false)
  }
  const choose = (c: Choice | null) => {
    if (!c) {
      return
    }
    c.go?.()
    if (c.act) {
      acting.mutate(c.act, { onSuccess: close })
    } else {
      close()
    }
  }
  const { error } = acting
  const query = useSelector(form.store, (f) => f.values.query)
  const [settled] = useDebouncedValue(query.trim(), { wait: 150 })
  const found = useQuery({ ...findQuery(settled), enabled: open && settled !== "" })
  const hits = settled === "" ? [] : (found.data ?? [])
  const items = useBrain((s) => (open ? groups(s, here, query, hits) : []))
  const { contains } = Combobox.useFilter()
  const input = useId()
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        form.reset()
        acting.reset()
        onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0" />
        <Dialog.Popup
          className={`${FLOAT} fixed top-[72px] left-1/2 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2`}
        >
          <Dialog.Title className="sr-only">Find</Dialog.Title>
          <form.Field name="query">
            {(field) => (
              <Combobox.Root
                inline
                open={open}
                items={items}
                inputValue={field.state.value}
                onInputValueChange={field.handleChange}
                autoHighlight
                itemToStringLabel={(c: Choice) => `${c.label} ${c.also}`}
                // What the brain found holds the words already, if not as typed.
                filter={(c: Choice, q, label) => c.found === true || contains(c, q, label)}
                onValueChange={choose}
              >
                <label htmlFor={input} className="flex h-11 cursor-text items-center px-3 line-1-b">
                  <Combobox.Input
                    id={input}
                    placeholder="Find…"
                    aria-label="Find"
                    className="w-full border-0 bg-transparent p-0 text-read text-ink outline-none"
                  />
                </label>
                {error && (
                  <div className="flex h-line items-center px-3 text-small text-red line-2-b">
                    {error.message || "Didn't go through"}
                  </div>
                )}
                <Combobox.Empty className="flex h-line items-center px-3 text-ui text-ink2 empty:hidden">
                  Nothing
                </Combobox.Empty>
                <Combobox.List className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain scroll-py-8 empty:hidden">
                  {(group: Group) => (
                    <Combobox.Group key={group.value} items={group.items}>
                      <Combobox.GroupLabel className="flex h-line items-center px-3 text-small font-semibold text-ink2">
                        {group.value}
                      </Combobox.GroupLabel>
                      <Combobox.Collection>
                        {(c: Choice) => (
                          <Combobox.Item
                            key={c.key}
                            value={c}
                            className="flex h-line items-center gap-2 px-3 text-ui outline-none select-none data-highlighted:lit"
                          >
                            <span className="flex w-[18px] flex-none justify-center">{c.icon}</span>
                            <span className="trim min-w-0 truncate">{c.label}</span>
                          </Combobox.Item>
                        )}
                      </Combobox.Collection>
                    </Combobox.Group>
                  )}
                </Combobox.List>
              </Combobox.Root>
            )}
          </form.Field>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
