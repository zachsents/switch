// A space's name in edit on the band: Enter keeps it, Escape or leaving puts the old one back.
import type { SpaceId } from "@switch/brain"
import { useForm } from "@tanstack/react-form"

import { wordsForm } from "../brain/forms.ts"
import { stopRename, useSpaceActs } from "./spaces.ts"

export const RenameField = ({ id, name }: { id: SpaceId; name: string }) => {
  const acts = useSpaceActs()
  const form = useForm({
    defaultValues: { text: name },
    validators: { onSubmit: wordsForm },
    onSubmit: ({ value }) => {
      acts.rename(id, value.text)
      stopRename()
    },
  })
  return (
    <form
      className="m-0 ml-1.5 flex min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="text">
        {(field) => (
          <input
            ref={(el) => {
              el?.select()
            }}
            name={field.name}
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
            }}
            onBlur={stopRename}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation()
                stopRename()
              }
            }}
            aria-label="Name"
            className="sign electrobun-webkit-app-region-no-drag w-full min-w-0 border-0 bg-transparent p-0 text-title text-ink outline-none"
          />
        )}
      </form.Field>
    </form>
  )
}
