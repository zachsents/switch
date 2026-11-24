// A reply on an item: words to the work that raised it, posted in its space with the item named.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Textarea } from "@ui-sdk/react/textarea"

import { useRef } from "react"

import { replyForm } from "../brain/forms.ts"
import { replyMutation } from "../brain/item-mutations.ts"
import type { ActionItem } from "../brain/items.ts"
import { FIELD } from "./ask-answer.tsx"
import { ActionError } from "./action-error.tsx"
import { Button } from "./kit/button.tsx"

export const AskReply = ({ item, onSent }: { item: ActionItem; onSent: () => void }) => {
  const reply = useMutation(replyMutation)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const form = useForm({
    defaultValues: { text: "" },
    validators: { onChange: replyForm, onSubmit: replyForm },
    onSubmit: ({ value, formApi }) => {
      reply.mutate(
        { space: item.space, text: value.text.trim(), item: item.id },
        {
          onSuccess: () => {
            formApi.reset()
            onSent()
          },
          onError: () => {
            input.current?.focus()
          },
        },
      )
    },
  })
  const submit = () => {
    void form.handleSubmit()
  }
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <form.Field name="text">
        {(field) => (
          <Textarea
            ref={input}
            readOnly={reply.isPending}
            autoFocus
            autoResize
            rows={1}
            name={field.name}
            value={field.state.value}
            onValueChange={field.handleChange}
            onBlur={field.handleBlur}
            submitShortcut="enter"
            onSubmit={submit}
            placeholder="Reply…"
            aria-label="Reply"
            className={`${FIELD} max-h-40 flex-1`}
          />
        )}
      </form.Field>
      {reply.isError && <ActionError error={reply.error} />}
      <form.Subscribe selector={(s) => s.values.text.trim() !== "" && s.canSubmit}>
        {(ready) => (
          <Button look="key" type="submit" disabled={!ready || reply.isPending}>
            Send
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
