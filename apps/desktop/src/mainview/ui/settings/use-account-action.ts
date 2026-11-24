// An account's action on private HTTP; done, the accounts are read again before it settles, and the
// catalog (which asks every provider, so takes a while) after, without holding it up.
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { accountRequest, accountsQuery } from "../../brain/accounts.ts"
import { modelsQuery } from "../../brain/models.ts"

export const useAccountAction = (perform: () => Promise<unknown>) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await perform()
    },
    gcTime: 0,
    onSettled: async () => {
      void client.invalidateQueries({ queryKey: modelsQuery.queryKey })
      await client.invalidateQueries({ queryKey: accountsQuery.queryKey })
    },
  })
}
export const accountAction = async (id: string, action: string, body: unknown = {}) =>
  await accountRequest(`/auth/accounts/${encodeURIComponent(id)}/${action}`, body)
