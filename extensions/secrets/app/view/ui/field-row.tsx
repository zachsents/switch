// One field's line: its label, its value (a concealed one as dots until it's revealed, an
// authenticator's code ticking down), and Reveal and Copy. Reveal and copy ask the bun process,
// which checks with Touch ID when the last check was a while ago.
import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import type { ShownField } from "../../shared/rpc.ts"
import { useNow } from "../format.ts"
import { copyMutation, copyTextMutation, openUrlMutation, revealMutation } from "../mutations.ts"
import type { FieldAt } from "../mutations.ts"
import { codeQuery } from "../queries.ts"
import { Stop } from "./marks.tsx"

export const DOTS = "••••••••••••"

/** A small command beside what it acts on: a bare label lit under the pointer. */
export const Flat = ({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="flex h-7 flex-none items-center rounded-chip px-2 text-small text-ink2 outline-none hover:bg-wash hover:text-ink focus-visible:bg-selection disabled:opacity-40"
  >
    {children}
  </button>
)

const Code = ({ id, field }: { id: string; field: string }) => {
  const { data, dataUpdatedAt } = useQuery(codeQuery(id, field))
  const now = useNow()
  if (!data) {
    return <span className="text-ink3">{DOTS}</span>
  }
  const left = Math.max(0, Math.ceil((dataUpdatedAt + data.left - now) / 1000))
  return (
    <span className="flex items-center gap-3 font-mono">
      <span className="text-read tracking-[0.12em] text-ink">
        {data.code.slice(0, 3)} {data.code.slice(3)}
      </span>
      <span className="text-data text-ink3">{left}</span>
    </span>
  )
}

const Value = ({ field, item }: { field: ShownField; item: string }) => {
  const open = useMutation(openUrlMutation)
  if (field.type === "url" && field.value) {
    return (
      <button
        type="button"
        onClick={() => {
          open.mutate(field.value)
        }}
        className="text-left text-ink underline-offset-2 hover:underline"
      >
        {field.value}
      </button>
    )
  }
  if (field.type === "totp") {
    return <Code id={item} field={field.id} />
  }
  return field.value
}

export const FieldRow = ({
  item,
  field,
  at,
  end,
}: {
  item: string
  field: ShownField
  /** A version from the item's history. */
  at?: number
  /** More keys at the line's end: Restore. */
  end?: ReactNode
}) => {
  const where: FieldAt =
    at === undefined ? { id: item, field: field.id } : { id: item, field: field.id, at }
  const reveal = useMutation(revealMutation)
  const copy = useMutation(copyMutation)
  const copyText = useMutation(copyTextMutation)
  const failed = reveal.error ?? copy.error ?? copyText.error
  const live = field.type === "totp" && at === undefined
  const revealed = reveal.data
  const value = () => {
    if (live) {
      return <Value field={field} item={item} />
    }
    if (!field.concealed) {
      return <Value field={field} item={item} />
    }
    return revealed === undefined ? (
      <span className="text-ink3">{DOTS}</span>
    ) : (
      <span className="font-mono whitespace-pre-wrap">{revealed}</span>
    )
  }
  return (
    <li className="group flex min-h-line items-center hairline-b last:after:hidden">
      <span className="w-label flex-none truncate px-inset text-small text-ink2">
        {field.label}
      </span>
      <span className="selectable min-w-0 flex-1 py-2 pr-3 text-ui break-words text-ink">
        {value()}
      </span>
      {failed && (
        <span className="flex min-w-0 items-center gap-2 pr-3 text-small text-ink">
          <Stop size={12} />
          <span className="truncate">{failed.message}</span>
        </span>
      )}
      <span className="flex flex-none items-center gap-1 pr-inset">
        {field.concealed && !live && (
          <Flat
            disabled={reveal.isPending}
            onClick={() => {
              if (revealed === undefined) {
                reveal.mutate(where)
              } else {
                reveal.reset()
              }
            }}
          >
            {revealed === undefined ? "Reveal" : "Hide"}
          </Flat>
        )}
        <Flat
          disabled={copy.isPending}
          onClick={() => {
            // "Copied" for a moment, then back.
            const done = {
              onSuccess: () =>
                setTimeout(() => {
                  copy.reset()
                  copyText.reset()
                }, 1500),
            }
            if (field.concealed) {
              copy.mutate(where, done)
            } else {
              copyText.mutate(field.value, done)
            }
          }}
        >
          {copy.isSuccess || copyText.isSuccess ? "Copied" : "Copy"}
        </Flat>
        {end}
      </span>
    </li>
  )
}
