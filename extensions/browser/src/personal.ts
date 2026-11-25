// On the user's own laptop (its host provides `personal`), the agent doesn't drive its browser,
// unless the call carries `person_asked`: the user's words asking for exactly that on this Mac. Only
// letting tabs go and listing them stay open, so a turn can tidy up. Ported from Switchboard's
// macOS appendage (personal.rs).
import { Schema } from "effect"
import { asked, PERSON_ASKED, personal, refusal } from "switch-ext-kit"

const here = personal()

const TIDYING = new Set(["release", "tabs"])

export const askedField = { [PERSON_ASKED]: Schema.optionalKey(Schema.String) }

/** A guarded tool's description, with what it refuses on the laptop. */
export const marked = (description: string): string =>
  here
    ? `${description} This Mac is the user's own laptop: refused unless they asked for exactly that here (${PERSON_ASKED}: their words, and when); release and tabs always run.`
    : description

const opOf = (step: unknown) =>
  typeof step === "object" && step !== null && "op" in step ? step.op : undefined

/** Whether an act call only tidies up: every op, a list's too. */
const tidying = (args: Readonly<Record<string, unknown>>) => {
  const { steps } = args
  if (Array.isArray(steps)) {
    return steps.length > 0 && steps.every((s) => TIDYING.has(String(opOf(s))))
  }
  return TIDYING.has(String(args.op))
}

/** Fails, saying where to do it instead, when this call may not drive the browser here. */
export const guard = (args: Readonly<Record<string, unknown>>): void => {
  if (here && !asked(args[PERSON_ASKED]) && !tidying(args)) {
    throw new Error(refusal("drive its browser"))
  }
}

/** Whether the call carries the user's words asking for it: a Cancel on Chrome's debugging bar then holds no longer. */
export const consented = (args: Readonly<Record<string, unknown>>): boolean =>
  asked(args[PERSON_ASKED])
