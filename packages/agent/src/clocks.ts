// A clock (🕐) the agent puts on the user's message is tied to the work it covers: the turn that
// placed it and the tasks delegated from it, transitively, each joining as it opens. When all of it
// ends done, and what a turn left going on (a watch of its own, a script it set) has settled, the
// clock is settled done (core's clocks.ts swaps it for `like`); when any of it fails,
// is stopped or dropped, it's settled failed (and taken back). The agent changing its reaction
// itself ends the clock. All of it follows from the log, so it holds across restarts.
import type { Database } from "bun:sqlite"
import { CLOCK, MessageReacted, on, sideOf } from "@switch/brain"
import type { Projection } from "@switch/brain"

import { carriedOn, TaskDropped, ThreadOpened, ThreadSettled, TurnEnded } from "./events.ts"

export type ClockState = "open" | "done" | "failed"

/** The clocks of the open ones whose work includes `thread` (its turn `turn`, or any). */
const clocksOn = (db: Database, thread: string, turn: string | null) =>
  db
    .query<{ seq: number }, [string, string | null]>(
      `SELECT DISTINCT w.seq FROM clock_work w JOIN clocks c ON c.seq = w.seq
        WHERE c.state = 'open' AND w.thread = ? AND (w.turn IS NULL OR w.turn IS ?)`,
    )
    .all(thread, turn)
    .map((r) => r.seq)

const settle = (db: Database, seq: number, state: ClockState) => {
  db.query("UPDATE clocks SET state = ? WHERE seq = ?").run(state, seq)
  db.query("DELETE FROM clock_work WHERE seq = ?").run(seq)
}

/** A thread's part of each clock it's in is done (its turn `turn`, or any): one with none left is. */
const done = (db: Database, thread: string, turn: string | null) => {
  const seqs = clocksOn(db, thread, turn)
  db.query("DELETE FROM clock_work WHERE thread = ? AND (turn IS NULL OR turn IS ?)").run(
    thread,
    turn,
  )
  const left = db.query<{ n: number }, [number]>(
    "SELECT count(*) AS n FROM clock_work WHERE seq = ?",
  )
  for (const seq of seqs) {
    if ((left.get(seq)?.n ?? 0) === 0) {
      settle(db, seq, "done")
    }
  }
}

const fail = (db: Database, thread: string, turn: string | null) => {
  for (const seq of clocksOn(db, thread, turn)) {
    settle(db, seq, "failed")
  }
}

export const clocks: Projection = {
  name: "clocks",
  version: 1,
  tables: ["clocks", "clock_work"],
  create: `CREATE TABLE clocks (seq INTEGER PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE clock_work (seq INTEGER NOT NULL, thread TEXT NOT NULL, turn TEXT,
      PRIMARY KEY (seq, thread));
    CREATE INDEX clock_work_thread ON clock_work (thread);`,
  on: [
    on(MessageReacted, (db, p, e) => {
      if (p.quote !== undefined || sideOf(e.source) !== "agent") {
        return
      }
      db.query("DELETE FROM clocks WHERE seq = ?").run(p.seq)
      db.query("DELETE FROM clock_work WHERE seq = ?").run(p.seq)
      if (p.reaction !== CLOCK || p.work === undefined) {
        return
      }
      db.query("INSERT INTO clocks (seq, state) VALUES (?, 'open')").run(p.seq)
      const add = db.query("INSERT OR IGNORE INTO clock_work (seq, thread, turn) VALUES (?, ?, ?)")
      add.run(p.seq, p.work.thread, p.work.turn)
      for (const task of p.work.tasks) {
        add.run(p.seq, task, null)
      }
    }),
    // A task opened by work a clock waits on joins it.
    on(ThreadOpened, (db, p) => {
      if (p.parent === null) {
        return
      }
      db.query(
        `INSERT OR IGNORE INTO clock_work (seq, thread, turn)
          SELECT w.seq, ?, NULL FROM clock_work w JOIN clocks c ON c.seq = w.seq
          WHERE c.state = 'open' AND w.thread = ?`,
      ).run(p.thread, p.parent)
    }),
    on(TurnEnded, (db, p) => {
      // A later turn of the thread carries the work on, or what its turn left going: its end counts.
      if (carriedOn(p) || (p.status === "done" && p.going === true)) {
        // A later turn of the thread carries the work on: its end counts.
        db.query("UPDATE clock_work SET turn = NULL WHERE thread = ? AND turn = ?").run(
          p.thread,
          p.turn,
        )
        return
      }
      if (p.status !== "done") {
        fail(db, p.thread, p.turn)
        return
      }
      done(db, p.thread, p.turn)
    }),
    on(ThreadSettled, (db, p) => {
      done(db, p.thread, null)
    }),
    on(TaskDropped, (db, p) => {
      fail(db, p.task, null)
    }),
  ],
  snapshot: () => null,
}

/** The clocks whose work has ended, by the message they're on: each to be swapped or taken back. */
export const settledClocks = (db: Database) =>
  db
    .query<{ seq: number; state: "done" | "failed" }, []>(
      "SELECT seq, state FROM clocks WHERE state != 'open' ORDER BY seq",
    )
    .all()

export const clocksConfig = { events: [], projections: [clocks], commands: [] }
