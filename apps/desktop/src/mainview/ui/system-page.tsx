// System: this app's version and an update waiting, what the agent spends and runs on, its recent
// turns with model and effort, what each Mac lets extensions do, and the brain's own counts.
import { useQuery } from "@tanstack/react-query"

import { systemQuery } from "../brain/system.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Warn } from "./marks.tsx"
import { Data, Section } from "./parts.tsx"
import { dayOf, spanOf, timeOf } from "./time.ts"
import { PaneScroll } from "./pane-scroll.tsx"

const line = "flex h-line items-center gap-2.5 px-inset text-ui text-ink"

const dollars = (n: number) => `$${n.toFixed(2)}`

const percent = (n: number) => `${Math.round(n * 100)}%`

const NUMBERS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
}

/** A usage window's name, "seven_day", as "7 day". */
const windowName = (name: string) =>
  name
    .split("_")
    .map((w) => NUMBERS[w] ?? w)
    .join(" ")

/** "screenRecording" as "Screen Recording". */
const words = (name: string) =>
  name
    .replaceAll(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .replace(/^./u, (c) => c.toUpperCase())

/** A local date ("2026-11-20") as its day. */
const dayName = (date: string) =>
  dayOf(Temporal.PlainDate.from(date).toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds)

const AgentSection = ({ now }: { now: number }) => {
  const subscriptions = useBrain((s) => [...s.extra.subscriptions.values()])
  if (subscriptions.length === 0) {
    return null
  }
  return (
    <Section label="Agent" count={subscriptions.length}>
      {subscriptions.map((a) => (
        <li key={a.host} className={line} title={a.problem}>
          <span className="min-w-0 truncate">{a.label}</span>
          {!a.up && <Warn />}
          {a.problem !== "" && <span className="truncate text-small text-red">{a.problem}</span>}
          {/* Columns of their own, so each figure sits under the one above it. */}
          <span className="ml-auto flex w-56 flex-none justify-end gap-3 text-caption tabular-nums text-ink3">
            {a.windows.map((w) => (
              <span key={w.name}>
                {windowName(w.name)} {percent(w.used)}
              </span>
            ))}
          </span>
          <span className="w-16 flex-none text-right text-caption tabular-nums text-ink3">
            {a.limitedUntil > now && spanOf(a.limitedUntil - now, "minute")}
          </span>
          <span className="w-16 flex-none text-right text-caption tabular-nums text-ink3">
            {a.provider}
          </span>
        </li>
      ))}
    </Section>
  )
}

export const SystemPage = ({ now }: { now: number }) => {
  const system = useQuery(systemQuery)
  const s = system.data
  return (
    <PaneScroll className="flex-1 bg-bg">
      {system.error && (
        <div className="flex h-line items-center px-inset text-small text-ink line-2-b">
          {system.error.message}
        </div>
      )}
      <AgentSection now={now} />
      {s && s.spend.length > 0 && (
        <Section label="Spend">
          {s.spend.map((d) => (
            <li key={d.day} className={line}>
              <span className="min-w-0 flex-1 truncate">{dayName(d.day)}</span>
              <Data w="w-16">{d.turns}</Data>
              <Data w="w-24">{dollars(d.cost)}</Data>
            </li>
          ))}
        </Section>
      )}
      {s && s.turns.length > 0 && (
        <Section label="Turns">
          {s.turns.map((t) => (
            <li key={`${t.thread}:${t.time}`} className={line} title={t.host}>
              <span className="min-w-0 flex-1 truncate">{t.title || t.thread}</span>
              {t.status !== "done" && <Warn />}
              <Data w="w-40">{[t.model, t.effort].filter((x) => x !== "").join(" · ")}</Data>
              <Data w="w-16">{spanOf(t.ms)}</Data>
              <Data w="w-24">{dollars(t.cost)}</Data>
              <Data w="w-20">{timeOf(t.time)}</Data>
            </li>
          ))}
        </Section>
      )}
      {s && s.permissions.length > 0 && (
        <Section label="Permissions">
          {s.permissions.flatMap((m) =>
            m.granted.map((g) => (
              <li key={`${m.machine}:${g.name}`} className={line}>
                <span className="min-w-0 flex-1 truncate">{words(g.name)}</span>
                {!g.on && <Warn />}
                <Data>{m.machine}</Data>
              </li>
            )),
          )}
        </Section>
      )}
      {s && (
        <Section label="Debug">
          <li className={line}>
            <span className="min-w-0 flex-1 truncate">Seq</span>
            <Data>{s.debug.seq}</Data>
          </li>
          <li className={line}>
            <span className="min-w-0 flex-1 truncate">Brain</span>
            <Data>{`${(s.debug.bytes / 1e6).toFixed(1)} MB`}</Data>
          </li>
          {s.debug.types.map((t) => (
            <li key={t.type} className={line}>
              <span className="min-w-0 flex-1 truncate font-mono text-data">{t.type}</span>
              <Data>{t.n}</Data>
            </li>
          ))}
          {s.debug.projections.map((p) => (
            <li key={p.name} className={line}>
              <span className="min-w-0 flex-1 truncate font-mono text-data">{p.name}</span>
              <Data>{`v${p.version}`}</Data>
            </li>
          ))}
        </Section>
      )}
    </PaneScroll>
  )
}
