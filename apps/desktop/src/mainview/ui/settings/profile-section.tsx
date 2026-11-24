// A profile under its name (T3 Code's text generation model, a role a line): a change keeps at once.
// Duplicate and Edit open it in edit; Remove asks first, and the one in use has none.
import type { ProfilesView } from "@switch/core/profiles"
import { useMutation } from "@tanstack/react-query"

import { saveProfile } from "../../brain/models.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Confirm } from "../kit/confirm.tsx"
import { RoleChoice } from "./role-choice.tsx"
import { EDITABLE, ROLE_LABELS } from "./role-choices.ts"
import { Group, Setting } from "./setting.tsx"

type Profile = (typeof ProfilesView.Type)["profiles"][number]

export const ProfileSection = ({
  profile,
  active,
  accounts,
  removing,
  onDuplicate,
  onEdit,
  onRemove,
}: {
  profile: Profile
  active: boolean
  accounts: (typeof ProfilesView.Type)["accounts"]
  removing: boolean
  onDuplicate: () => void
  onEdit: () => void
  onRemove: () => void
}) => {
  const saving = useMutation(saveProfile)
  return (
    <Group
      label={profile.name}
      action={
        <span className="flex items-center gap-1.5">
          <Button look="flat" onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button look="flat" onClick={onEdit}>
            Edit
          </Button>
          {!active && (
            <Confirm
              act="Remove"
              question={`Remove ${profile.name}?`}
              disabled={removing}
              onConfirm={onRemove}
            />
          )}
        </span>
      }
    >
      {EDITABLE.map((role) => (
        <Setting key={role} label={ROLE_LABELS[role]} w="w-32">
          <RoleChoice
            role={role}
            value={profile.roles[role]}
            accounts={accounts}
            onChange={(choice) => {
              saving.mutate({
                name: profile.name,
                roles: { ...profile.roles, [role]: choice },
                previous: profile.name,
              })
            }}
          />
        </Setting>
      ))}
      {saving.error && (
        <div className="flex px-inset py-2 line-2-b">
          <ActionError error={saving.error} />
        </div>
      )}
    </Group>
  )
}
