// A thread's steps as old Switchboard drew them (mac/src/ui/work.rs, render_step): a line each on a
// hairline down the left, its icon and its words; a click opens what it was given and what came
// back, raw, with its tool under them.
import { Collapsible } from "@base-ui/react/collapsible"
import { useState } from "react"

import { appNames } from "../brain/derive.ts"
import { describe, toolLabel } from "../brain/step.ts"
import type { Part } from "../brain/step.ts"
import type { Item } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Caret, StepMark } from "./step-icons.tsx"

/** The longest raw input or output shown; the rest is cut. */
const RAW_MAX = 20_000

const raw = (v: unknown) => {
  const text = typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? "")
  return text.length > RAW_MAX ? `${text.slice(0, RAW_MAX)}\n…` : text
}

/** A step's words. Short ones keep their width; long sentences and code give way, so the end of
 * the line (where it ran) still shows. */
const Words = ({ parts }: { parts: readonly Part[] }) => (
  <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-pre">
    {parts.map((p, i) => {
      const key = `${i}:${p.text}`
      if (p.code) {
        return (
          <code key={key} className="min-w-0 truncate font-mono">
            {p.text}
          </code>
        )
      }
      return (
        <span key={key} className={p.text.length <= 24 ? "flex-none" : "min-w-0 truncate"}>
          {p.text}
        </span>
      )
    })}
  </span>
)

/** Raw details, as code. */
const Detail = ({ text }: { text: string }) =>
  text.trim() === "" ? null : (
    <pre className="selectable m-0 rounded-key border border-line-2 p-2 font-mono text-data whitespace-pre-wrap break-all text-ink">
      {text}
    </pre>
  )

/** A tool call, in words: its icon (red when it failed) and words; opened, its details as code
 * (what it was given, what came back) and its tool. */
const ToolStep = ({ item, result }: { item: Item; result: Item | undefined }) => {
  const apps = useBrain(appNames) ?? []
  const name = item.name ?? "tool"
  const step = describe(name, item.input, apps, result?.text ?? "")
  const tool = toolLabel(name)
  return (
    <Collapsible.Root render={<li />} className="flex flex-col">
      <Collapsible.Trigger className="-mx-2 flex h-6 min-w-0 items-center gap-2 rounded-key px-2 text-left text-caption text-ink2 outline-none hover:lit focus-visible:focused">
        <StepMark icon={step.icon} className={result?.error === true ? "text-red" : "text-ink3"} />
        <Words parts={step.parts} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="flex flex-col gap-1 pt-1 pl-6">
        <Detail text={raw(item.input)} />
        <Detail text={raw(result?.text ?? "")} />
        {tool !== "" && <span className="text-caption text-ink3">{tool}</span>}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** The steps, opened: on a hairline down the left. */
const StepList = ({ items }: { items: readonly Item[] }) => {
  const results = new Map(items.filter((i) => i.kind === "result").map((i) => [i.id ?? "", i]))
  return (
    <ul className="m-0 my-0.5 ml-0.5 flex w-full max-w-[560px] list-none flex-col py-0 pl-3 line-2-l">
      {items
        .filter((i) => i.kind === "tool")
        .map((i) => (
          <ToolStep key={i.seq} item={i} result={results.get(i.id ?? "")} />
        ))}
    </ul>
  )
}

interface StepsBlock {
  readonly kind: "steps"
  readonly items: Item[]
}

export type Block = { readonly kind: "item"; readonly item: Item } | StepsBlock

/** A transcript's entries: what was said, and each run of steps between (its tool calls and
 * their results) as one block. */
export const blocks = (items: readonly Item[]): Block[] => {
  const out: Block[] = []
  let steps: StepsBlock | null = null
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "result") {
      if (steps === null) {
        steps = { kind: "steps", items: [] }
        out.push(steps)
      }
      steps.items.push(item)
    } else {
      steps = null
      out.push({ kind: "item", item })
    }
  }
  return out
}

/** A run of steps in a thread's own page: shown, as a task's steps were in old Switchboard's
 * sheet, under how many there were; that line, its caret, folds them. */
export const Steps = ({ items }: { items: readonly Item[] }) => {
  const [open, setOpen] = useState(true)
  const count = items.filter((i) => i.kind === "tool").length
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col items-start self-stretch"
    >
      <Collapsible.Trigger className="-ml-1 flex min-h-[26px] min-w-0 items-center gap-2 rounded-key pr-2 pl-1 text-caption whitespace-nowrap text-ink3 outline-none hover:lit focus-visible:focused">
        <span>
          {count} {count === 1 ? "step" : "steps"}
        </span>
        <Caret open={open} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="w-full">
        <StepList items={items} />
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
