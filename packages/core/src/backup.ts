// Backups of every store, by the live release's backup.sh (scripts/backup.sh says what and where):
// nightly, and after each deploy's swap with the brain as it was before the migration (POST
// /backup, from ship.sh). The core runs them so they have its disk access. One that fails is a
// surprise for the agent, never the user's chat; the next that works resolves it.
import path from "node:path"
import { Sessions } from "@switch/agent"
import { openSurprises, resolveSurprise } from "@switch/autonomy"
import { Brain, HOME } from "@switch/brain"
import { Effect, Layer, Semaphore } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { CoreConfig } from "./config.ts"
import { troubled } from "./trouble.ts"

const SURPRISE = "backup:"
/** When the nightly one runs, by this machine's clock. */
const NIGHTLY = Temporal.PlainTime.from("03:30")

const run = (label: string, brain: string | null) =>
  Effect.gen(function* backingUp() {
    const c = yield* CoreConfig
    const script = path.join(c.dir, "current", "backup.sh")
    const lock = path.join(c.dir, "backup.lock")
    const result = yield* Effect.promise(async () => {
      const proc = Bun.spawn(
        // At background priority: it mustn't starve the machine's work.
        [
          "/usr/sbin/taskpolicy",
          "-b",
          "/usr/bin/lockf",
          "-t",
          "3600",
          lock,
          "/bin/sh",
          script,
          label,
          ...(brain === null || brain === "" ? [] : [brain]),
        ],
        { stdout: "ignore", stderr: "pipe", env: { ...process.env, SWITCH_DIR: c.dir } },
      )
      const said = await new Response(proc.stderr).text()
      return { code: await proc.exited, said: said.trim().split("\n").at(-1) ?? "" }
    })
    if (result.code === 0) {
      const brainService = yield* Brain
      const open = yield* brainService.read((db) =>
        openSurprises(db).filter((s) => s.id.startsWith(SURPRISE)),
      )
      for (const s of open) {
        yield* resolveSurprise(s.id)
      }
      return
    }
    const why = result.said === "" ? `exit ${result.code}` : result.said
    yield* troubled({ id: `${SURPRISE}${why}`, space: HOME, text: `A backup failed: ${why}` })
  }).pipe(Effect.ignore({ log: "Warn", message: "A backup couldn't run" }))

/** One at a time in this core; backup.lock keeps others off too. */
const lane = Semaphore.makeUnsafe(1)
const queued = (label: string, brain: string | null) => lane.withPermits(1)(run(label, brain))

const untilNightly = () => {
  const now = Temporal.Now.zonedDateTimeISO()
  let next = now.withPlainTime(NIGHTLY)
  if (Temporal.ZonedDateTime.compare(next, now) <= 0) {
    next = next.add({ days: 1 })
  }
  return next.epochMilliseconds - now.epochMilliseconds
}

/** The nightly backup: not in a canary. */
export const backupWorker = Layer.effectDiscard(
  Effect.gen(function* nightly() {
    const c = yield* CoreConfig
    if (c.canary) {
      return
    }
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* waiting() {
          yield* Effect.sleep(untilNightly())
          yield* queued("nightly", null)
        }),
      ),
    )
  }),
)

// The deploy, on this machine (admin only, auth.ts): `label` names the snapshot, `brain` the copy
// it took before its migration. Answers at once; the backup runs on.
export const backupRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const config = yield* CoreConfig
    const brain = yield* Brain
    const sessions = yield* Sessions
    return HttpRouter.add(
      "POST",
      "/backup",
      Effect.gen(function* starting() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = new URL(request.url, "http://core").searchParams
        const label = (params.get("label") ?? "").replaceAll(/[^\w.-]/gu, "")
        if (label === "") {
          return HttpServerResponse.text("No label", { status: 400 })
        }
        yield* Effect.forkDetach(
          queued(label, params.get("brain")).pipe(
            Effect.provideService(CoreConfig, config),
            Effect.provideService(Brain, brain),
            Effect.provideService(Sessions, sessions),
          ),
        )
        return HttpServerResponse.text("Started", { status: 202 })
      }),
    )
  }),
)
