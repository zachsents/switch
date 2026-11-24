// On the user's own laptop (its host provides `personal`), this extension doesn't drive its apps,
// open things in front of the user or run heavy commands for the agent, unless the call carries
// `person_asked`: the user's words asking for exactly that on this Mac. Ported from Switchboard's
// macOS appendage (personal.rs).
import path from "node:path"
import { Schema } from "effect"

import { asked, heavy, PERSON_ASKED, personal, refusal, standIns } from "switch-ext-kit"

export const here = personal()

export const askedField = {
  [PERSON_ASKED]: Schema.optionalKey(Schema.String),
}

/** A guarded tool's description, with what it refuses on the laptop. */
export const marked = (description: string, what = "it"): string =>
  here
    ? `${description} This Mac is the user's own laptop: ${what} refused unless they asked for exactly that here (${PERSON_ASKED}: their words, and when).`
    : description

/** Fails, saying where to do it instead, when `what` may not run here. */
export const guard = (what: string, input: Readonly<Record<string, unknown>>): void => {
  if (here && !asked(input[PERSON_ASKED])) {
    throw new Error(refusal(what))
  }
}

/**
 * Fails when an exec's command is heavy here; else the command to run, with the stand-ins first on
 * its PATH after the login profile has set it, so a script's builds and encodes refuse too.
 */
export const guardExec = (
  command: string,
  cwd: string,
  input: Readonly<Record<string, unknown>>,
): string => {
  if (!here || asked(input[PERSON_ASKED])) {
    return command
  }
  const found = heavy(command, { cwd })
  if (found !== null) {
    throw new Error(refusal(`run ${found}`))
  }
  const dir = standIns(path.join(process.cwd(), "laptop-guard"))
  return `export PATH='${dir.replaceAll("'", "'\\''")}':"$PATH"\n${command}`
}
