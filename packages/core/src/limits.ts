// Usage limits, to the user. Work no account can take waits (sessions.ts); they hear of it only when
// nothing they have could take it (the user, Nov 22: "i should be made aware if theres a usage limit,
// but not if other accounts have availability"). When another profile they set up has room, one item
// offers the switch instead, and goes once the limit lifts; nothing switches on its own (Nov 23: "It
// should suggest a switch to Codex but it shouldn't do it automatically"). A profile selected moves
// the work under way over to it (Nov 23: "if i switch back to claude, it should move all existing
// work over too. similar to a redeploy").
import type { Database } from "bun:sqlite"
import { getThread, Hosts, route, Sessions } from "@switch/agent"
import { CloseItem, ItemAnswered, OpenItem } from "@switch/autonomy"
import { Brain, HOME, ItemId, PostMessage, react } from "@switch/brain"
import type { SpaceId, ThreadId } from "@switch/brain"
import type { Profile } from "@switch/models"
import { Effect, Layer, Option, Schema } from "effect"

import { spaceOf } from "./context.ts"
import { currentProfile, profilesState, ProfileSelected, SelectProfile } from "./profiles.ts"

/** A time as the user reads it: today's by the clock, then tomorrow, a weekday, a date (claude/src/accounts.rs:154 `local_time`). */
export const localTime = (ms: number, now: number) => {
  const zone = Temporal.Now.timeZoneId()
  const at = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone)
  const { days } = today.toPlainDate().until(at.toPlainDate(), { largestUnit: "days" })
  const time = at.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })
  if (days <= 0) {
    return time
  }
  if (days === 1) {
    return `tomorrow ${time}`
  }
  if (days <= 6) {
    return `${at.toLocaleString("en-US", { weekday: "long" })} ${time}`
  }
  return `${at.toLocaleString("en-US", { month: "short", day: "numeric" })} ${time}`
}

/**
 * Told in the space when nothing can take its turn, with when the first limit lifts; never when
 * another account carries it on (claude/src/turn.rs:512-538 `waiting`). Once for each waiting
 * work's `key`.
 */
export const waitingNotice = (
  space: SpaceId,
  resetAt: number | null,
  partway: boolean,
  key: string,
) =>
  Effect.gen(function* telling() {
    const brain = yield* Brain
    const around = resetAt === null ? "" : `, around ${localTime(resetAt, Date.now())}`
    const text = partway
      ? `I hit the usage limit on every subscription I run on partway through this, so it waits. I'll pick it back up when one resets${around}.`
      : `Every subscription I run on is at its usage limit right now, so this waits. I'll pick it up when one resets${around}.`
    yield* brain.dispatch({
      id: `told:${key}`,
      type: PostMessage.type,
      source: "agent",
      payload: { space, text },
    })
  })

const SUGGESTION = "limit-switch-"
const SWITCH = "Switch to "

const openSuggestion = (db: Database) =>
  db
    .query<{ id: string }, [string]>(
      "SELECT id FROM action_items WHERE id LIKE ? || '%' AND status = 'open' LIMIT 1",
    )
    .get(SUGGESTION)?.id ?? null

/** Whether, under a profile's own mix, an account could take a turn of `model` ("heavy", a tier, an id) now. */
const roomFor = (profile: Profile, model: string) =>
  Effect.gen(function* checking() {
    const hosts = yield* Hosts
    const at = route(model, profile)
    return Option.isSome(yield* Effect.option(hosts.pick(null, at.provider, undefined, at.account)))
  })

/** The profiles besides the active one under which a turn of `model` could run now. */
const roomyOthers = (model: string) =>
  Effect.gen(function* finding() {
    const brain = yield* Brain
    const state = yield* brain.read(profilesState)
    const active = yield* brain.read(currentProfile)
    const roomy: Profile[] = []
    for (const p of state.profiles.filter((x) => x.name !== active.name)) {
      if (yield* roomFor(p, model)) {
        roomy.push(p)
      }
    }
    return { active, roomy }
  })

/**
 * Work for the user waits on a limit (sessions.ts `waiting`): another profile with room is offered,
 * once a stretch; with none, they're told in the space.
 */
export const limitTold = (
  thread: ThreadId,
  resetAt: number | null,
  partway: boolean,
  key: string,
) =>
  Effect.gen(function* telling() {
    const brain = yield* Brain
    const model = (yield* brain.read((db) => getThread(db, thread)))?.model ?? "heavy"
    const { active, roomy } = yield* roomyOthers(model)
    const [other] = roomy
    if (other === undefined) {
      const space = spaceOf(thread)
      if (space !== null) {
        yield* waitingNotice(space, resetAt, partway, key)
      }
      return
    }
    if ((yield* brain.read(openSuggestion)) !== null) {
      return
    }
    const until = resetAt === null ? "" : ` until ${localTime(resetAt, Date.now())}`
    yield* brain.dispatch({
      id: `told:${key}`,
      type: OpenItem.type,
      source: "core",
      payload: {
        id: ItemId.make(`${SUGGESTION}${crypto.randomUUID().slice(0, 8)}`),
        space: HOME,
        title: "Usage limit",
        body: `${active.name} is at its usage limit${until}. ${other.name} has room.`,
        decision: "core",
        kind: "question",
        app: "switch",
        options: roomy.map((p) => `${SWITCH}${p.name}`),
      } satisfies typeof OpenItem.payload.Type,
    })
  })

const decodeAnswered = Schema.decodeUnknownOption(ItemAnswered.payload)

/**
 * A profile selected moves what's under way to it; the suggestion's answer selects the profile it
 * names; and the suggestion goes once the active profile's turns can run again.
 */
export const limitsWorker = Layer.effectDiscard(
  Effect.gen(function* watching() {
    const brain = yield* Brain
    const sessions = yield* Sessions
    const hosts = yield* Hosts
    // From its cursor: a profile selected, or the suggestion answered, as the core stopped is
    // acted on once it's back; the selection's id is the answer's, so it's made once.
    yield* Effect.forkScoped(
      react(
        "limits",
        (e) => e.type === ProfileSelected.type || e.type === ItemAnswered.type,
        (e) =>
          Effect.gen(function* one() {
            if (e.type === ProfileSelected.type) {
              yield* sessions.move
              return
            }
            const a = Option.getOrNull(decodeAnswered(e.payload))
            if (a === null || !a.id.startsWith(SUGGESTION) || a.choice === undefined) {
              return
            }
            const name = a.choice.startsWith(SWITCH) ? a.choice.slice(SWITCH.length) : ""
            yield* Effect.ignore(
              brain.dispatch({
                id: `limits:${String(e.seq)}`,
                type: SelectProfile.type,
                source: "core",
                payload: { name },
              }),
              { log: "Warn" },
            )
          }),
      ),
    )
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* lifting() {
          yield* Effect.sleep("30 seconds")
          const open = yield* brain.read(openSuggestion)
          if (open === null) {
            return
          }
          // The active profile's turns can run again, or no other has room any more.
          const { active, roomy } = yield* roomyOthers("heavy").pipe(
            Effect.provideService(Hosts, hosts),
            Effect.provideService(Brain, brain),
          )
          const lifted = yield* roomFor(active, "heavy").pipe(Effect.provideService(Hosts, hosts))
          if (lifted || roomy.length === 0) {
            yield* Effect.ignore(
              brain.dispatch({
                id: crypto.randomUUID(),
                type: CloseItem.type,
                source: "core",
                payload: {
                  id: ItemId.make(open),
                  status: "resolved",
                  why: lifted ? "Room again" : "No other profile has room",
                },
              }),
            )
          }
        }),
      ),
    )
  }),
)
