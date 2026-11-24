// A provider's CLI on the core's machine (T3 Code's runtime row): its version, or Install when it's
// missing and Switch can install it.
import type { CliView } from "@switch/core/account-schema"

import { accountRequest } from "../../brain/accounts.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Setting } from "./setting.tsx"
import { useAccountAction } from "./use-account-action.ts"

export const ProviderCli = ({ cli, w }: { cli: typeof CliView.Type; w: string }) => {
  const installing = useAccountAction(
    async () => await accountRequest(`/auth/cli/${encodeURIComponent(cli.provider)}/install`, {}),
  )
  const missing = cli.command === ""
  return (
    <Setting label="CLI" w={w}>
      <span className="trim min-w-0 truncate font-mono text-data text-ink">
        {cli.version || (missing ? "Missing" : "Unavailable")}
      </span>
      {missing && cli.installable && (
        <Button
          look="key"
          disabled={installing.isPending}
          onClick={() => {
            installing.mutate()
          }}
        >
          {installing.isPending ? "Installing" : "Install"}
        </Button>
      )}
      {missing && !cli.installable && <span className="trim text-ui text-ink">Manual install</span>}
      {installing.error && <ActionError error={installing.error} />}
    </Setting>
  )
}
