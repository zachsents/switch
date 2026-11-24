// What's playing: its art edge to edge at the cell's left, its title and who by, keys back, play or
// pause, and next, each calling its extension's tool, and a rule along the foot that runs while it
// plays. Paused, one quiet line: its title and the play key. A key's error takes who by's place.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicBooleanSchema, DynamicNumberSchema, DynamicStringSchema } from "@a2ui/web_core/v1_0"
import { useMutation } from "@tanstack/react-query"
import { z } from "zod"

import { Button } from "../ui/kit/button.tsx"
import { useNow } from "../ui/use-now.ts"
import { along } from "./along.ts"
import { Glyph } from "./basic/glyph.tsx"
import { ICONS } from "./basic/icons.ts"
import { setMutation } from "./set-mutation.ts"

const text = (x: unknown) => (typeof x === "string" ? x : "")
const num = (x: unknown) => (typeof x === "number" ? x : undefined)

export const Playing = createComponentImplementation(
  {
    name: "Playing",
    schema: z.object({
      title: DynamicStringSchema,
      by: DynamicStringSchema.optional(),
      art: DynamicStringSchema.optional(),
      playing: DynamicBooleanSchema,
      at: DynamicNumberSchema.optional(),
      length: DynamicNumberSchema.optional(),
      asOf: DynamicNumberSchema.optional(),
      back: z.string(),
      toggle: z.string(),
      next: z.string(),
    }),
  },
  ({ props, context }) => {
    const press = useMutation(setMutation)
    const app = (context.dataContext.surface?.id ?? "").split("/")[0] ?? ""
    const playing = props.playing === true
    const now = useNow(1000, playing)
    const done = along({
      at: num(props.at),
      length: num(props.length),
      asOf: num(props.asOf),
      playing,
      now,
    })
    const by = press.error?.message ?? text(props.by)
    const key = (tool: string, label: string, icon: keyof typeof ICONS) => (
      <Button
        look="flat"
        aria-label={label}
        disabled={press.isPending}
        onClick={() => {
          press.mutate({ call: { app, tool, args: {} }, values: {} })
        }}
      >
        <Glyph d={ICONS[icon]} />
      </Button>
    )
    if (!playing) {
      return (
        <li data-playing="paused" className="flex h-line items-center gap-2 pl-inset">
          <span className="trim min-w-0 flex-1 truncate text-ui text-ink2">
            {text(props.title)}
          </span>
          <span className="flex flex-none pr-1">{key(props.toggle, "Play", "play")}</span>
        </li>
      )
    }
    const art = text(props.art)
    return (
      <li data-playing="playing" className="relative flex h-12 items-center">
        {art !== "" && (
          <img src={art} alt="" decoding="sync" className="block size-12 flex-none object-cover" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1 px-inset pb-1.5">
          <span className="trim truncate text-ui font-medium text-ink">{text(props.title)}</span>
          {by !== "" && (
            <span className={`trim truncate text-small ${press.error ? "text-ink" : "text-ink2"}`}>
              {by}
            </span>
          )}
        </div>
        <div className="flex flex-none pr-1">
          {key(props.back, "Back", "skipPrevious")}
          {key(props.toggle, "Pause", "pause")}
          {key(props.next, "Next", "skipNext")}
        </div>
        {done !== null && (
          <span
            className="absolute bottom-0 left-0 h-[2px] bg-ink"
            style={{ width: `${done * 100}%` }}
          />
        )}
      </li>
    )
  },
)
