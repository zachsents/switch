// The code a sign-in page gives back, typed here once and never kept: Continue hands it to the core.
import type { AccountView } from "@switch/core/account-schema"
import { useForm } from "@tanstack/react-form"
import { useRef } from "react"

import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { accountAction, useAccountAction } from "./use-account-action.ts"

export const AccountCompletion = ({ account }: { account: AccountView }) => {
  const secret = useRef("")
  const completing = useAccountAction(async () => {
    const code = secret.current
    secret.current = ""
    await accountAction(account.id, "complete", { flowId: account.flow?.flowId, code })
  })
  const form = useForm({
    defaultValues: { code: "" },
    onSubmit: async ({ value }) => {
      secret.current = value.code.trim()
      form.reset()
      await completing.mutateAsync().catch(() => {
        secret.current = ""
      })
    },
  })
  return (
    <form
      className="flex min-w-0 basis-full flex-wrap items-center gap-2"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="code">
        {(field) => (
          <input
            aria-label={`${account.id} sign-in code`}
            type="password"
            autoComplete="off"
            placeholder="Code"
            className="h-key min-w-0 flex-1 border-0 bg-transparent px-1.5 text-ui text-ink outline-none select-text"
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
            }}
            onBlur={field.handleBlur}
          />
        )}
      </form.Field>
      <Button type="submit" look="go" disabled={completing.isPending}>
        Continue
      </Button>
      {completing.error && <ActionError error={completing.error} />}
    </form>
  )
}
