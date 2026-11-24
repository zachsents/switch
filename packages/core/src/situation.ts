// The rest of a turn's situation, read from the brain with no model, each part only when it has
// something: what's open here (items, expectations, what's owed and its pull requests), surprises
// it hasn't heard, the Macs (each one's lock and where the user is) and health when something's off.
import type { Database } from "bun:sqlite"
import { allAccounts, stillGoing } from "@switch/agent"
import { changesLine, getItem, openExpectations, openSurprises, unheard } from "@switch/autonomy"
import { seqAt, extensionsEvent } from "@switch/brain"
import type { SpaceId, ThreadId } from "@switch/brain"

export { macsLine } from "./presence.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OWED_WITHIN = 3 * 24 * HOUR
const ITEMS = 5
const EXPECTED = 5
const OWED = 5
const SURPRISES = 4

const clip = (text: string, n: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

const until = (ms: number, now: number) => {
  const d = ms - now
  if (d < 0) {
    return "overdue"
  }
  if (d < 90 * MINUTE) {
    return `in ${Math.max(1, Math.round(d / MINUTE))}m`
  }
  if (d < 36 * HOUR) {
    return `in ${Math.round(d / HOUR)}h`
  }
  return new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" })
}

const parse: (json: string) => unknown = JSON.parse

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const at = (v: unknown, ...path: string[]): unknown => {
  let x = v
  for (const k of path) {
    x = isRecord(x) ? x[k] : undefined
  }
  return x
}
const str = (v: unknown) => (typeof v === "string" ? v : "")

const PR = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu

/** A pull request's state, from the newest `pr` event any extension reported of it. */
const prState = (db: Database, url: string) => {
  const row = db
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM events WHERE type IN (${extensionsEvent("pr")})
         AND json_extract(payload, '$.data.facts.url') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(url)
  if (!row) {
    return { ref: url.replace("https://github.com/", "").replace("/pull/", "#"), state: "" }
  }
  const facts = at(parse(row.payload), "data", "facts")
  return {
    ref: str(at(facts, "ref")) || url,
    state: str(at(facts, "state")),
    checks: str(at(facts, "checks")),
  }
}

/** The pull requests a task (or one it started) opened or named. */
const prsOf = (db: Database, task: ThreadId) => {
  const texts = db
    .query<{ body: string }, [string, string]>(
      `SELECT body FROM thread_items WHERE (thread = ? OR thread IN (SELECT thread FROM threads WHERE parent = ?))
         AND json_extract(body, '$.kind') IN ('result', 'text')`,
    )
    .all(task, task)
    .map((r) => r.body)
  return [...new Set(texts.flatMap((t) => t.match(PR) ?? []))]
}

/** What's owed: tasks this thread started lately, open until done and every change merged or closed. */
const owed = (db: Database, thread: ThreadId, now: number) =>
  db
    .query<{ thread: ThreadId; title: string; status: string; opened: number }, [string, number]>(
      `SELECT t.thread, t.title, t.status, e.time AS opened FROM threads t
         JOIN thread_spaces s ON s.thread = t.thread AND s.opened >= ?2
         JOIN events e ON e.seq = s.opened
       WHERE t.parent = ?1 ORDER BY s.opened DESC LIMIT 20`,
    )
    .all(thread, seqAt(db, now - OWED_WITHIN))
    .flatMap((t) => {
      const prs = prsOf(db, t.thread).map((u) => prState(db, u))
      const settled = prs.every((p) => p.state === "merged" || p.state === "closed")
      // A turn over while its work goes on (a watch, a script) is still owed.
      const status = t.status === "done" && stillGoing(db, t.thread) ? "waiting" : t.status
      if (status === "done" && settled) {
        return []
      }
      if (t.status === "interrupted") {
        return []
      }
      const changes = prs.map(
        (p) =>
          `${p.ref} ${p.state || "unseen"}${p.checks !== undefined && p.checks !== "" && p.state === "open" ? `, checks ${p.checks}` : ""}`,
      )
      return [
        `- ${clip(t.title, 80)}: task ${status}${changes.length > 0 ? `; ${changes.join(", ")}` : ""}`,
      ]
    })
    .slice(0, OWED)

/** Open here: items, expectations, what's owed. */
/** What the user changed in an item's drafts on the card or in a draft's copy, not yet approved. */
const editedOn = (db: Database, id: string) => {
  const item = getItem(db, id)
  return Object.entries(item?.edits ?? {})
    .filter(([, e]) => e.text !== e.base)
    .map(([name, e]) => `  - ${changesLine(name, e.base, e.text)}`)
}

export const openHere = (db: Database, space: SpaceId, thread: ThreadId, now: number) => {
  // Each with its id, so the agent can close, revise or follow it.
  const items = db
    .query<{ id: string; title: string; kind: string | null; space: string; revising: number }, []>(
      `SELECT id, json_extract(data, '$.title') AS title, json_extract(data, '$.kind') AS kind, space,
         json_extract(data, '$.revising') IS NOT NULL AS revising
         FROM action_items WHERE status = 'open' ORDER BY opened_at DESC`,
    )
    .all()
  const here = items.filter((i) => i.space === space)
  const elsewhereN = items.length - here.length
  const expected = openExpectations(db)
    .filter((x) => x.space === space || x.thread === thread)
    .slice(0, EXPECTED)
    .map((x) => {
      const marks = [
        x.by === null ? "" : until(x.by, now),
        x.when === null ? "" : "watching",
        x.promise ? "promise" : "",
        x.wokeAt === null ? "" : "woke",
      ].filter((m) => m !== "")
      return `- ${x.id}: ${clip(x.what, 120)} (${marks.join(", ")})`
    })
  const shown = here.slice(0, ITEMS).map((i) => ({ i, edits: editedOn(db, i.id) }))
  const waiting = [
    ...shown.flatMap(({ i, edits }) => [
      `- ${i.id}: ${clip(i.title, 100)} (${i.kind ?? "task"}${i.revising ? ", out of their queue: revising" : ""})`,
      ...(edits.length > 0
        ? ["  The user's edits of its drafts, saved, not approved:", ...edits]
        : []),
    ]),
    elsewhereN > 0 ? `- ${elsewhereN} more elsewhere` : "",
    shown.some((x) => x.edits.length > 0)
      ? "Revising a draft they edited: build on their edit, never your earlier version."
      : "",
  ].filter((l) => l !== "")
  const debts = owed(db, thread, now)
  return [
    waiting.length > 0 ? `Waiting on the user:\n${waiting.join("\n")}` : "",
    expected.length > 0 ? `Expecting:\n${expected.join("\n")}` : "",
    debts.length > 0 ? `Owed:\n${debts.join("\n")}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n\n")
}

/** Surprises this turn hasn't heard. */
export const surprisesFor = (db: Database, space: SpaceId, thread: ThreadId, seen: number) => {
  const fresh = unheard(db, space, thread, seen).slice(0, SURPRISES)
  return fresh.length > 0
    ? `Surprises:\n${fresh.map((s) => `- ${clip(s.text, 160)} [${s.id}]`).join("\n")}`
    : ""
}

interface Latest {
  readonly machine: string
  readonly payload: string
  readonly time: number
}

/** The newest event of `type` from each machine in the last day. */
/** Each machine's latest `<extension>.<name>` event of the day, from any extension. */
const latestPerMachine = (db: Database, name: string, now: number) =>
  db
    .query<Latest, [number]>(
      `SELECT json_extract(payload, '$.machine') AS machine, payload, max(time) AS time FROM events
       WHERE type IN (${extensionsEvent(name)}) AND seq >= ? GROUP BY json_extract(payload, '$.machine')`,
    )
    .all(seqAt(db, now - 24 * HOUR))
    .map((r) => ({ machine: r.machine, p: parse(r.payload), time: r.time }))

/** What's off, if anything: logins, failing turns, a Mac short of disk or memory, surprises open. */
export const healthLine = (db: Database, now: number) => {
  const off: string[] = []
  for (const a of allAccounts(db)) {
    if (a.problem !== "") {
      off.push(`${a.host}: ${a.problem}`)
    } else if (!a.up && a.limitedUntil > now) {
      off.push(`${a.host} at its limit ${until(a.limitedUntil, now)}`)
    }
  }
  // Each failure with what it failed on, as Switchboard's work view gave it ("Your turn failed: …",
  // core/context.rs:1087): a count alone left the agent to guess a cause.
  const failed = db
    .query<{ thread: string; why: string | null }, [number]>(
      `SELECT json_extract(payload, '$.thread') AS thread, json_extract(payload, '$.result') AS why
       FROM events WHERE type = 'turn.ended' AND seq >= ? AND json_extract(payload, '$.status') = 'failed'`,
    )
    .all(seqAt(db, now - HOUR))
  if (failed.length > 0) {
    const why = new Map<string, Set<string>>()
    for (const f of failed) {
      const reason = clip(f.why ?? "", 300) || "no reason recorded"
      why.set(reason, (why.get(reason) ?? new Set()).add(f.thread))
    }
    const reasons = [...why].map(([reason, threads]) => `${[...threads].join(", ")}: ${reason}`)
    off.push(
      `${failed.length} ${failed.length === 1 ? "turn" : "turns"} failed in the last hour (${reasons.join("; ")})`,
    )
  }
  for (const v of latestPerMachine(db, "vitals", now)) {
    const disk = at(v.p, "diskFreeGb")
    const pressure = str(at(v.p, "pressure"))
    if (typeof disk === "number" && disk < 15) {
      off.push(`${v.machine} disk ${disk.toFixed(1)} GB free`)
    }
    if (pressure !== "" && pressure !== "normal") {
      off.push(`${v.machine} memory pressure ${pressure}`)
    }
  }
  const open = openSurprises(db)
  const stopped = open.filter((s) => s.kind === "stopped").map((s) => s.id.replace("stopped:", ""))
  if (stopped.length > 0) {
    off.push(`stopped: ${stopped.slice(0, 4).join(", ")}`)
  }
  if (open.length > 0) {
    off.push(`${open.length} surprises open`)
  }
  return off.length > 0 ? `Health: ${off.join(" · ")}` : ""
}
