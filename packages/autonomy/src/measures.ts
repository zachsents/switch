// Measures: what reflection can't count by reading, counted by code from the brain, each for the
// last day beside the day before. Hand-work repeated across turns (tools, sites, shell command
// families, runs of steps), the slowest and failing tools, the core's stalls and extensions in
// trouble, cost by space and by day, and the agent's words revised after they were said and the
// user's asked again. A second or more of reading on a busy brain, so the core runs it in a child
// (`switch measure`, core/measure.ts), never on its thread.
import type { Database } from "bun:sqlite"
import { allSpaces, seqAt } from "@switch/brain"

import { field, jsonOf, text } from "./json.ts"
import { repeats } from "./said.ts"
import { SENSED } from "./surprise.ts"

const DAY = 24 * 3600 * 1000

const usd = (n: number) => `$${n.toFixed(2)}`
const clip = (s: string, n: number) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(1, of))}%`

/** The value at fraction `q` of sorted numbers. */
const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0

/** The last day and the day before: where each starts in the log, and now. */
interface Days {
  readonly before: number
  readonly from: number
  readonly now: number
}

const inDay = (seq: number, d: Days) => (seq >= d.from ? "now" : "before")

/** A shell command's family: its first command past `cd`s and assignments, and its verb. */
const family = (command: string) => {
  const first =
    command
      .split(/&&|\|\||[;|\n]/u)
      .map((s) => s.trim())
      .find((s) => s !== "" && !/^(?:cd|export|set|source)\b/u.test(s) && !/^\w+=\S*$/u.test(s)) ??
    ""
  const words = first.split(/\s+/u).filter((w) => !/^\w+=/u.test(w))
  const head = (words[0] ?? "").split("/").at(-1) ?? ""
  const verb = words[1] ?? ""
  return /^[a-z][a-z-]*$/u.test(verb) ? `${head} ${verb}` : head
}

/** The site a browser call works on: a URL it names, else its session's last. */
const hostOf = (args: unknown) => {
  const steps = field(args, "steps")
  const urls = [
    field(args, "url"),
    ...(Array.isArray(steps) ? steps.map((s) => field(s, "url")) : []),
  ]
  for (const u of urls) {
    if (typeof u === "string" && URL.canParse(u)) {
      return new URL(u).host
    }
  }
  return ""
}

interface Call {
  readonly seq: number
  readonly time: number
  readonly turn: string
  readonly id: string
  /** The tool as its extension names it. */
  readonly tool: string
  /** The kind of hand-work: the tool, a shell's command family, a browser's site. */
  readonly kind: string
  /** The agent's own moves, not hand-work: saying, waiting, expecting, delegating. */
  readonly move: boolean
  readonly input: string
}

/** Each tool call of both days, in order, with its kind of hand-work. */
const callsOf = (db: Database, d: Days) => {
  const sessions = new Map<string, string>()
  return db
    .query<
      {
        seq: number
        time: number
        turn: string | null
        id: string | null
        name: string | null
        inner: string | null
        command: string | null
        args: string | null
        shown: string | null
      },
      [number]
    >(
      `SELECT seq, time, json_extract(payload, '$.turn') AS turn, json_extract(payload, '$.id') AS id,
         json_extract(payload, '$.name') AS name, json_extract(payload, '$.input.name') AS inner,
         json_extract(payload, '$.input.command') AS command,
         json_extract(payload, '$.input.arguments') AS args,
         substr(json_extract(payload, '$.input'), 1, 200) AS shown
       FROM events WHERE type = 'turn.tool' AND seq >= ? ORDER BY seq`,
    )
    .all(d.before)
    .map((r): Call => {
      // Through the apps server, the tool is the one it calls.
      const tool = (
        r.inner !== null && r.name === "mcp__apps__call_tool" ? r.inner : (r.name ?? "")
      ).replace(/^mcp__[\w-]+?__/u, "")
      const args = jsonOf(r.args ?? "")
      const command = r.command ?? text(field(args, "command"))
      let kind = tool
      if (command !== "") {
        kind = `${tool}: ${family(command)}`
      } else if (tool === "browser_act") {
        const session = text(field(args, "session"))
        const host = hostOf(args) || (sessions.get(session) ?? "")
        sessions.set(session, host)
        kind = host === "" ? tool : `${tool}: ${host}`
      }
      return {
        seq: r.seq,
        time: r.time,
        turn: r.turn ?? "",
        id: r.id ?? "",
        tool,
        kind,
        move: tool.startsWith("autonomy_") || (r.name ?? "").startsWith("mcp__switch__"),
        input: command === "" ? (r.args ?? r.shown ?? "") : command,
      }
    })
}

/** Reading and editing files and text: how any work is done, not a flow of its own. */
const FILE_WORK = new Set(["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "NotebookEdit"])
const SHELL_FILE_WORK = new Set(
  "cat sed grep rg ls head tail find echo printf mkdir rm cp mv wc sort uniq cut awk diff touch sleep python python3 jq".split(
    " ",
  ),
)
const isFileWork = (c: Call) =>
  FILE_WORK.has(c.kind) || SHELL_FILE_WORK.has(c.kind.slice(c.tool.length + 2).split(" ")[0] ?? "")

/** Kinds of hand-work by calls and turns, and the runs of steps repeated across turns. */
const repeated = (calls: readonly Call[], d: Days) => {
  const kinds = new Map<
    string,
    { now: number; before: number; turns: Set<string>; examples: string[] }
  >()
  const byTurn = new Map<string, string[]>()
  const files = { now: 0, before: 0 }
  for (const c of calls) {
    if (c.move) {
      continue
    }
    if (isFileWork(c)) {
      files[inDay(c.seq, d)] += 1
      continue
    }
    const k = kinds.get(c.kind) ?? { now: 0, before: 0, turns: new Set(), examples: [] }
    if (inDay(c.seq, d) === "now") {
      k.now += 1
      k.turns.add(c.turn)
      if (k.examples.length < 2 && c.input !== "") {
        k.examples.push(clip(c.input, 100))
      }
      // A turn's steps, a step done again at once counted once.
      const steps = byTurn.get(c.turn) ?? []
      if (steps.at(-1) !== c.kind) {
        steps.push(c.kind)
      }
      byTurn.set(c.turn, steps)
    } else {
      k.before += 1
    }
    kinds.set(c.kind, k)
  }
  const top = [...kinds]
    .filter(([, k]) => k.turns.size >= 3)
    .toSorted((a, b) => b[1].now - a[1].now)
    .slice(0, 20)
    .map(
      ([kind, k]) =>
        `- ${kind}: ${k.now} calls in ${k.turns.size} turns (${k.before})${k.examples.length === 0 ? "" : `: ${k.examples.join(" | ")}`}`,
    )
  top.push(`- reading and editing files and text, all told: ${files.now} calls (${files.before})`)
  // Runs of three to five different steps, by the turns that took them: going back and forth
  // between two is no flow.
  const runs = new Map<string, { steps: number; turns: Set<string> }>()
  for (const [turn, steps] of byTurn) {
    for (let n = 3; n <= 5; n += 1) {
      for (let i = 0; i + n <= steps.length; i += 1) {
        const taken = steps.slice(i, i + n)
        if (new Set(taken).size < n) {
          continue
        }
        const run = ` → ${taken.join(" → ")} → `
        const r = runs.get(run) ?? { steps: n, turns: new Set() }
        r.turns.add(turn)
        runs.set(run, r)
      }
    }
  }
  const often = [...runs]
    .filter(([, r]) => r.turns.size >= 3)
    .toSorted((a, b) => b[1].turns.size * b[1].steps - a[1].turns.size * a[1].steps)
    .slice(0, 200)
  const sequences = often
    // A run inside a longer one taken as often is that one.
    .filter(
      ([run, r]) =>
        !often.some(
          ([other, o]) => other !== run && other.includes(run) && o.turns.size >= r.turns.size,
        ),
    )
    .slice(0, 10)
    .map(([run, r]) => `- ${run.slice(3, -3)}: ${r.turns.size} turns`)
  return { top, sequences }
}

/** Per tool: calls, latency to its result, errors; the slowest and the failing. */
const tools = (db: Database, calls: readonly Call[], d: Days) => {
  const results = new Map(
    db
      .query<{ time: number; id: string | null; error: string | null }, [number]>(
        `SELECT time, json_extract(payload, '$.id') AS id,
           CASE WHEN json_extract(payload, '$.error') = 1
             THEN substr(json_extract(payload, '$.output'), 1, 300) END AS error
         FROM events WHERE type = 'turn.result' AND seq >= ?`,
      )
      .all(d.before)
      .map((r) => [r.id ?? "", r]),
  )
  const of = new Map<
    string,
    Record<"now" | "before", { ms: number[]; errors: number }> & { last: string }
  >()
  for (const c of calls) {
    const r = results.get(c.id)
    if (r === undefined) {
      continue
    }
    const t = of.get(c.tool) ?? {
      now: { ms: [], errors: 0 },
      before: { ms: [], errors: 0 },
      last: "",
    }
    const day = t[inDay(c.seq, d)]
    day.ms.push(r.time - c.time)
    if (r.error !== null) {
      day.errors += 1
      t.last = r.error
    }
    of.set(c.tool, t)
  }
  const stats = [...of].map(([tool, t]) => {
    const now = t.now.ms.toSorted((a, b) => a - b)
    const before = t.before.ms.toSorted((a, b) => a - b)
    return {
      tool,
      n: now.length,
      p50: quantile(now, 0.5),
      p90: quantile(now, 0.9),
      errors: t.now.errors,
      last: t.last,
      was:
        before.length === 0
          ? "none"
          : `${secs(quantile(before, 0.5))}, ${pct(t.before.errors, before.length)} failed of ${before.length}`,
    }
  })
  const slow = stats
    .filter((s) => s.n >= 5)
    .toSorted((a, b) => b.p50 - a.p50)
    .slice(0, 10)
    .map((s) => `- ${s.tool}: median ${secs(s.p50)}, p90 ${secs(s.p90)}, ${s.n} calls (${s.was})`)
  const failing = stats
    .filter((s) => s.errors >= 3)
    .toSorted((a, b) => b.errors - a.errors)
    .slice(0, 10)
    .map(
      (s) =>
        `- ${s.tool}: ${s.errors} of ${s.n} failed, ${pct(s.errors, s.n)} (${s.was}), last: ${clip(s.last, 120)}`,
    )
  return { slow, failing }
}

/** The core's stalls, extensions' trouble raised, and their runs that ended by themselves. */
const health = (db: Database, d: Days) => {
  const stalls = db
    .query<{ day: string; n: number; ms: number | null; most: number | null }, [number, number]>(
      `SELECT CASE WHEN seq >= ?2 THEN 'now' ELSE 'before' END AS day, count(*) AS n,
         sum(json_extract(payload, '$.ms')) AS ms, max(json_extract(payload, '$.ms')) AS most
       FROM events WHERE type = 'core.stalled' AND seq >= ?1 GROUP BY day`,
    )
    .all(d.before, d.from)
  const at = (day: string) => stalls.find((s) => s.day === day)
  const now = at("now")
  const before = at("before")
  const core = `- ${now?.n ?? 0} stalls of the core's thread over a second, ${secs(now?.ms ?? 0)} in all, the longest ${secs(now?.most ?? 0)} (${before?.n ?? 0}, ${secs(before?.ms ?? 0)})`
  const raised = db
    .query<{ seq: number; id: string; text: string }, [number]>(
      `SELECT seq, json_extract(payload, '$.id') AS id, json_extract(payload, '$.text') AS text
       FROM events WHERE type = 'surprise.raised' AND seq >= ?`,
    )
    .all(d.before)
    .filter((r) => SENSED.some((p) => r.id.startsWith(p)))
  const troubles = new Map<string, { now: number; before: number; text: string }>()
  for (const r of raised) {
    const t = troubles.get(r.id) ?? { now: 0, before: 0, text: "" }
    t[inDay(r.seq, d)] += 1
    t.text = r.text
    troubles.set(r.id, t)
  }
  const trouble = [...troubles]
    .filter(([, t]) => t.now > 0)
    .toSorted((a, b) => b[1].now - a[1].now)
    .slice(0, 12)
    .map(([id, t]) => `- ${id}: raised ${t.now}× (${t.before}): ${clip(t.text, 140)}`)
  const downs = db
    .query<{ extension: string; now: number; before: number; why: string }, [number, number]>(
      // The bare reason is the latest down's, beside max(seq).
      `SELECT json_extract(payload, '$.extension') AS extension, sum(seq >= ?2) AS now,
         sum(seq < ?2) AS before, json_extract(payload, '$.reason') AS why, max(seq) AS last
       FROM events WHERE type = 'extension.down' AND seq >= ?1
         AND coalesce(json_extract(payload, '$.reason'), '') NOT IN ('Stopped', 'host gone')
       GROUP BY extension HAVING now > 0 ORDER BY now DESC LIMIT 10`,
    )
    .all(d.before, d.from)
    .map(
      (r) => `- ${r.extension}: down by itself ${r.now}× (${r.before}), last: ${clip(r.why, 80)}`,
    )
  return [core, ...trouble, ...downs]
}

/** Turns' cost by space, and by day for a week. */
const cost = (db: Database, d: Days) => {
  const names = new Map<string, string>(allSpaces(db).map((s) => [s.id, s.name]))
  const spaces = db
    .query<{ space: string; now: number; before: number }, [number, number]>(
      `SELECT coalesce(s.home, p.home, substr(e.thread, 1, instr(e.thread || '-', '-')) || '* threads') AS space,
         sum(CASE WHEN e.seq >= ?2 THEN e.cost ELSE 0 END) AS now,
         sum(CASE WHEN e.seq < ?2 THEN e.cost ELSE 0 END) AS before
       FROM (SELECT seq, json_extract(payload, '$.thread') AS thread,
               coalesce(json_extract(payload, '$.costUsd'), 0) AS cost
             FROM events INDEXED BY events_ended_spend WHERE type = 'turn.ended' AND seq >= ?1) e
         LEFT JOIN thread_spaces s ON s.thread = e.thread
         LEFT JOIN thread_spaces p ON p.thread = s.parent
       GROUP BY space ORDER BY now DESC`,
    )
    .all(d.before, d.from)
  const total = (k: "now" | "before") => spaces.reduce((s, r) => s + r[k], 0)
  const bySpace = [
    `- all: ${usd(total("now"))} (${usd(total("before"))})`,
    ...spaces
      .slice(0, 12)
      .map((r) => `- ${names.get(r.space) ?? r.space}: ${usd(r.now)} (${usd(r.before)})`),
  ]
  const spend = db.query<{ usd: number | null; turns: number }, [number, number]>(
    `SELECT sum(json_extract(payload, '$.costUsd')) AS usd, count(*) AS turns
     FROM events INDEXED BY events_ended_spend WHERE type = 'turn.ended' AND seq >= ? AND seq < ?`,
  )
  const byDay: string[] = []
  const midnight = new Date(d.now)
  midnight.setHours(0, 0, 0, 0)
  for (let i = 0; i < 7; i += 1) {
    const start = new Date(midnight)
    start.setDate(midnight.getDate() - i)
    const end = new Date(start)
    end.setDate(start.getDate() + 1)
    const r = spend.get(seqAt(db, start.getTime()), seqAt(db, end.getTime()))
    const day = start.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    byDay.push(`- ${day}${i === 0 ? " so far" : ""}: ${usd(r?.usd ?? 0)}, ${r?.turns ?? 0} turns`)
  }
  return { bySpace, byDay }
}

/** The user's words from a client: not the agent's, nor another agent's. */
const USER = "source NOT IN ('agent', 'peer')"

/** The agent's messages revised after they were in the chat, and the user's asked twice. */
const corrections = (db: Database, d: Days) => {
  const revised = db
    .query<{ seq: number; space: string | null; was: string }, [number]>(
      `SELECT e.seq, m.space, json_extract(e.payload, '$.was') AS was
       FROM events e LEFT JOIN messages m ON m.seq = json_extract(e.payload, '$.seq')
       WHERE e.type = 'message.revised' AND e.seq >= ?`,
    )
    .all(d.before)
  const nowRevised = revised.filter((r) => inDay(r.seq, d) === "now")
  const said = db
    .query<{ seq: number; time: number; space: string; text: string }, [number]>(
      `SELECT seq, time, space, text FROM messages WHERE ${USER} AND seq >= ? ORDER BY seq`,
    )
    .all(seqAt(db, d.now - 3 * DAY))
  // Asked again: the same words as one of theirs in the same space within the day before.
  const again = said.filter(
    (m) =>
      m.seq >= d.before &&
      said.some(
        (e) =>
          e.seq < m.seq && e.space === m.space && m.time - e.time < DAY && repeats(m.text, e.text),
      ),
  )
  const nowAgain = again.filter((m) => inDay(m.seq, d) === "now")
  return [
    `- the agent's messages revised after they were said: ${nowRevised.length} (${revised.length - nowRevised.length})${
      nowRevised.length === 0
        ? ""
        : `: ${nowRevised
            .slice(0, 5)
            .map((r) => `${r.space ?? "?"}: ${clip(r.was, 90)}`)
            .join(" | ")}`
    }`,
    `- the user's words said again, as they said them in the day before in that space: ${nowAgain.length} (${again.length - nowAgain.length})${
      nowAgain.length === 0
        ? ""
        : `: ${nowAgain
            .slice(0, 5)
            .map((m) => `${m.space}: ${clip(m.text, 90)}`)
            .join(" | ")}`
    }`,
  ]
}

const section = (title: string, rows: readonly string[]) =>
  rows.length === 0 ? "" : `${title}:\n${rows.join("\n")}`

/** Every measure as text for a look: the last 24 hours, the 24 before in brackets. */
export const measures = (db: Database, now: number) => {
  const d: Days = {
    before: seqAt(db, now - 2 * DAY),
    from: seqAt(db, now - DAY),
    now,
  }
  const calls = callsOf(db, d)
  const work = repeated(calls, d)
  const slow = tools(db, calls, d)
  const spent = cost(db, d)
  return [
    "Measured by code over the last 24 hours; the 24 before in brackets.",
    section("Hand-work by kind (tool, shell command family, browser site)", work.top),
    section("Runs of steps repeated across turns", work.sequences),
    section("Slowest tools, call to result", slow.slow),
    section("Failing tools", slow.failing),
    section("Health", health(db, d)),
    section("Turns' cost by space", spent.bySpace),
    section("Turns' cost by day", spent.byDay),
    section("Corrections and repeats", corrections(db, d)),
  ]
    .filter((s) => s !== "")
    .join("\n\n")
}
