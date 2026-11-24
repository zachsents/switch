// Setting what a Pick chose: the extension's tool for it, through the brain's `/widgets`.
import { mutationOptions } from "@tanstack/react-query"

import { callChecked } from "./call.ts"

/** The extension's tool a Pick's Set calls, and what it's always given. */
export interface Call {
  readonly app: string
  readonly tool: string
  readonly args: Record<string, unknown>
}

export const setMutation = mutationOptions({
  mutationKey: ["widget", "set"],
  mutationFn: async ({ call, values }: { call: Call; values: Record<string, string> }) => {
    await callChecked(call.app, call.tool, { ...call.args, ...values })
  },
})
