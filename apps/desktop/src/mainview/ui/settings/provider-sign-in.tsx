// An account added here, signed in from here, on its row (T3 Code's account row): Sign in opens the provider's
// sign-in page in the browser. Claude's page gives a code back, typed in the field under it; a
// device sign-in (Codex's, FX's) shows its code here to type on the page, and is done when the page
// has it. Signed in, Change account or Sign out. Accounts a CLI holds by itself sign in through that
// CLI.
import type { AccountView } from "@switch/core/account-schema"

import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { AccountCompletion } from "./account-completion.tsx"
import { accountAction, useAccountAction } from "./use-account-action.ts"

const startLabel = (starting: boolean, signedIn: boolean) => {
  if (starting) {
    return "Starting"
  }
  return signedIn ? "Change account" : "Sign in"
}

export const ProviderSignIn = ({
  account,
  ready,
}: {
  account: AccountView
  /** Its CLI is there to sign in with. */
  ready: boolean
}) => {
  const starting = useAccountAction(async () => await accountAction(account.id, "start"))
  const cancelling = useAccountAction(
    async () => await accountAction(account.id, "cancel", { flowId: account.flow?.flowId }),
  )
  const signingOut = useAccountAction(async () => await accountAction(account.id, "signout"))
  const busy = starting.isPending || cancelling.isPending || signingOut.isPending
  const error = starting.error ?? cancelling.error ?? signingOut.error
  const signedIn = account.status === "connected" || account.status === "limited"
  const { flow } = account
  return (
    <>
      {flow === null ? (
        <Button
          look={signedIn ? "key" : "go"}
          disabled={busy || !ready}
          onClick={() => {
            starting.mutate()
          }}
        >
          {startLabel(starting.isPending, signedIn)}
        </Button>
      ) : (
        <>
          <Button
            look="key"
            onClick={() => {
              window.open(flow.url, "_blank", "noreferrer")
            }}
          >
            Open browser
          </Button>
          <Button
            look="flat"
            disabled={busy}
            onClick={() => {
              cancelling.mutate()
            }}
          >
            Cancel
          </Button>
          {flow.code === "" && <AccountCompletion key={flow.flowId} account={account} />}
        </>
      )}
      {signedIn && flow === null && (
        <Button
          look="key"
          disabled={busy || !ready}
          onClick={() => {
            signingOut.mutate()
          }}
        >
          Sign out
        </Button>
      )}
      {flow !== null && flow.code !== "" && (
        <span className="trim font-mono text-data text-ink selectable">{flow.code}</span>
      )}
      {error && <ActionError error={error} />}
    </>
  )
}
