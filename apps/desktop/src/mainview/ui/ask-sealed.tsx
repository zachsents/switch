// A sealed item's field: what's typed is sealed on this Mac to the item's one-time key and only
// the sealed bytes leave. Nothing of it is held: the field clears once it's sent, and there's no
// Undo.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"

import { sealedMutation } from "../brain/item-mutations.ts"
import type { ActionItem } from "../brain/items.ts"
import { Stop } from "./marks.tsx"
import { FIELD } from "./ask-answer.tsx"
import { Button } from "./kit/button.tsx"

const secretForm = Schema.toStandardSchemaV1(
  Schema.Struct({ secret: Schema.String.check(Schema.isMinLength(1)) }),
)

export const AskSealed = ({ item }: { item: ActionItem }) => {
  const sending = useMutation(sealedMutation)
  const form = useForm({
    defaultValues: { secret: "" },
    validators: { onChange: secretForm, onSubmit: secretForm },
    onSubmit: ({ value, formApi }) => {
      sending.mutate({ item, secret: value.secret })
      formApi.reset()
    },
  })
  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      {sending.isError && (
        <div className="flex h-line items-center gap-2 text-small text-ink">
          <Stop size={12} />
          {sending.error.message}
        </div>
      )}
      <div className="flex items-center gap-2">
        <form.Field name="secret">
          {(field) => (
            <input
              type="password"
              name={field.name}
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              aria-label={item.sealed?.use ?? "Secret"}
              placeholder={item.sealed?.use ?? "Secret"}
              className={`${FIELD} min-w-0 flex-1`}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.canSubmit && s.values.secret !== ""}>
          {(ready) => (
            <Button look="go" type="submit" disabled={!ready || sending.isPending}>
              Send
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}
