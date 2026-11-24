// Calendar's settings: ~/.switch/calendar.json (or $CALENDAR_CONFIG). Every key is optional.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

const file = Schema.Struct({
  /** Where new events go: a calendar's id or name. Default: the first Google account's own. */
  calendar: Schema.optionalKey(Schema.String),
})

export interface Settings {
  readonly dir: string
  readonly db: string
  readonly calendar: string | null
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(file))

export const loadSettings = (): Settings => {
  // Beside the brain it tells: what's been told is per brain.
  const dir =
    process.env.CALENDAR_DIR ??
    path.join(process.env.SWITCH_DIR ?? path.join(homedir(), ".switch"), "calendar")
  const at = process.env.CALENDAR_CONFIG ?? path.join(homedir(), ".switch", "calendar.json")
  const f = existsSync(at) ? decode(readFileSync(at, "utf-8")) : {}
  return {
    dir,
    db: process.env.CALENDAR_DB ?? path.join(dir, "calendar.db"),
    calendar: f.calendar ?? null,
  }
}

export const settingsPath = () =>
  process.env.CALENDAR_CONFIG ?? path.join(homedir(), ".switch", "calendar.json")
