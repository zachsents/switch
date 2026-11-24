// The disk as this extension watches it: the census every six hours, what each piece of work's
// build folders hold every ten minutes, and a forecast that says, a day or two ahead, when it'll be
// low and what grew. Each is an event, so triage can wake a turn on a disk about to fill. Nothing
// is deleted unless `make_room` is called.
import path from "node:path"
import { Effect, Schema } from "effect"

import { AppEvents, defineEvent, tool } from "switch-ext-kit"
import { census, free, GB, outlook } from "./disk.ts"
import { said, watch } from "./health.ts"
import { byHolder, byWork, freedOf, makeRoom, scan } from "./sweeps.ts"
import type { ByWork, Cleared, Swept } from "./sweeps.ts"

const MINUTE = 60_000
const machine = process.env.SWITCH_MACHINE ?? "mac"
const look = outlook(path.join(process.cwd(), "disk.json"))

const gb = (bytes: number) => Math.round((bytes / GB) * 10) / 10

const holder = Schema.Struct({
  name: Schema.String,
  path: Schema.optionalKey(Schema.String),
  gb: Schema.Finite,
  clears: Schema.Boolean,
  count: Schema.optionalKey(Schema.Finite),
  grewGb: Schema.optionalKey(Schema.Finite),
  clearedGb: Schema.optionalKey(Schema.Finite),
})

/** What holds the disk, from the census every six hours. */
export const DiskUse = defineEvent(
  "macos.disk_use",
  1,
  Schema.Struct({
    machine: Schema.String,
    at: Schema.String,
    freeGb: Schema.Finite,
    fallingGbADay: Schema.optionalKey(Schema.Finite),
    overDays: Schema.optionalKey(Schema.Finite),
    underGb: Schema.optionalKey(Schema.Finite),
    inDays: Schema.optionalKey(Schema.Finite),
    grewOverDays: Schema.optionalKey(Schema.Finite),
    holders: Schema.Array(holder),
  }),
)

/** The disk will be low within two days. */
export const DiskLow = defineEvent(
  "macos.disk_low",
  1,
  Schema.Struct({
    machine: Schema.String,
    severity: Schema.String,
    text: Schema.String,
    freeGb: Schema.Finite,
    fallingGbADay: Schema.optionalKey(Schema.Finite),
    inDays: Schema.optionalKey(Schema.Finite),
    grew: Schema.Array(
      Schema.Struct({ name: Schema.String, gb: Schema.Finite, clearedGb: Schema.Finite }),
    ),
  }),
)

/** A piece of work's build folders went over (or back under) its 8 GB budget. */
export const DiskByWork = defineEvent(
  "macos.disk_by_work",
  1,
  Schema.Struct({
    machine: Schema.String,
    overBudget: Schema.Array(
      Schema.Struct({ worktree: Schema.String, gb: Schema.Finite, running: Schema.Boolean }),
    ),
  }),
)

// One at a time: a census and make_room would count and delete the same folders and miscount.
let queue: Promise<unknown> = Promise.resolve()
const exclusive = async <A>(f: () => Promise<A>): Promise<A> => {
  const next = queue.catch(() => null).then(f)
  queue = next.catch(() => null)
  return await next
}

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const sweptOf = (c: Cleared) => ({
  machine,
  freedGb: gb(freedOf(c)),
  freeGb: gb(free()),
  folders: c.swept.map((s: Swept) => ({
    folder: s.folder,
    gb: gb(s.freed),
    ...(s.worktree !== undefined && { worktree: s.worktree }),
  })),
  trimmed: c.trimmed.map((t) => ({ name: t.name, freedGb: gb(t.freed) })),
})

let latest: ReturnType<typeof look.facts> | null = null
let works: readonly ByWork[] = []

const takeCensus = async () => {
  const s = await scan()
  const c = await census(s.folders)
  look.counted(c)
  latest = look.facts(c, free())
  return latest
}

// A census can take many minutes (du over every holder); a stall is longer than that.
export const diskLooked = watch("disk", 30 * MINUTE, 2)

/** The disk's watch, while the extension runs. */
export const watchDisk = Effect.gen(function* watching() {
  const events = yield* AppEvents
  const emit = (e: Parameters<typeof events.emit>[0]) => events.emit(e).pipe(Effect.ignore)
  let counted = 0
  let over = ""
  // What failed last time, until it works again: the census is tried again each minute until it
  // does, what each work holds every ten.
  let censusFailed: string | null = null
  let worksFailed: string | null = null
  for (;;) {
    const now = Date.now()
    look.sample(now, free())
    if (look.censusDue(now)) {
      const facts = yield* Effect.result(task(async () => await exclusive(takeCensus)))
      censusFailed = facts._tag === "Failure" ? `census: ${said(facts.failure)}` : null
      if (facts._tag === "Success") {
        yield* emit(DiskUse.make({ machine, ...facts.success }))
        const w = look.warning(machine, now, free())
        if (w !== null) {
          yield* emit(DiskLow.make(w))
        }
      }
    }
    if (now - counted >= 10 * MINUTE) {
      counted = now
      const done = yield* Effect.result(
        task(async () => await exclusive(async () => await byWork(await scan()))),
      )
      worksFailed = done._tag === "Failure" ? `by work: ${said(done.failure)}` : null
      if (done._tag === "Success") {
        works = done.success
        const overBudget = works
          .filter((w) => w.overBudget)
          .map((w) => ({ worktree: w.worktree, gb: w.gb, running: w.running }))
        const key = overBudget.map((w) => w.worktree).join("\n")
        if (key !== over) {
          over = key
          yield* emit(DiskByWork.make({ machine, overBudget }))
        }
      }
    }
    const failed = [censusFailed, worksFailed].filter((f) => f !== null)
    yield* diskLooked(failed.length === 0 ? null : failed.join(", "))
    yield* Effect.sleep("1 minute")
  }
})

export const diskTool = tool(
  "disk",
  {
    description:
      "What holds this Mac's disk: each tool cache, the build folders, simulators, toolchains and models, with what each grew by over three days (counting what make_room cleared), how fast free space is falling and in how many days it'll be low; and each piece of work's (git worktree's) build folders against its 8 GB budget. From the census every six hours; `fresh` takes one now.",
    readOnly: true,
    input: Schema.Struct({ fresh: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    task(async () => {
      const facts = input.fresh === true || latest === null ? await exclusive(takeCensus) : latest
      return { machine, ...facts, works }
    }),
)

export const makeRoomTool = tool(
  "make_room",
  {
    description:
      "Free disk space on this Mac now, before a build or a download: tool caches, then build folders nothing has built in for half an hour and nothing works in, oldest first, until `gb` are free (40 by default). Says what it freed and the biggest build folders left.",
    input: Schema.Struct({ gb: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    task(async () => {
      const done = await exclusive(
        async () => await makeRoom(input.gb === undefined ? undefined : input.gb * GB),
      )
      look.cleared(Date.now(), byHolder(done.cleared))
      return {
        ...sweptOf(done.cleared),
        beforeGb: gb(done.before),
        wantedGb: gb(done.target),
        left: done.held,
      }
    }),
)

export const diskEvents = [DiskUse, DiskLow, DiskByWork]
