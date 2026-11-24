// Providers (T3 Code's provider settings): each provider with its CLI, its accounts, each once
// whichever machines it's signed in on, and its models. Refresh asks every provider (and the ACP
// Registry) again; Add provider, last, adds one not set up yet at the core.
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { accountsQuery } from "../../brain/accounts.ts"
import { useAuth } from "../../brain/auth.ts"
import { modelsQuery } from "../../brain/models.ts"
import { registryQuery } from "../../brain/providers.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Spin } from "../marks.tsx"
import { PaneScroll } from "../pane-scroll.tsx"
import { ProviderAdd } from "./provider-add.tsx"
import { ProviderSection } from "./provider-section.tsx"
import { useProviders } from "./use-providers.ts"

const Refresh = ({ ready }: { ready: boolean }) => {
  const client = useQueryClient()
  const refreshing = useIsFetching({ queryKey: modelsQuery.queryKey }) > 0
  return (
    <Button
      look="flat"
      disabled={refreshing || !ready}
      onClick={() => {
        void client.refetchQueries({ queryKey: accountsQuery.queryKey })
        void client.refetchQueries({ queryKey: modelsQuery.queryKey })
        void client.invalidateQueries({ queryKey: registryQuery.queryKey })
      }}
    >
      {refreshing && <Spin />}
      <span className="trim">Refresh</span>
    </Button>
  )
}

export const ProvidersSettings = () => {
  const auth = useAuth()
  const ready = auth !== null && "token" in auth
  const models = useQuery({ ...modelsQuery, enabled: ready })
  const [adding, setAdding] = useState(false)
  const { query, accounts, clis, sections } = useProviders(ready, models.data?.accounts ?? [])
  const error = query.error ?? models.error
  return (
    <PaneScroll className="flex-1">
      <div className="flex h-line items-center gap-2 px-inset line-2-b">
        <span className="flex-1" />
        <Refresh ready={ready} />
      </div>
      {error && (
        <div className="flex px-inset py-2 line-2-b">
          <ActionError error={error} />
        </div>
      )}
      {ready && query.isPending && (
        <div className="flex h-line items-center px-inset text-ui text-ink2 line-2-b">
          <span className="trim">Loading</span>
        </div>
      )}
      {sections.map((s) => (
        <ProviderSection key={s.key} section={s} />
      ))}
      {ready &&
        (adding ? (
          <ProviderAdd
            accounts={accounts.filter((a) => a.machine === clis.at(0)?.machine)}
            clis={clis}
            onCancel={() => {
              setAdding(false)
            }}
          />
        ) : (
          <div className="flex line-2-b">
            <Button
              look="row"
              onClick={() => {
                setAdding(true)
              }}
            >
              <span className="trim text-ink2">Add provider</span>
            </Button>
          </div>
        ))}
    </PaneScroll>
  )
}
