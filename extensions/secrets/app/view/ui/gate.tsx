// Before the vault opens: this Mac's code while it waits to be approved, Unlock while it's locked,
// and what went wrong if it can't get that far.
import { useMutation } from "@tanstack/react-query"

import type { Status } from "../../shared/rpc.ts"
import { retryMutation, unlockMutation } from "../mutations.ts"
import { Band } from "./band.tsx"
import { Hand, Runner, Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

const Code = ({ code }: { code: string }) => (
  <div className="flex flex-col items-center gap-4">
    <div className="flex items-center gap-2 text-small font-semibold tracking-[0.06em] text-ink uppercase">
      <Hand />
      Approve
    </div>
    <div className="selectable font-mono text-[44px] leading-none tracking-[0.2em] text-ink">
      {code.slice(0, 3)} {code.slice(3)}
    </div>
  </div>
)

const Unlock = () => {
  const unlock = useMutation(unlockMutation)
  return (
    <form
      className="flex flex-col items-center gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        unlock.mutate()
      }}
    >
      <Key go type="submit" autoFocus disabled={unlock.isPending} className="h-9 px-5 text-ui">
        Unlock
      </Key>
      {unlock.error && (
        <span className="flex items-center gap-2 text-small text-ink">
          <Stop size={12} />
          {unlock.error.message}
        </span>
      )}
    </form>
  )
}

const Failed = ({ label, action }: { label: string; action: string }) => {
  const retry = useMutation(retryMutation)
  return (
    <div className="flex flex-col items-center gap-4">
      <span className="flex items-center gap-2 text-ui text-ink">
        <Stop />
        {label}
      </span>
      <Key
        disabled={retry.isPending}
        onClick={() => {
          retry.mutate()
        }}
      >
        {action}
      </Key>
    </div>
  )
}

const Body = ({ status }: { status: Status | undefined }) => {
  if (!status) {
    return <Runner />
  }
  switch (status.stage) {
    case "starting":
    case "open": {
      return <Runner />
    }
    case "pending": {
      return status.code ? <Code code={status.code} /> : <Runner />
    }
    case "locked": {
      return <Unlock />
    }
    case "revoked": {
      return <Failed label="Revoked" action="Enroll" />
    }
    case "failed": {
      return <Failed label={status.error || "Can't enroll"} action="Retry" />
    }
    default: {
      return status.stage satisfies never
    }
  }
}

/** The gate's band has no pages to go to. */
const ignore = () => null

export const Gate = ({ status }: { status: Status | undefined }) => (
  <div className="flex h-full flex-col">
    <Band page={null} pages={[]} onPage={ignore} online={status?.online ?? true} />
    <main className="flex min-h-0 flex-1 items-center justify-center bg-paper">
      <Body status={status} />
    </main>
  </div>
)
