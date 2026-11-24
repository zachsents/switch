// An account on its line under its provider (T3 Code's account row): its label, how it stands and how
// much of its limit it has used; for an account added here, its sign-in and Remove, which asks first.
import { ActionError } from "../action-error.tsx"
import { Confirm } from "../kit/confirm.tsx"
import { ProviderSignIn } from "./provider-sign-in.tsx"
import { Setting } from "./setting.tsx"
import { StandingMark } from "./standing-mark.tsx"
import { accountAction, useAccountAction } from "./use-account-action.ts"
import type { AccountRowData } from "./use-providers.ts"

export const AccountRow = ({
  account,
  label,
  standing,
  cli,
  w,
}: AccountRowData & { w: string }) => {
  const removing = useAccountAction(async () => await accountAction(account.id, "remove"))
  return (
    <Setting label={label} w={w}>
      <StandingMark standing={standing} />
      <span className="trim min-w-0 truncate text-ui text-ink">{standing.words}</span>
      {standing.used !== null && (
        <span className="trim text-data tabular-nums text-ink">{standing.used}%</span>
      )}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {account.added && (
          <ProviderSignIn account={account} ready={cli !== undefined && cli.version !== ""} />
        )}
        {account.added && (
          <Confirm
            act="Remove"
            question={`Remove ${label}?`}
            disabled={removing.isPending}
            onConfirm={() => {
              removing.mutate()
            }}
          />
        )}
      </span>
      {removing.error && <ActionError error={removing.error} />}
    </Setting>
  )
}
