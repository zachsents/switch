// Devices: pairings waiting (Approve, Deny), then the devices, hosts and extensions that may reach
// the core (Revoke), and a QR that pairs an iPhone at once.
import { useMutation } from "@tanstack/react-query"

import type { Credential } from "../brain/adapter.ts"
import { useBrain } from "../brain/use-brain.ts"
import { approveMutation, denyMutation, offerMutation, revokeMutation } from "./devices.ts"
import { Data, Section } from "./parts.tsx"
import { Qr } from "./qr.tsx"
import { useNow } from "./use-now.ts"
import { Button } from "./kit/button.tsx"

const line = "flex h-line items-center gap-2.5 px-inset text-ui text-ink"

const KINDS = {
  device: "Devices",
  host: "Hosts",
  extension: "Extensions",
  tailnet: "Tailnet",
} as const

export const DevicesSection = () => {
  const approving = useMutation(approveMutation)
  const denying = useMutation(denyMutation)
  const revoking = useMutation(revokeMutation)
  const offering = useMutation(offerMutation)
  const error = approving.error ?? denying.error ?? revoking.error ?? offering.error
  const now = useNow()
  const { all, extensions } = useBrain((s) => ({
    all: [...s.extra.credentials.values()],
    extensions: [...s.extra.extensions.keys()],
  }))
  const waiting = all.filter((c) => c.status === "pending")
  const live = (c: Credential) => c.status === "active" && (c.until === null || c.until > now)
  // An extension's credential has no row until it's revoked: every installed one is live otherwise.
  const revokedExtensions = new Set(all.filter((c) => c.kind === "extension").map((c) => c.name))
  const extensionRows: Credential[] = extensions
    .filter((name) => !revokedExtensions.has(name))
    .map((name) => ({
      id: `extension:${name}`,
      name,
      kind: "extension",
      scopes: [`extension:${name}`],
      status: "active",
      code: null,
      at: 0,
      until: null,
    }))
  const byKind = (kind: string) =>
    [...all.filter(live), ...extensionRows].filter((c) => c.kind === kind)
  const offered = offering.data
  return (
    <>
      {error && (
        <div className="flex h-line items-center px-inset text-small text-ink line-2-b">
          {error.message}
        </div>
      )}
      {waiting.length > 0 && (
        <Section label="Pairing" count={waiting.length}>
          {waiting.map((c) => (
            <li key={c.id} className={line}>
              <span className="min-w-0 truncate">{c.name}</span>
              <Data>{c.code}</Data>
              <Button
                look="danger"
                onClick={() => {
                  denying.mutate(c.id)
                }}
              >
                Deny
              </Button>
              <Button
                look="go"
                onClick={() => {
                  approving.mutate(c.id)
                }}
              >
                Approve
              </Button>
            </li>
          ))}
        </Section>
      )}
      {(["device", "host", "extension", "tailnet"] as const).map((kind) => {
        const rows = byKind(kind)
        return (
          (rows.length > 0 || kind === "device") && (
            <Section key={kind} label={KINDS[kind]} count={rows.length}>
              {rows.map((c) => (
                <li key={c.id} className={line}>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <Button
                    look="danger"
                    onClick={() => {
                      revoking.mutate(c.id)
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
              {kind === "device" &&
                (offered && offered.until > now && !rows.some((c) => c.at > offered.made) ? (
                  <li className="flex justify-center py-inset">
                    <Qr text={offered.link} />
                  </li>
                ) : (
                  <li className={line}>
                    <span className="min-w-0 flex-1" />
                    <Button
                      look="go"
                      onClick={() => {
                        offering.mutate()
                      }}
                    >
                      Pair iPhone
                    </Button>
                  </li>
                ))}
            </Section>
          )
        )
      })}
    </>
  )
}
