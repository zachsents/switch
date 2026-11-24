import type { Action } from "../brain/items.ts"
import { ConnectionVerify } from "./connection-verify.tsx"
import { cancelConnection } from "./connections.ts"
import { Button } from "./kit/button.tsx"

export const ConnectionActions = ({
  action,
  pending,
}: {
  action: Action | undefined
  pending: boolean
}) => {
  if (action?.app !== "connections") {
    return null
  }
  const provider = typeof action.args.provider === "string" ? action.args.provider : null
  return (
    <>
      {pending && provider !== null && (
        <Button
          look="flat"
          onClick={() => {
            cancelConnection(provider)
          }}
        >
          Cancel
        </Button>
      )}
      <ConnectionVerify action={action} />
    </>
  )
}
