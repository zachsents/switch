// Add provider (T3 Code's add-provider steps, on one pane), for one not set up on the core's machine
// yet: a subscription, its own login added, with the CLI it runs on; or an agent from the ACP
// Registry and how it's installed. More accounts of a provider are added in its section.
import type { AccountView, CliView } from "@switch/core/account-schema"
import { PROVIDER_LAUNCHES, SUBSCRIPTIONS } from "@switch/models"
import { useForm, useSelector } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"

import { addProvider, registryQuery } from "../../brain/providers.ts"
import type { Adding } from "../../brain/providers.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Pick } from "../kit/pick.tsx"
import { Select } from "../kit/select.tsx"
import { Spin } from "../marks.tsx"
import { ProviderCli } from "./provider-cli.tsx"
import { Group, Setting } from "./setting.tsx"

/** A registry agent's value among the providers. */
const AGENT = "acp:"
const W = "w-48"

interface Values {
  readonly provider: string
  readonly distribution: string
}

export const ProviderAdd = ({
  accounts,
  clis,
  onCancel,
}: {
  /** The core's own machine's. */
  accounts: readonly AccountView[]
  clis: readonly (typeof CliView.Type)[]
  onCancel: () => void
}) => {
  const registry = useQuery(registryQuery)
  const adding = useMutation(addProvider)
  const subscriptions = SUBSCRIPTIONS.filter(
    (s) => s !== "acp" && !accounts.some((a) => a.provider === s),
  )
  const agents = (registry.data?.agents ?? []).filter(
    (a) => !accounts.some((x) => x.id === `acp-${a.id}`),
  )
  const agentOf = (provider: string) =>
    agents.find((a) => provider.startsWith(AGENT) && a.id === provider.slice(AGENT.length))
  const addingOf = (value: Values): Adding | null => {
    const agent = agentOf(value.provider)
    if (agent) {
      const { distribution } = value
      return { kind: "agent", agentId: agent.id, version: agent.version, distribution }
    }
    const provider = subscriptions.find((s) => s === value.provider)
    return provider === undefined ? null : { kind: "provider", provider }
  }
  const form = useForm({
    defaultValues: { provider: subscriptions[0] ?? "", distribution: "" } satisfies Values,
    onSubmit: ({ value }) => {
      const next = addingOf(value)
      if (next) {
        adding.mutate(next, { onSuccess: onCancel })
      }
    },
  })
  const provider = useSelector(form.store, (s) => s.values.provider)
  const agent = agentOf(provider)
  const cli = clis.find((c) => c.provider === provider)
  const error = adding.error ?? registry.error
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <Group
        label="Add provider"
        action={
          <Button look="flat" onClick={onCancel}>
            Cancel
          </Button>
        }
      >
        <form.Field name="provider">
          {(field) => (
            <Setting label="Provider" w={W}>
              <Pick
                label="Provider"
                value={field.state.value}
                options={[
                  ...subscriptions.map((s) => ({ value: s, label: PROVIDER_LAUNCHES[s].label })),
                  ...agents.map((a) => ({
                    value: `${AGENT}${a.id}`,
                    label: `${a.name} ${a.version}`,
                    group: "ACP Registry",
                  })),
                ]}
                onChange={(next) => {
                  field.handleChange(next)
                  form.setFieldValue("distribution", agentOf(next)?.distributions[0] ?? "")
                }}
              />
            </Setting>
          )}
        </form.Field>
        {agent && (
          <form.Field name="distribution">
            {(field) => (
              <Setting label="Distribution" w={W}>
                <Select
                  label="Distribution"
                  value={field.state.value}
                  options={agent.distributions.map((d) => ({ value: d, label: d }))}
                  onChange={field.handleChange}
                />
              </Setting>
            )}
          </form.Field>
        )}
        {cli && <ProviderCli cli={cli} w={W} />}
        <Setting label="" w={W}>
          <Button
            look="go"
            type="submit"
            disabled={addingOf({ provider, distribution: "" }) === null || adding.isPending}
          >
            {adding.isPending && <Spin />}
            <span className="trim">{agent ? "Install" : "Add"}</span>
          </Button>
          {error && <ActionError error={error} />}
        </Setting>
      </Group>
    </form>
  )
}
