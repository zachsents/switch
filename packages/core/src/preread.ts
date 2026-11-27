// The pre-read (CONCEPTS: Attention). Only the effort comes before the turn: one decision-model
// call (~200 ms). The rest (misheard names, a title, a brain dump's split) runs beside the turn
// and reaches it as a note. Neither holds a message up: on any failure it goes as it is, untitled.
import { allSpaces, EFFORTS, HOME, saidBy, SpaceId, spaceMessages, userName } from "@switch/brain"
import type { Effort } from "@switch/brain"
import type { Database } from "bun:sqlite"
import { Models } from "@switch/models"
import { Effect, Schema } from "effect"

const SYSTEM = `You pre-read the user's messages for Switch, their agent, before it sees them. Many are dictated. Reply with one JSON object and nothing else:
{"text": string, "title": string, "parts": [{"space": string, "text": string}]}
- text: "" unless a name was misheard (a person, project, space or tool); then the message word for word with only those names fixed. Words it says were dictated are the likeliest misheard.
- title: 2 to 5 words.
- parts: only for a brain dump covering several spaces: each piece, in its words, under the id of the space it's about. Otherwise [].`

const reply = Schema.Struct({
  text: Schema.String,
  // A title that isn't 2 to 5 words fails the pre-read: no title rather than a cut-down one.
  title: Schema.String.check(Schema.isPattern(/^\s*\S+(?:\s+\S+){1,4}\s*$/u)),
  parts: Schema.Array(Schema.Struct({ space: SpaceId, text: Schema.String })),
})
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(reply))

export interface Read {
  readonly text: string
  readonly title: string
  readonly parts: readonly { readonly space: SpaceId; readonly text: string }[]
  readonly ms: number
  readonly cost: number
}

/** What the model reads besides the message: the spaces and the last lines here. */
export const situation = (db: Database, space: SpaceId) => {
  const spaces = allSpaces(db).filter((s) => !s.archived)
  const list = spaces
    .map((s) => `- ${s.id}: ${s.name}${s.about === "" ? "" : `. ${s.about.slice(0, 160)}`}`)
    .join("\n")
  const user = userName(db)
  const recent = spaceMessages(db, space, 4)
    .map((m) => `- ${saidBy(m, "Switch", user)}: ${m.text.slice(0, 200)}`)
    .join("\n")
  const name = spaces.find((s) => s.id === space)?.name ?? space
  return {
    known: new Set(spaces.map((s) => s.id)),
    text: [
      user === "the user" ? "" : `The user: ${user}`,
      `Spaces (id: name. about):\n${list}`,
      recent === "" ? "" : `Lately in ${name}:\n${recent}`,
      `Posted in: ${space === HOME ? "home" : space}`,
    ]
      .filter((p) => p !== "")
      .join("\n\n"),
  }
}

const strip = (s: string) =>
  s
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")

export const preRead = (
  text: string,
  /** Which of its words were dictated, if any were. */
  note: string,
  at: { readonly known: Set<string>; readonly text: string },
) =>
  Effect.gen(function* reading() {
    const models = yield* Models
    const about = [at.text, note].filter((p) => p !== "").join("\n\n")
    const out = yield* models.complete("triage", SYSTEM, `${about}\n\nMessage:\n${text}`)
    const r = yield* decodeReply(strip(out.text))
    // Parts only for spaces that exist, and only when there's more than one.
    const parts = r.parts.filter((p) => at.known.has(p.space) && p.text.trim() !== "")
    return {
      text: r.text.trim() === "" ? text : r.text,
      title: r.title.trim(),
      parts: parts.length > 1 ? parts : [],
      ms: out.ms,
      cost: out.cost,
    } satisfies Read
  }).pipe(
    Effect.timeout("6 seconds"),
    Effect.tapError((e) => Effect.logWarning(`Pre-read failed: ${String(e)}`)),
    Effect.orElseSucceed((): Read => ({
      text,
      title: "",
      parts: [],
      ms: 0,
      cost: 0,
    })),
  )

const EFFORT = {
  effort: {
    instructions: "How much effort should the agent spend on this message?",
    choices: [
      { value: "low", description: "Chat, thanks, a quick fact or lookup, a one-line answer." },
      { value: "medium", description: "Ordinary work: a small change, a short investigation." },
      { value: "high", description: "Hard multi-step work: debugging, design, a feature." },
      { value: "xhigh", description: "The hardest: deep research, architecture, a long build." },
    ],
  },
}
const STABLE =
  "You set the effort for Switch, the user's agent, before it answers their message. The user's rules and " +
  "preferences, when given, say where their work falls; when nothing does, their default effort."

const isEffort = (v: unknown): v is Effort => EFFORTS.some((e) => e === v)

/** The effort for a message, given the user's rules and default effort, and what deciding cost. */
export const effortOf = (
  text: string,
  user: { readonly rules: string; readonly fallback: Effort },
) =>
  Effect.gen(function* deciding() {
    const models = yield* Models
    // Only a gateway model answers within the budget: a subscription's session takes longer to
    // start, so it would only be started and cut off.
    if ((yield* models.routed("decision")).provider !== "gateway") {
      return { effort: user.fallback, cost: 0 }
    }
    const item = [user.rules, `Their default effort: ${user.fallback}`, `Message: ${text}`]
      .filter((s) => s !== "")
      .join("\n\n")
    const d = yield* models.decide({ stable: STABLE, item }, EFFORT)
    const choice = d.answers.effort?.choice
    return { effort: isEffort(choice) ? choice : user.fallback, cost: d.cost }
  }).pipe(
    Effect.timeout("1500 millis"),
    Effect.tapError((e) => Effect.logWarning(`Effort failed: ${String(e)}`)),
    Effect.orElseSucceed(() => ({ effort: user.fallback, cost: 0 })),
  )
