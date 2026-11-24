// What a client does to a thread or its chat: steer, stop, retry, edit the last message. Each is
// recorded, then the chat reactor hands it to the session (chat.ts).
import type { Database } from "bun:sqlite"
import { getThread } from "@switch/agent"
import { defineCommand, MessageEdited, MessagePosted, whoOf } from "@switch/brain"
import type { SpaceId } from "@switch/brain"

import { threadOf } from "./context.ts"
import { outward } from "./outward.ts"
import { EditPayload, RetryPayload, StopPayload, ThreadSteered, ThreadStopped } from "./steered.ts"

export { EditPayload, RetryPayload, StopPayload, ThreadSteered, ThreadStopped } from "./steered.ts"

/** What a retry says to the session: a steer that runs the turn again. */
export const RETRY = "That didn't finish. Try it again."

export const SteerThread = defineCommand({
  type: "thread.steer",
  payload: ThreadSteered.payload,
  load: (db, p) => getThread(db, p.thread) !== null,
  decide: (exists, p) =>
    exists ? { events: [ThreadSteered.make(p)] } : { reject: "No such thread" },
})

export const StopThread = defineCommand({
  type: "thread.stop",
  payload: StopPayload,
  load: (db, p) => getThread(db, p.thread)?.status ?? null,
  decide: (status, p) => {
    if (status === null) {
      return { reject: "No such thread" }
    }
    return { events: status === "running" ? [ThreadStopped.make(p)] : [] }
  },
})

export const RetryThread = defineCommand({
  type: "thread.retry",
  payload: RetryPayload,
  load: (db, p) => getThread(db, p.thread)?.status ?? null,
  decide: (status, p) => {
    if (status === null) {
      return { reject: "No such thread" }
    }
    if (status !== "failed" && status !== "limited" && status !== "interrupted") {
      return { reject: "Nothing to retry" }
    }
    return { events: [ThreadSteered.make({ thread: p.thread, text: RETRY })] }
  },
})

interface Said {
  readonly seq: number
  readonly space: SpaceId
  readonly source: string
  readonly text: string
}

/** The message, whether it's its space's last from the user, and what its work did outside. */
const editable = (db: Database, seq: number) => {
  const said = db
    .query<Said, [number]>("SELECT seq, space, source, text FROM messages WHERE seq = ?")
    .get(seq)
  if (!said) {
    return null
  }
  const later = db
    .query<{ n: number }, [string, number]>(
      "SELECT count(*) AS n FROM messages WHERE space = ? AND seq > ? AND source != 'agent'",
    )
    .get(said.space, seq)
  const thread = threadOf(said.space)
  // The space's thread since the message, and the tasks it delegated since.
  const tools = db
    .query<{ body: string }, [number, string, string]>(
      `SELECT i.body FROM thread_items i WHERE i.seq > ?1 AND json_extract(i.body, '$.kind') = 'tool'
         AND (i.thread = ?2 OR i.thread IN (SELECT thread FROM threads WHERE parent = ?3))`,
    )
    .all(seq, thread, thread)
  return { said, last: (later?.n ?? 0) === 0, acted: tools.some((t) => outward(t.body)) }
}

/**
 * Edits the user's last message in a space and runs it again; once what it started reached
 * outside, running it again can't take that back, so the new words go as a new message.
 */
export const EditMessage = defineCommand({
  type: "message.edit",
  payload: EditPayload,
  load: (db, p) => editable(db, p.seq),
  decide: (state, p) => {
    if (state === null || whoOf(state.said.source) !== "user") {
      return { reject: "No such message" }
    }
    if (!state.last) {
      return { reject: "Not the last message" }
    }
    if (p.text.trim() === "" || p.text === state.said.text) {
      return { events: [] }
    }
    const { space } = state.said
    return state.acted
      ? { events: [MessagePosted.make({ space, text: p.text })] }
      : { events: [MessageEdited.make({ seq: p.seq, text: p.text, was: state.said.text })] }
  },
})

export const steerConfig = {
  events: [ThreadSteered, ThreadStopped],
  projections: [],
  commands: [SteerThread, StopThread, RetryThread, EditMessage],
}
