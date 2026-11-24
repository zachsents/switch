// Who holds the vault: this Mac, the devices and extensions waiting (each with the code it shows,
// to match before approving), and those approved, each revocable. Approving and revoking carry a
// proof made here, after the Mac's own check.
import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import type { DeviceRow } from "../../shared/rpc.ts"
import {
  approveDeviceMutation,
  approveExtensionMutation,
  revokeDeviceMutation,
  revokeExtensionMutation,
} from "../mutations.ts"
import { membersQuery } from "../queries.ts"
import { Cells } from "./cells.tsx"
import { Hand, Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

const Code = ({ code }: { code: string }) => (
  <span className="font-mono text-data tracking-[0.12em] text-ink">
    {code.slice(0, 3)} {code.slice(3)}
  </span>
)

const KIND: Record<string, string> = { mac: "Mac", iphone: "iPhone" }

const Device = ({ d, end }: { d: DeviceRow; end?: ReactNode }) => (
  <Cells label={KIND[d.kind] ?? d.kind} end={end}>
    {d.name}
  </Cells>
)

export const DevicesPage = ({ device }: { device: string }) => {
  const { data } = useQuery(membersQuery)
  const approve = useMutation(approveDeviceMutation)
  const revoke = useMutation(revokeDeviceMutation)
  const allow = useMutation(approveExtensionMutation)
  const stop = useMutation(revokeExtensionMutation)
  const failed = approve.error ?? revoke.error ?? allow.error ?? stop.error
  const devices = data?.devices ?? []
  const extensions = data?.extensions ?? []
  const me = devices.find((d) => d.id === device)
  const waiting = devices.filter((d) => d.status === "pending")
  const others = devices.filter((d) => d.status === "active" && d.id !== device)
  const extensionsWaiting = extensions.filter((s) => s.status === "pending")
  const allowed = extensions.filter((s) => s.status === "active")
  return (
    <article className="min-h-full bg-paper">
      {failed && (
        <div className="flex h-line items-center gap-2.5 px-inset text-small text-ink hairline-b">
          <Stop size={12} />
          <span className="min-w-0 flex-1 truncate">{failed.message}</span>
        </div>
      )}
      {(waiting.length > 0 || extensionsWaiting.length > 0) && (
        <Section mark={<Hand />} label="Waiting" count={waiting.length + extensionsWaiting.length}>
          {waiting.map((d) => (
            <Device
              key={d.id}
              d={d}
              end={
                <>
                  <Code code={d.code} />
                  <Key
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.mutate(d.id)
                    }}
                  >
                    Deny
                  </Key>
                  <Key
                    go
                    disabled={approve.isPending}
                    onClick={() => {
                      approve.mutate(d.id)
                    }}
                  >
                    Approve
                  </Key>
                </>
              }
            />
          ))}
          {extensionsWaiting.map((s) => (
            <Cells
              key={s.name}
              label="Extension"
              end={
                <>
                  <Code code={s.code} />
                  <Key
                    go
                    disabled={allow.isPending}
                    onClick={() => {
                      allow.mutate(s.name)
                    }}
                  >
                    Allow
                  </Key>
                </>
              }
            >
              {s.name}
            </Cells>
          ))}
        </Section>
      )}
      {me && (
        <Section label="This Mac">
          <Device
            d={me}
            end={
              <Key
                disabled={revoke.isPending}
                onClick={() => {
                  revoke.mutate(me.id)
                }}
              >
                Revoke
              </Key>
            }
          />
        </Section>
      )}
      <Section label="Devices" count={others.length}>
        {others.map((d) => (
          <Device
            key={d.id}
            d={d}
            end={
              <Key
                disabled={revoke.isPending}
                onClick={() => {
                  revoke.mutate(d.id)
                }}
              >
                Revoke
              </Key>
            }
          />
        ))}
      </Section>
      <Section label="Extensions" count={allowed.length}>
        {allowed.map((s) => (
          <Cells
            key={s.name}
            label="Extension"
            end={
              <Key
                disabled={stop.isPending}
                onClick={() => {
                  stop.mutate(s.name)
                }}
              >
                Revoke
              </Key>
            }
          >
            {s.name}
          </Cells>
        ))}
      </Section>
    </article>
  )
}
