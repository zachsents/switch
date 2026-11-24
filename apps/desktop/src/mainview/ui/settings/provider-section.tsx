// A provider (T3 Code's provider card, laid flat): its CLI, each of its accounts on a line, and the
// models they offer; Add account for a provider that keeps logins in homes makes one at the core,
// for every machine, and starts its sign-in on its row.
import { isLoginProvider } from "@switch/models"
import { useMutation } from "@tanstack/react-query"

import { addAccount } from "../../brain/providers.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Spin } from "../marks.tsx"
import { AccountRow } from "./account-row.tsx"
import { ProviderCli } from "./provider-cli.tsx"
import { ProviderModels } from "./provider-models.tsx"
import { providerLabel } from "./role-choices.ts"
import { Group } from "./setting.tsx"
import type { ProviderSectionData } from "./use-providers.ts"

/** Its rows' labels' width. */
const W = "w-48"

export const ProviderSection = ({ section }: { section: ProviderSectionData }) => {
  const adding = useMutation(addAccount)
  const { provider, cli, rows, models } = section
  const label = provider === "acp" ? section.key : providerLabel(provider)
  return (
    <Group
      label={label}
      action={
        isLoginProvider(provider) && (
          <Button
            look="flat"
            disabled={adding.isPending}
            onClick={() => {
              adding.mutate({ provider, signIn: cli !== undefined && cli.version !== "" })
            }}
          >
            {adding.isPending && <Spin />}
            Add account
          </Button>
        )
      }
    >
      {cli && <ProviderCli cli={cli} w={W} />}
      {rows.map((r) => (
        <AccountRow key={r.account.id} {...r} w={W} />
      ))}
      {adding.error && <ActionError error={adding.error} />}
      {models.length > 0 && <ProviderModels models={models} />}
    </Group>
  )
}
