// A profile in edit: its name and each role's model and account. New and Duplicate start from a copy
// of another; Save keeps it, a rename included.
import { NamedProfile } from "@switch/core/profiles"
import type { Capability } from "@switch/core/profiles"
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"

import { saveProfile } from "../../brain/models.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { RoleChoice } from "./role-choice.tsx"
import { copyName, EDITABLE, ROLE_LABELS } from "./role-choices.ts"
import { Group, Setting } from "./setting.tsx"

export const ProfileForm = ({
  profile,
  creating,
  profiles,
  accounts,
  close,
}: {
  profile: typeof NamedProfile.Type
  creating: boolean
  profiles: readonly (typeof NamedProfile.Type)[]
  accounts: readonly (typeof Capability.Type)[]
  close: () => void
}) => {
  const saving = useMutation(saveProfile)
  const form = useForm({
    defaultValues: {
      name: creating ? copyName(profile.name, profiles) : profile.name,
      roles: profile.roles,
    },
    validators: { onChange: Schema.toStandardSchemaV1(Schema.toType(NamedProfile)) },
    onSubmit: ({ value }) => {
      saving.mutate(
        { ...value, ...(!creating && { previous: profile.name }) },
        { onSuccess: close },
      )
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <Group label={creating ? "New profile" : "Edit profile"}>
        <form.Field name="name">
          {(field) => (
            <Setting label="Name" w="w-32">
              <input
                aria-label="Profile name"
                spellCheck={false}
                className="h-key min-w-0 flex-1 border-0 bg-transparent px-1.5 text-ui text-ink outline-none select-text"
                value={field.state.value}
                onChange={(e) => {
                  field.handleChange(e.target.value)
                }}
                onBlur={field.handleBlur}
              />
            </Setting>
          )}
        </form.Field>
        {EDITABLE.map((role) => (
          <form.Field key={role} name={`roles.${role}`}>
            {(field) => (
              <Setting label={ROLE_LABELS[role]} w="w-32">
                <RoleChoice
                  role={role}
                  value={field.state.value}
                  accounts={accounts}
                  onChange={field.handleChange}
                />
              </Setting>
            )}
          </form.Field>
        ))}
        <Setting label="" w="w-32">
          <form.Subscribe selector={(state) => state.canSubmit}>
            {(canSubmit) => (
              <Button look="go" type="submit" disabled={!canSubmit || saving.isPending}>
                Save
              </Button>
            )}
          </form.Subscribe>
          <Button look="flat" onClick={close}>
            Cancel
          </Button>
          {saving.error && <ActionError error={saving.error} />}
        </Setting>
      </Group>
    </form>
  )
}
