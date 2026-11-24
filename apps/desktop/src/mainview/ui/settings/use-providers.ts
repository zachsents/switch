// The provider accounts Settings shows, each once wherever it's signed in: the providers in order,
// each with its CLI at the core (where accounts are added and kept), its accounts (what the catalog
// knows of each and how it stands) and the models they offer. A registry agent is a provider of its
// own. Each account is shown by the email its login reports.
import { accountLabels } from "@switch/core/account-schema"
import type { AccountView } from "@switch/core/account-schema"
import type { Capability } from "@switch/core/profiles"
import { useQuery } from "@tanstack/react-query"

import { accountsQuery } from "../../brain/accounts.ts"
import { ordered, standingOf } from "./accounts.ts"

/** Its provider's section: a registry agent's own. */
const sectionOf = (a: AccountView) => (a.provider === "acp" ? a.id : a.provider)

export const useProviders = (ready: boolean, capabilities: readonly (typeof Capability.Type)[]) => {
  const query = useQuery({ ...accountsQuery, enabled: ready })
  const accounts = query.data?.accounts ?? []
  const clis = query.data?.clis ?? []
  const labels = accountLabels(
    accounts.map((a) => ({
      host: a.id,
      provider: a.provider,
      email: capabilities.find((c) => c.host === a.id)?.email,
    })),
  )
  const rows = ordered(accounts).map((account) => {
    const capability = capabilities.find((c) => c.host === account.id)
    const cli = clis.find((c) => c.provider === account.provider)
    const label = labels.get(account.id) ?? account.id
    return { account, label, cli, standing: standingOf(account, capability, cli) }
  })
  const sections = [...new Set(rows.map((r) => sectionOf(r.account)))].map((key) => {
    const own = rows.filter((r) => sectionOf(r.account) === key)
    const models = own.flatMap(
      (r) => capabilities.find((c) => c.host === r.account.id)?.models ?? [],
    )
    return {
      key,
      provider: own[0]?.account.provider ?? key,
      cli: own.find((r) => r.cli)?.cli,
      rows: own,
      models: [...new Set(models)],
    }
  })
  return { query, accounts, clis, sections }
}

export type ProviderSectionData = ReturnType<typeof useProviders>["sections"][number]
export type AccountRowData = ProviderSectionData["rows"][number]
