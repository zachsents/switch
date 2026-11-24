// A line with its live mark, name and what's under it, data at the end, a progress rule along the
// bottom and a countdown to `endsAt`; its children below, one equal column each, tucked under it.
// With a `url`, the whole line opens it in the browser. A detail said short (a printer's trouble in a
// word or two) shows its `note`, the whole of it, while the pointer is over it.
import { createComponentImplementation } from "@a2ui/react"
import {
  ChildListSchema,
  DynamicBooleanSchema,
  DynamicStringListSchema,
  DynamicStringSchema,
  DynamicValueSchema,
} from "@a2ui/web_core/v1_0"
import { Fragment } from "react"
import { z } from "zod"

import { Button } from "../ui/kit/button.tsx"
import { Hand, Runner, Stop, Warn } from "../ui/marks.tsx"
import { Data, Tip } from "../ui/parts.tsx"
import { spanOf } from "../ui/time.ts"
import { useNow } from "../ui/use-now.ts"

const MARKS = { running: Runner, needsYou: Hand, stop: Stop, warn: Warn } as const

const text = (x: unknown) => (typeof x === "string" ? x : "")

const isMark = (m: unknown): m is keyof typeof MARKS => typeof m === "string" && m in MARKS

export const Row = createComponentImplementation(
  {
    name: "Row",
    schema: z.object({
      label: DynamicStringSchema,
      /** running, needsYou, stop or warn. */
      mark: DynamicStringSchema.optional(),
      detail: DynamicStringSchema.optional(),
      /** The detail in full, when it's said short: shown when the pointer is over the detail. */
      note: DynamicStringSchema.optional(),
      /** The detail is what's wrong. */
      alert: DynamicBooleanSchema.optional(),
      values: DynamicStringListSchema.optional(),
      /** 0 to 100, or null for none. */
      progress: DynamicValueSchema.optional(),
      /** When it ends, in ms, or null. */
      endsAt: DynamicValueSchema.optional(),
      children: ChildListSchema.optional(),
      /** A page it opens in the browser, the whole row its click (an order's admin page). */
      url: DynamicStringSchema.optional(),
    }),
  },
  ({ props, buildChild }) => {
    const Mark = isMark(props.mark) ? MARKS[props.mark] : undefined
    const endsAt = typeof props.endsAt === "number" ? props.endsAt : undefined
    const progress = typeof props.progress === "number" ? props.progress : undefined
    const now = useNow(30_000, endsAt !== undefined)
    const children = props.children ?? []
    const values: readonly string[] = Array.isArray(props.values) ? props.values : []
    return (
      <li data-row className={children.length > 0 ? "pb-1.5" : undefined}>
        <div className="relative flex h-line items-center gap-2 px-inset text-ui text-ink [&>:not(button)]:pointer-events-none [&>:not(button)]:relative">
          {text(props.url) !== "" && (
            <Button
              look="bare"
              aria-label={text(props.label)}
              onClick={() => {
                window.open(text(props.url), "_blank", "noreferrer")
              }}
              className="absolute! inset-0 hover:lit active:held"
            />
          )}
          {Mark && <Mark />}
          <span data-row-label className="trim min-w-0 flex-none truncate font-medium">
            {text(props.label)}
          </span>
          {text(props.note) === "" ? (
            <span
              data-row-detail
              className={`trim min-w-0 flex-1 truncate text-small ${props.alert === true ? "text-ink" : "text-ink2"}`}
            >
              {text(props.detail)}
            </span>
          ) : (
            <Tip label={text(props.note)} offset={14}>
              <span
                data-row-detail
                className={`trim pointer-events-auto! min-w-0 flex-1 cursor-default truncate text-small ${props.alert === true ? "text-ink" : "text-ink2"}`}
              >
                {text(props.detail)}
              </span>
            </Tip>
          )}
          {values.map((v) => (
            <Data key={v}>{v}</Data>
          ))}
          {endsAt !== undefined && <Data>{spanOf(endsAt - now, "minute")}</Data>}
          {progress !== undefined && (
            <span
              data-row-progress
              className="absolute! bottom-0 left-0 h-[2px] bg-ink"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          )}
        </div>
        {children.length > 0 && (
          <div
            className="-mt-1 grid"
            style={{ gridTemplateColumns: `repeat(${children.length}, minmax(0, 1fr))` }}
          >
            {children.map((c) => {
              const id = typeof c === "string" ? c : c.id
              const at = typeof c === "string" ? undefined : c.basePath
              return <Fragment key={`${id}@${at ?? ""}`}>{buildChild(id, at)}</Fragment>
            })}
          </div>
        )}
      </li>
    )
  },
)
