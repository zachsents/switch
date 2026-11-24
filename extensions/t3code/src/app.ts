// T3 Code's threads on this machine: a turn finishing, or a thread waiting on the user, as events.
// T3 pushes nothing to an outside client, so its MCP endpoint is polled: each project's open
// (unsettled) threads and their latest runs, compared with the last look, so a turn shorter than
// the poll is still told. The last look is kept in a file, so is a turn that ends while the
// extension is down. Each project, thread and turn is its own: one that fails is kept and tried
// again the next look while the rest go on, and the heartbeat says so. Messages to threads, and new
// threads, go through T3's CLI.
import { readFileSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { AppEvents, defineApp, defineEvent, tool, writeFileAtomic } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"

import { attempt, Heartbeat, makeHeart, some, why } from "./heartbeat.ts"
import { makeT3 } from "./t3.ts"
import type { T3, Unreachable } from "./t3.ts"

const POLL = "4 seconds"
/** A thread first seen with a turn that ended is told only if it ended this lately. */
const FRESH = Temporal.Duration.from({ minutes: 10 })
const UNDER_WAY = ["preparing", "queued", "starting", "running", "waiting"] as const
const ENDED = ["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const
const REPLY_CHARS = 2000
const RECENT = 20
/** An ended turn that couldn't be told is tried again for this long. */
const OWED = Temporal.Duration.from({ hours: 24 })

const link = (thread: string) => `t3-thread://v1/${thread}`

// What the extension reads of T3's answers; the rest is let through.
const ProjectList = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
})
const ThreadList = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      status: Schema.String,
      latestRunId: Schema.NullOr(Schema.String),
      relationshipToParent: Schema.optionalKey(Schema.NullOr(Schema.String)),
      updatedAt: Schema.String,
    }),
  ),
})
const Run = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
})
const ThreadRead = Schema.Struct({
  thread: Schema.Struct({
    threadId: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    status: Schema.String,
    itemCount: Schema.Number,
    pendingRequestCount: Schema.optionalKey(Schema.Number),
  }),
  recentRuns: Schema.Array(Run),
  items: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      runId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})
const Launched = Schema.Struct({ threadId: Schema.String })
const Sent = Schema.Struct({ threadId: Schema.String, delivery: Schema.String })
const PendingList = Schema.Struct({ requestIds: Schema.Array(Schema.String) })
const PendingRead = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String })),
    }),
  ),
})

const ended = Schema.Literals(ENDED)
const question = Schema.Struct({
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
})
const where = {
  thread: Schema.String,
  title: Schema.String,
  project: Schema.String,
  /** Opens the thread in T3 Code. */
  link: Schema.String,
}

/** An agent's turn in a thread ended: done, failed or stopped, with its last reply. */
export const TurnFinished = defineEvent(
  "t3code.turn_finished",
  1,
  Schema.Struct({
    ...where,
    status: ended,
    startedAt: Schema.NullOr(Schema.String),
    completedAt: Schema.NullOr(Schema.String),
    reply: Schema.String,
  }),
)

/** A thread stopped for the user: a question to answer, or an approval. */
export const NeedsInput = defineEvent(
  "t3code.needs_input",
  1,
  Schema.Struct({
    ...where,
    kind: Schema.Literals(["question", "approval"]),
    questions: Schema.Array(question),
  }),
)

const tracked = Schema.Struct({
  thread: Schema.String,
  title: Schema.String,
  project: Schema.String,
  status: Schema.String,
  run: Schema.NullOr(Schema.String),
  /** The last run told as ended. */
  told: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  /** Why its wait couldn't be told; it's tried again the next look. */
  unasked: Schema.optionalKey(Schema.String),
})
type Tracked = typeof tracked.Type
/** A turn that ended but couldn't be told, and why. */
const owed = Schema.Struct({
  thread: Schema.String,
  title: Schema.String,
  project: Schema.String,
  run: Schema.String,
  since: Schema.String,
  why: Schema.String,
})
type Owed = typeof owed.Type
const finished = Schema.Struct({
  thread: Schema.String,
  title: Schema.String,
  project: Schema.String,
  status: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
})
type Finished = typeof finished.Type
const state = Schema.Struct({
  threads: Schema.Array(tracked),
  recent: Schema.Array(finished),
  owed: Schema.optionalKey(Schema.Array(owed)),
})
type State = typeof state.Type
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(state))

const decode =
  <A>(schema: Schema.Codec<A, unknown>) =>
  (raw: unknown) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError((e) => e.message))

const isUnderWay = (status: string) => UNDER_WAY.some((s) => s === status)
const isEnded = (status: string) => ENDED.some((s) => s === status)
const isFresh = (at: string) =>
  Temporal.Instant.compare(Temporal.Instant.from(at).add(FRESH), Temporal.Now.instant()) >= 0

/** A run that was under way and hasn't been told as ended. */
const untold = (t: Tracked) =>
  isUnderWay(t.status) && t.run !== null && t.run !== t.told ? t.run : null
/** What the first look keeps as told: a run that already ended. */
const seed = (t: Tracked) => (isEnded(t.status) ? t.run : null)

type Where = Pick<Tracked, "thread" | "title" | "project">
type Tell = (t: Where, runId: string) => Effect.Effect<void>

const isReply = (i: { readonly type: string; readonly text?: string | null }) =>
  i.type === "assistant_message" && typeof i.text === "string" && i.text !== ""

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

const reasonOf = (e: Unreachable | string) => (typeof e === "string" ? e : e.reason)
const isOff = (e: Unreachable | string) => typeof e !== "string" && e.off === true
const named = (t: Where) => `${t.title} (${t.thread})`

export class Watch extends Context.Service<
  Watch,
  {
    readonly t3: T3
    readonly read: Effect.Effect<State>
    readonly projectName: (id: string) => string
  }
>()("switch/t3code/Watch") {
  static readonly layer = (file: string) =>
    Layer.effect(
      Watch,
      Effect.gen(function* making() {
        const events = yield* AppEvents
        const t3 = makeT3(path.join(path.dirname(file), "t3code-session.json"))
        const loaded = yield* Effect.sync(() => {
          try {
            return Option.some(decodeState(readFileSync(file, "utf-8")))
          } catch {
            return Option.none<State>()
          }
        })
        const ref = yield* Ref.make<State>(
          Option.getOrElse(loaded, () => ({ threads: [], recent: [] })),
        )
        // Nothing to compare the first look with: it only seeds.
        let seeded = Option.isSome(loaded)
        const projects = new Map<string, string>()

        const heart = makeHeart(events)
        let reachable = false
        const save = (s: State) =>
          Effect.sync(() => {
            writeFileAtomic(file, JSON.stringify(s))
          })
        const emit = (draft: Draft) => events.emit(draft)
        const projectName = (id: string) => projects.get(id) ?? id

        const loadProjects = Effect.gen(function* listing() {
          const list = yield* t3
            .call("t3_project_list", {})
            .pipe(Effect.flatMap(decode(ProjectList)))
          projects.clear()
          for (const p of list.projects) {
            projects.set(p.id, p.title)
          }
        })

        /**
         * Every project's open threads, but a provider's own subagents, which run inside their
         * parent's turn; and the projects that couldn't be read, and why. T3 Code quitting midway
         * fails the whole look.
         */
        const open = Effect.gen(function* looking() {
          yield* loadProjects
          const seen: Tracked[] = []
          const missed = new Map<string, string>()
          for (const [id, title] of projects) {
            const got = yield* t3
              .call("t3_thread_list", {
                projectId: id,
                settled: false,
                includeSubagents: false,
                limit: 100,
              })
              .pipe(
                Effect.flatMap(decode(ThreadList)),
                Effect.map(Option.some),
                Effect.catch((error) =>
                  isOff(error)
                    ? Effect.fail(error)
                    : Effect.sync(() => {
                        missed.set(title, reasonOf(error))
                        return Option.none<typeof ThreadList.Type>()
                      }),
                ),
              )
            if (Option.isNone(got)) {
              continue
            }
            for (const t of got.value.threads) {
              if (t.relationshipToParent !== "subagent") {
                seen.push({
                  thread: t.threadId,
                  title: t.title,
                  project: title,
                  status: t.status,
                  run: t.latestRunId,
                  told: null,
                  updatedAt: t.updatedAt,
                })
              }
            }
          }
          return { seen, missed }
        })

        const readThread = (thread: string, args: object = {}) =>
          t3
            .call("t3_thread_read", { threadId: thread, ...args })
            .pipe(Effect.flatMap(decode(ThreadRead)))

        /** The thread's last reply in `run`, else its last reply at all. */
        const lastReply = (head: typeof ThreadRead.Type, run: string | null) =>
          Effect.gen(function* replying() {
            const tail = yield* readThread(head.thread.threadId, {
              view: "messages",
              afterPosition: Math.max(0, head.thread.itemCount - 12),
              limit: 12,
              maxCharsPerItem: REPLY_CHARS,
            })
            const replies = tail.items.filter(isReply)
            const reply = replies.findLast((i) => i.runId === run) ?? replies.at(-1)
            return clip(reply?.text ?? "", REPLY_CHARS)
          })

        /** Tells that `runId` ended, if it did. */
        const tellFinished = (was: Where, runId: string) =>
          Effect.gen(function* telling() {
            const head = yield* readThread(was.thread, { limit: 1, runLimit: 5 })
            const run = head.recentRuns.find((r) => r.runId === runId)
            const status = Option.getOrUndefined(Schema.decodeUnknownOption(ended)(run?.status))
            if (run === undefined || status === undefined) {
              return Option.none<Finished>()
            }
            const reply = yield* lastReply(head, run.runId)
            yield* emit(
              TurnFinished.make({
                thread: was.thread,
                title: head.thread.title,
                project: was.project,
                link: link(was.thread),
                status,
                startedAt: run.startedAt,
                completedAt: run.completedAt,
                reply,
              }),
            )
            return Option.some<Finished>({
              thread: was.thread,
              title: head.thread.title,
              project: was.project,
              status,
              completedAt: run.completedAt,
            })
          })

        const tellWaiting = (now: Tracked) =>
          Effect.gen(function* asking() {
            const pending = yield* t3
              .call("t3_pending_request_list", { threadId: now.thread })
              .pipe(Effect.flatMap(decode(PendingList)))
            const questions: (typeof question.Type)[] = []
            for (const requestId of pending.requestIds) {
              const read = yield* t3
                .call("t3_pending_request_read", { threadId: now.thread, requestId })
                .pipe(Effect.flatMap(decode(PendingRead)))
              for (const q of read.questions) {
                questions.push({
                  header: q.header,
                  question: clip(q.question, REPLY_CHARS),
                  options: q.options.map((o) => o.label),
                })
              }
            }
            yield* emit(
              NeedsInput.make({
                thread: now.thread,
                title: now.title,
                project: now.project,
                link: link(now.thread),
                kind: questions.length > 0 ? "question" : "approval",
                questions,
              }),
            )
          })

        /**
         * What changed on one open thread since the last look; answers the last run told, and why
         * its wait couldn't be told, if it couldn't.
         */
        const compare = (n: Tracked, w: Tracked | undefined, tell: Tell) =>
          Effect.gen(function* comparingOne() {
            let told = w ? w.told : null
            // The run under way last time ended, and another began since.
            const before = w ? untold(w) : null
            if (before !== null && before !== n.run) {
              yield* tell(n, before)
            }
            const fresh = w !== undefined || isFresh(n.updatedAt)
            if (isEnded(n.status) && n.run !== null && n.run !== told && fresh) {
              yield* tell(n, n.run)
              told = n.run
            }
            const asking =
              n.status === "waiting" &&
              (w?.status !== "waiting" || w.run !== n.run || w.unasked !== undefined)
            const unasked = asking ? yield* attempt(tellWaiting(n)) : null
            return { told, unasked }
          })

        const look = Effect.gen(function* comparing() {
          const before = yield* Ref.get(ref)
          const { seen, missed } = yield* open
          reachable = true
          const was = new Map(before.threads.map((t) => [t.thread, t]))
          const done: Finished[] = []
          const now = Temporal.Now.instant()
          const stillOwed: Owed[] = []
          const tellOwing =
            (since: string): Tell =>
            (t, runId) =>
              Effect.gen(function* telling() {
                const told = yield* Effect.exit(tellFinished(t, runId))
                if (told._tag === "Failure") {
                  const { thread, title, project } = t
                  stillOwed.push({
                    thread,
                    title,
                    project,
                    run: runId,
                    since,
                    why: why(told.cause),
                  })
                } else if (Option.isSome(told.value)) {
                  done.push(told.value.value)
                }
              })
          const tell = tellOwing(now.toString())
          // Turns that couldn't be told before, but one a day old is let go.
          for (const o of before.owed ?? []) {
            if (Temporal.Instant.compare(Temporal.Instant.from(o.since).add(OWED), now) >= 0) {
              yield* tellOwing(o.since)(o, o.run)
            }
          }
          const threads: Tracked[] = []
          const unreadable: [string, string][] = []
          for (const n of seen) {
            const w = was.get(n.thread)
            // Nothing to compare the first look with: it only seeds.
            const got = yield* Effect.exit(
              seeded ? compare(n, w, tell) : Effect.succeed({ told: seed(n), unasked: null }),
            )
            if (got._tag === "Failure") {
              // Kept as it was, so the next look compares it again.
              unreadable.push([named(n), why(got.cause)])
              if (w !== undefined) {
                threads.push(w)
              }
              continue
            }
            const { told, unasked } = got.value
            threads.push({ ...n, told, ...(unasked === null ? {} : { unasked }) })
          }
          // A project that couldn't be read keeps its threads as they were.
          const kept = before.threads.filter((t) => missed.has(t.project))
          threads.push(...kept)
          // Gone from the open list (settled, archived, removed) while a run was under way.
          const listed = new Set([...seen, ...kept].map((t) => t.thread))
          for (const w of was.values()) {
            const run = untold(w)
            if (seeded && !listed.has(w.thread) && run !== null) {
              yield* tell(w, run)
            }
          }
          seeded = true
          const next: State = {
            threads,
            recent: [...done.toReversed(), ...before.recent].slice(0, RECENT),
            owed: stillOwed,
          }
          yield* Ref.set(ref, next)
          heart.set("state", yield* attempt(save(next)))
          heart.set("projects", some([...missed]))
          heart.set("threads", some(unreadable))
          heart.set("turns not told", some(stillOwed.map((o) => [named(o), o.why] as const)))
          const waits = threads.flatMap((t) =>
            t.unasked === undefined ? [] : [[named(t), t.unasked] as const],
          )
          heart.set("waits not told", some(waits))
          return missed.size + unreadable.length + waits.length
        })

        let skipped = 0
        /** One look, whatever it meets, then the beat. */
        const round = Effect.gen(function* rounding() {
          const got = yield* Effect.exit(look)
          if (got._tag === "Success") {
            skipped = got.value
            heart.set("T3 Code", null)
          } else {
            const e = Cause.squash(got.cause)
            reachable = false
            // T3 Code simply not running is no failure.
            heart.set(
              "T3 Code",
              typeof e === "object" && e !== null && "off" in e && e.off === true
                ? null
                : why(got.cause),
            )
          }
          const s = yield* Ref.get(ref)
          yield* heart.beat({
            reachable,
            threads: s.threads.length,
            underWay: s.threads.filter((t) => isUnderWay(t.status)).length,
            untold: s.owed?.length ?? 0,
            skipped,
          })
        })

        yield* Effect.forkScoped(Effect.forever(Effect.andThen(round, Effect.sleep(POLL))))

        return { t3, read: Ref.get(ref), projectName }
      }),
    )
}

const threads = tool(
  "threads",
  {
    description:
      "T3 Code threads with a turn under way (running, or waiting on the user), and turns that ended lately, newest first.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const s = yield* (yield* Watch).read
      return {
        underWay: s.threads
          .filter((t) => isUnderWay(t.status))
          .map((t) => ({
            thread: t.thread,
            title: t.title,
            project: t.project,
            status: t.status,
            link: link(t.thread),
          })),
        ended: s.recent.map((t) => ({ ...t, link: link(t.thread) })),
      }
    }),
)

const thread = tool(
  "thread",
  {
    description: "One T3 Code thread: its status, latest runs and last reply.",
    readOnly: true,
    input: Schema.Struct({ thread: Schema.String }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const watch = yield* Watch
      const head = yield* watch.t3
        .call("t3_thread_read", { threadId: input.thread, limit: 1, runLimit: 3 })
        .pipe(
          Effect.mapError((e) => e.reason),
          Effect.flatMap(decode(ThreadRead)),
        )
      const tail = yield* watch.t3
        .call("t3_thread_read", {
          threadId: input.thread,
          view: "messages",
          afterPosition: Math.max(0, head.thread.itemCount - 12),
          limit: 12,
          maxCharsPerItem: 4000,
        })
        .pipe(
          Effect.mapError((e) => e.reason),
          Effect.flatMap(decode(ThreadRead)),
        )
      const reply = tail.items.findLast(isReply)
      return {
        thread: head.thread.threadId,
        title: head.thread.title,
        project: watch.projectName(head.thread.projectId),
        status: head.thread.status,
        pendingQuestions: head.thread.pendingRequestCount ?? 0,
        runs: head.recentRuns,
        reply: reply?.text ?? "",
        link: link(head.thread.threadId),
      }
    }),
)

/** The words as they reach the thread: a user turn, so it says who sent it and where to answer. */
const fromSwitch = (space: string, text: string) =>
  `(From Switch, space ${space}: answer with the switch tools post or ask.)\n\n${text}`

const projects = tool(
  "projects",
  { description: "T3 Code's projects, to start a thread in.", readOnly: true },
  () =>
    Effect.gen(function* listing() {
      const list = yield* (yield* Watch).t3.call("t3_project_list", { limit: 100 }).pipe(
        Effect.mapError((e) => e.reason),
        Effect.flatMap(decode(ProjectList)),
      )
      return list.projects.map((p) => ({ project: p.id, title: p.title }))
    }),
)

const send = tool(
  "send",
  {
    description:
      "Sends a message into a T3 Code thread; a busy thread gets it as its next turn. space: the Switch space its agent should answer in.",
    input: Schema.Struct({ thread: Schema.String, space: Schema.String, text: Schema.String }),
  },
  (input) =>
    Effect.gen(function* sending() {
      const out = yield* (yield* Watch).t3
        .cli(["thread", "send", "--json", input.thread, fromSwitch(input.space, input.text)])
        .pipe(Effect.mapError((e) => e.reason))
      const sent = yield* decode(Schema.fromJsonString(Sent))(out)
      return { thread: sent.threadId, delivery: sent.delivery, link: link(sent.threadId) }
    }),
)

const start = tool(
  "start",
  {
    description:
      "Starts a T3 Code thread in a project (from projects) with a first message. space: the Switch space its agent should answer in.",
    input: Schema.Struct({
      project: Schema.String,
      title: Schema.String,
      space: Schema.String,
      text: Schema.String,
    }),
  },
  (input) =>
    Effect.gen(function* starting() {
      const out = yield* (yield* Watch).t3
        .cli([
          "thread",
          "start",
          "--json",
          "--title",
          input.title,
          input.project,
          fromSwitch(input.space, input.text),
        ])
        .pipe(Effect.mapError((e) => e.reason))
      const launched = yield* decode(Schema.fromJsonString(Launched))(out)
      return { thread: launched.threadId, link: link(launched.threadId) }
    }),
)

export const t3codeApp = defineApp<Watch>({
  name: "t3code",
  version: "1",
  instructions:
    "T3 Code, the coding agent app on this computer: its threads (threads, thread), messages into them (send) and new ones (projects, start), and an event when an agent's turn ends (t3code.turn_finished) or a thread waits on the user (t3code.needs_input). To tell the user when one finishes, expect its turn_finished.",
  tools: [threads, thread, projects, send, start],
  events: [TurnFinished, NeedsInput, Heartbeat],
})
