import { useMutation } from "@tanstack/react-query"
import { Schema } from "effect"

import type { Action } from "../brain/items.ts"
import { verifyConnection } from "./connections.ts"
import { ActionError } from "./action-error.tsx"
import { Button } from "./kit/button.tsx"

const decode = Schema.decodeUnknownOption(
  Schema.Struct({ provider: Schema.String, account: Schema.optionalKey(Schema.String) }),
)

export const ConnectionVerify = ({ action }: { action: Action }) => {
  const verify = useMutation(verifyConnection)
  const input = decode(action.args)
  if (input._tag === "None") {
    return null
  }
  return (
    <>
      <Button
        look="key"
        disabled={verify.isPending}
        onClick={() => {
          verify.mutate(input.value)
        }}
      >
        Check sign-in
      </Button>
      {verify.isError && <ActionError error={verify.error} />}
      {verify.isSuccess && !verify.data && (
        <p role="alert" className="basis-full text-small text-red">
          Not signed in; finish sign-in and check again.
        </p>
      )}
      {verify.isSuccess && verify.data && (
        <output className="text-small text-ink2">Connected</output>
      )}
    </>
  )
}
