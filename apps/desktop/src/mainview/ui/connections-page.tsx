// Connections: the accounts extensions use, a line each, by provider: its account and scopes,
// Disconnect under the pointer; a provider with none (or that takes more) has Connect. Below them,
// the devices, hosts and extensions paired.
import { useMutation } from "@tanstack/react-query"

import { useBrain } from "../brain/use-brain.ts"
import { connectMutation, disconnectMutation, useNeeds, cancelConnection } from "./connections.ts"
import { Warn } from "./marks.tsx"
import { ActionError } from "./action-error.tsx"
import { Section, Tip } from "./parts.tsx"
import { PaneScroll } from "./pane-scroll.tsx"
import { Button } from "./kit/button.tsx"

/** A scope as a word: Google's `…/auth/calendar` is "calendar". */
const word = (scope: string) => scope.split("/auth/").at(-1) ?? scope

const line = "group/line flex h-line items-center gap-2.5 px-inset text-ui text-ink hover:lit"

/** The provider's name, in a column of its own. */
const Provider = ({ children }: { children: string }) => (
  <span className="w-48 flex-none truncate font-medium">{children}</span>
)

export const ConnectionsPage = () => {
  const needs = useNeeds()
  const connecting = useMutation(connectMutation)
  const disconnecting = useMutation(disconnectMutation)
  const error = connecting.error ?? disconnecting.error
  const all = useBrain((s) => [...s.extra.connections.values()])
  const providers = [...new Set([...needs.map((n) => n.provider), ...all.map((c) => c.provider)])]
  return (
    <PaneScroll className="flex-1 bg-bg">
      {error && (
        <div className="flex min-h-line items-center px-inset py-2 text-small text-ink line-2-b">
          <ActionError error={error} />
        </div>
      )}
      {connecting.isPending && (
        <div className="flex h-line items-center px-inset">
          <Button
            look="flat"
            onClick={() => {
              cancelConnection(connecting.variables.provider)
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      <Section label="Accounts" count={all.length}>
        {providers.flatMap((p) => {
          const need = needs.find((n) => n.provider === p)
          const label = need?.label ?? p
          const mine = all.filter((c) => c.provider === p)
          const rows = mine.map((c) => {
            const missing =
              need?.kind === "oauth" ? need.scopes.filter((x) => !c.scopes.includes(x)) : []
            return (
              <li key={c.id} className={line}>
                <Provider>{label}</Provider>
                {c.scopes.length > 0 ? (
                  <Tip label={c.scopes.map(word).join(" ")}>
                    <span className="min-w-0 truncate text-ink2">{c.account}</span>
                  </Tip>
                ) : (
                  <span className="min-w-0 truncate text-ink2">{c.account}</span>
                )}
                {missing.length > 0 && (
                  <Tip label={`Missing ${missing.map(word).join(" ")}`}>
                    <span className="flex flex-none">
                      <Warn />
                    </span>
                  </Tip>
                )}
                {missing.length > 0 && (
                  <span className="flex flex-none">
                    <Button
                      look="go"
                      disabled={connecting.isPending}
                      onClick={() => {
                        connecting.mutate({ provider: p, account: c.account })
                      }}
                    >
                      Connect
                    </Button>
                  </span>
                )}
                <span className="invisible ml-auto flex flex-none group-hover/line:visible focus-within:visible">
                  <Button
                    look="danger"
                    onClick={() => {
                      disconnecting.mutate(c.id)
                    }}
                  >
                    Disconnect
                  </Button>
                </span>
              </li>
            )
          })
          if (need?.kind === "session" && mine.length === 0) {
            // Its extension holds the sign-in.
            rows.push(
              <li key={`${p}:new`} className={line}>
                <Provider>{label}</Provider>
                <span className="trim ml-auto min-w-0 truncate pl-3 text-right text-caption text-ink2">
                  {need.apps.join(" ")}
                </span>
                <Button
                  look="go"
                  disabled={connecting.isPending}
                  onClick={() => {
                    connecting.mutate({ provider: p })
                  }}
                >
                  Sign in
                </Button>
              </li>,
            )
          } else if (need?.kind !== "session" && (mine.length === 0 || need?.multiple === true)) {
            rows.push(
              <li key={`${p}:new`} className={line}>
                <Provider>{label}</Provider>
                <span className="flex-1" />
                <Button
                  look={mine.length === 0 ? "go" : "key"}
                  disabled={connecting.isPending}
                  onClick={() => {
                    connecting.mutate({ provider: p })
                  }}
                >
                  Connect
                </Button>
              </li>,
            )
          }
          return rows
        })}
      </Section>
    </PaneScroll>
  )
}
