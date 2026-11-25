// Who sent what comes in: every event with a sender gets its Contacts link before it lands. What
// leaves in the user's name is the outbound gate's (asks.ts).
import { Brain, defineRead } from "@switch/brain"
import type { Incoming } from "@switch/brain"
import { linked } from "@switch/gateway"
import { isJson, isSender } from "switch-ext-kit"
import type { Sender } from "switch-ext-kit"
import { Effect } from "effect"

/** Links an event's sender to Contacts by phone, email or handle. */
export const enrich = Effect.gen(function* enriching() {
  const brain = yield* Brain
  return (e: Incoming) => link(brain, e)
})

/** The person in Contacts a sender is, if any: `linked` adds it to a sender with none. */
const personRead = defineRead(
  "core/outbound/person",
  (db, sender: Sender) => linked(db, sender).person ?? null,
)

const link = (brain: typeof Brain.Service, e: Incoming) => {
  const p = e.payload
  if (!isJson(p) || !isSender(p.sender) || p.sender.person !== undefined) {
    return Effect.succeed(e)
  }
  const { sender } = p
  return brain
    .read(personRead, sender)
    .pipe(
      Effect.map((person) =>
        person === null ? e : { ...e, payload: { ...p, sender: { ...sender, person } } },
      ),
    )
}
