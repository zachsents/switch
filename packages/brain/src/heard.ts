import type { Database } from "bun:sqlite"

/**
 * Whether the thread is a task none of the user's own words have reached in its turn under way.
 * A task's prompt and its parent's follow-ups are the parent agent's, recorded as a turn's words
 * like the user's; only a steer the user sent it (`thread.steered`, from a client) is theirs.
 * Switchboard's say refused such a task (sb/mcp.rs:478-482): what's for the user goes in its report.
 */
export const unheardTask = (db: Database, thread: string) => {
  const row = db
    .query<{ parent: string | null; first: number | null; last: number | null }, [string]>(
      `SELECT t.parent, span.first, span.last FROM threads t
         LEFT JOIN turn_spans span ON span.turn = t.turn WHERE t.thread = ?`,
    )
    .get(thread)
  if (row === null || row.parent === null) {
    return false
  }
  if (row.first === null || row.last === null) {
    return true
  }
  // The user's steer that started this turn came after the turn before it ended.
  const after =
    db
      .query<{ last: number | null }, [string, number]>(
        "SELECT max(last) AS last FROM turn_spans WHERE thread = ? AND first < ?",
      )
      .get(thread, row.first)?.last ?? 0
  const heard = db
    .query<{ n: number }, [number, number, string]>(
      `SELECT count(*) AS n FROM events WHERE seq > ? AND seq <= ? AND type = 'thread.steered'
         AND json_extract(payload, '$.thread') = ? AND trim(json_extract(payload, '$.text')) != ''`,
    )
    .get(after, row.last, thread)
  return (heard?.n ?? 0) === 0
}
