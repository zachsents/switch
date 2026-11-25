// A card's draft that also lives elsewhere (an email draft in the user's mailbox, `copy` on the
// draft) is kept as one version with it: his edit on the card goes to the copy, and his edit in the
// copy comes to the card as his edit. They're brought together when the card opens, before the agent
// revises it, before Approve & send runs, after each change on the card, and every minute while it's
// open. The user, Nov 23: "if I edit a draft either in Gmail or in the little editor in the task, I
// want the agent to be aware of it."
import { Brain, defineRead, EventId } from "@switch/brain"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"

import { sameWords } from "./draft-words.ts"
import { agreedOn, EditItem, getItem, ItemAgreed, shownText } from "./items.ts"
import type { ActionItem, Answer } from "./items.ts"

/** An extension's tool, called for the core: its structured result; it throws when the tool fails. */
type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>

type Copy = NonNullable<NonNullable<ActionItem["drafts"]>[number]["copy"]>

const decodeText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))

/** What a copy and its card last agreed on, null before anything's known. */
const agreedRead = defineRead("autonomy/draft-copies/agreed", agreedOn)
/** An item as it stands. */
const itemRead = defineRead("autonomy/draft-copies/item", getItem)

export class DraftCopies extends Context.Service<
  DraftCopies,
  {
    /** The gateway's way to call an extension's tool, once it's up. */
    readonly from: (call: Call) => void
    /** Brings each copied draft of an open item and its copy to one version; his newer side wins. */
    readonly sync: (id: string) => Effect.Effect<void>
    /**
     * An approval's drafts as he left them: the card's (his saved edit when the answer has none),
     * or a copy's words where he edited only the copy since they last agreed.
     */
    readonly approved: (item: ActionItem, answer: Answer) => Effect.Effect<Answer>
  }
>()("switch/DraftCopies") {
  static readonly layer = Layer.effect(
    DraftCopies,
    Effect.gen(function* copies() {
      const brain = yield* Brain
      const lane = yield* Semaphore.make(1)
      let call: Call | null = null

      /** What a copy and its card agree on now, kept in the brain (`item.agreed`). */
      const agree = (id: string, name: string, text: string) =>
        Effect.gen(function* agreeing() {
          if ((yield* brain.read(agreedRead, id, name)) === text) {
            return
          }
          yield* Effect.ignore(
            brain.ingest([
              {
                id: EventId.make(`agreed:${id}:${name}:${crypto.randomUUID()}`),
                type: ItemAgreed.type,
                source: "core",
                payload: { id, name, text },
              },
            ]),
            { log: "Warn" },
          )
        })

      /** Its words now; null when it's gone (sent, deleted) or can't be read. */
      const read = (copy: Copy, text?: string) =>
        Effect.tryPromise(async () => {
          const given = call
          return given === null
            ? null
            : await given(`${copy.app}_${copy.tool}`, {
                ...copy.args,
                ...(text !== undefined && { text }),
              })
        }).pipe(
          Effect.map((r) => Option.getOrNull(Option.map(decodeText(r), (t) => t.text))),
          Effect.orElseSucceed(() => null),
        )

      /** What they last agreed on; before anything's known, the side he hasn't touched. */
      const lastAgreed = (item: ActionItem, name: string, there: string) =>
        Effect.map(
          brain.read(agreedRead, item.id, name),
          (was) => was ?? (item.edits[name] === undefined ? shownText(item, name) : there),
        )

      const sync = (id: string) =>
        lane.withPermit(
          Effect.gen(function* syncing() {
            const item = yield* brain.read(itemRead, id)
            if (item?.status !== "open" || call === null) {
              return
            }
            for (const d of item.drafts ?? []) {
              if (!d.copy) {
                continue
              }
              const there = yield* read(d.copy)
              if (there === null) {
                continue
              }
              const card = shownText(item, d.name)
              const was = yield* lastAgreed(item, d.name, there)
              if (!sameWords(card, was)) {
                // His edit on the card, or the agent's revision: the copy takes it. Words cleared on
                // the card leave that draft out of the send; the copy keeps its own.
                if (card.trim() === "") {
                  continue
                }
                if ((yield* read(d.copy, card)) !== null) {
                  yield* agree(id, d.name, card)
                }
              } else if (sameWords(there, was)) {
                yield* agree(id, d.name, there)
              } else {
                // His edit in the copy: the card takes it, as his.
                yield* Effect.ignore(
                  brain.dispatch({
                    id: crypto.randomUUID(),
                    type: EditItem.type,
                    source: "core",
                    payload: { id, drafts: { [d.name]: there }, copy: true },
                  }),
                  { log: "Warn" },
                )
                yield* agree(id, d.name, there)
              }
            }
          }),
        )

      const approved = (item: ActionItem, answer: Answer) =>
        lane.withPermit(
          Effect.gen(function* approving() {
            const drafts = item.drafts ?? []
            if (answer.approved !== true || drafts.length === 0) {
              return answer
            }
            const left: Record<string, string> = {}
            for (const d of drafts) {
              const card = shownText(item, d.name)
              const given = answer.drafts?.[d.name] ?? card
              const there = d.copy ? yield* read(d.copy) : null
              const was = there === null ? null : yield* lastAgreed(item, d.name, there)
              left[d.name] =
                there !== null &&
                was !== null &&
                sameWords(given, card) &&
                sameWords(card, was) &&
                !sameWords(there, was)
                  ? there
                  : given
            }
            const edited = drafts.filter((d) => left[d.name] !== d.text).map((d) => d.name)
            const out = { ...answer, drafts: left }
            delete out.edited
            return edited.length > 0 ? { ...out, edited } : out
          }),
        )

      return {
        from: (given: Call) => {
          call = given
        },
        sync,
        approved,
      }
    }),
  )
}
