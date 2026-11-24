// One role's model, picked under its provider (T3 Code's model picker, by provider), and the account
// it runs on: Auto, or one subscription, by its label. A Gateway model runs on no account.
import { accountLabels } from "@switch/core/account-schema"
import type { Capability, ModelChoice } from "@switch/core/profiles"

import { Pick } from "../kit/pick.tsx"
import { Select } from "../kit/select.tsx"
import { accountChoices, keyOf, modelChoices, providerLabel, ROLE_LABELS } from "./role-choices.ts"
import type { Role } from "./role-choices.ts"

export const RoleChoice = ({
  role,
  value,
  accounts,
  onChange,
  disabled = false,
}: {
  role: Role
  value: typeof ModelChoice.Type
  accounts: readonly (typeof Capability.Type)[]
  onChange: (next: typeof ModelChoice.Type) => void
  disabled?: boolean
}) => {
  const models = modelChoices(role, accounts, value)
  const labels = accountLabels(accounts)
  return (
    <>
      <Pick
        label={`${ROLE_LABELS[role]} model`}
        value={keyOf(value)}
        disabled={disabled}
        options={models.map((m) => ({
          value: keyOf(m),
          label: m.id,
          group: providerLabel(m.provider),
        }))}
        onChange={(key) => {
          const picked = models.find((m) => keyOf(m) === key)
          if (picked) {
            onChange(picked)
          }
        }}
      />
      {value.provider !== "gateway" && (
        <Select
          label={`${ROLE_LABELS[role]} account`}
          value={value.account ?? ""}
          disabled={disabled}
          options={[
            { value: "", label: "Auto" },
            ...accountChoices(role, value, accounts).map((host) => ({
              value: host,
              label: labels.get(host) ?? host,
            })),
          ]}
          onChange={(account) => {
            onChange({ provider: value.provider, id: value.id, ...(account && { account }) })
          }}
        />
      )}
    </>
  )
}
