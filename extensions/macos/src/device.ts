// What this Mac is, ported from Switchboard's sb-macos (device.rs, prompts.rs): its model, whether
// it's a laptop, when it sleeps on its own by its settings, what holds sleep off now, when it last
// slept, woke and booted; each app it has asked to script and whether it may (Automation); and the
// prompts waiting on its screen. While a prompt waits, macOS holds every script that needs consent
// to drive an app until it's answered, so each times out after two minutes as if the app had
// frozen. "<app> quit unexpectedly" dialogs ask nobody anything: they're answered with Ignore here
// and the apps recorded.
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import { hands } from "./hands.ts"

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

const sleepPolicy = Schema.Struct({
  /** Minutes idle before the display sleeps; 0 for never. */
  displaySleepMin: Schema.Finite,
  /** Minutes idle before the system sleeps; 0 for never. */
  idleSleepMin: Schema.Finite,
})

export const facts = Schema.Struct({
  machine: Schema.String,
  model: Schema.String,
  name: Schema.String,
  laptop: Schema.Boolean,
  /** By power source ("AC Power", "Battery Power"). */
  sleep: Schema.Record(Schema.String, sleepPolicy),
  /** Closing the lid puts it to sleep. */
  lidSleeps: Schema.Boolean,
  /** The processes holding its sleep off now, by name. */
  keptAwakeBy: Schema.Array(Schema.String),
  lastSleep: Schema.optionalKey(Schema.String),
  lastWake: Schema.optionalKey(Schema.String),
  bootedAt: Schema.optionalKey(Schema.String),
  /** Each app this Mac's extensions asked to script, and whether they may; absent without Full Disk Access. */
  automation: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  /** macOS prompts on screen nobody has answered. */
  promptsWaiting: Schema.Finite,
  prompts: Schema.Array(
    Schema.Struct({ owner: Schema.String, words: Schema.Array(Schema.String) }),
  ),
  /** Apps whose "quit unexpectedly" dialogs were answered here lately. */
  crashDialogsDismissed: Schema.Array(Schema.String),
})
export type Facts = typeof facts.Type

/** `{ sec = 1700000000, usec = 0 }` as an ISO time. */
const timeval = (text: string) => {
  const sec = /sec = (?<s>\d+)/u.exec(text)?.groups?.s
  return sec === undefined || sec === "0" ? undefined : new Date(Number(sec) * 1000).toISOString()
}

/** `pmset -g custom`: each power source's display and system sleep. */
const sleepOf = (text: string) => {
  const out: Record<string, { displaySleepMin: number; idleSleepMin: number }> = {}
  let source = ""
  for (const line of text.split("\n")) {
    const head = /^(?<name>[A-Za-z ]+Power):/u.exec(line)?.groups?.name
    if (head !== undefined) {
      source = head
      out[source] = { displaySleepMin: 0, idleSleepMin: 0 }
      continue
    }
    const kv = /^\s+(?<k>\w+)\s+(?<v>\d+)/u.exec(line)?.groups
    const at = out[source]
    if (kv !== undefined && at !== undefined) {
      if (kv.k === "displaysleep") {
        at.displaySleepMin = Number(kv.v)
      } else if (kv.k === "sleep") {
        at.idleSleepMin = Number(kv.v)
      }
    }
  }
  return out
}

const HOLDS =
  /PreventUserIdleSystemSleep|PreventSystemSleep|PreventUserIdleDisplaySleep|NoIdleSleepAssertion|NoDisplaySleepAssertion/u

/** `pmset -g assertions`: the processes holding sleep off, by name. */
const holders = (text: string) => {
  const names = new Set<string>()
  for (const line of text.split("\n")) {
    const g = /pid \d+\((?<name>[^)]+)\): \[[^\]]*\] [\d:]+ (?<kind>\w+)/u.exec(line)?.groups
    if (g !== undefined && HOLDS.test(g.kind ?? "")) {
      names.add(g.name ?? "")
    }
  }
  return [...names].filter((n) => n !== "").toSorted()
}

const TCC = path.join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db")

/** Each app scripted from here (Apple Events), by bundle id, and whether it may be. */
const automation = () => {
  if (!existsSync(TCC)) {
    return null
  }
  try {
    const db = new Database(TCC, { readonly: true })
    const rows = db
      .query<{ target: string; allowed: number }, []>(
        "SELECT indirect_object_identifier AS target, max(auth_value) AS allowed FROM access WHERE service = 'kTCCServiceAppleEvents' GROUP BY indirect_object_identifier",
      )
      .all()
    db.close()
    return Object.fromEntries(rows.map((r) => [r.target, r.allowed === 2]))
  } catch {
    return null
  }
}

interface Prompts {
  readonly waiting: readonly { readonly owner: string; readonly words: readonly string[] }[]
  readonly dismissed: readonly string[]
}

const isPrompts = (v: unknown): v is Prompts =>
  typeof v === "object" && v !== null && "waiting" in v && "dismissed" in v

/** The prompts on screen, crash dialogs answered first. */
export const prompts = async (): Promise<Prompts> => {
  const found = await hands("prompts", { dismiss: true }).catch((): null => null)
  return isPrompts(found) ? found : { waiting: [], dismissed: [] }
}

const crashes: string[] = []

export const read = async (machine: string): Promise<Facts> => {
  const [model, name, batt, custom, assertions, sleep, wake, boot, seen] = await Promise.all([
    run(["sysctl", "-n", "hw.model"]),
    run(["scutil", "--get", "ComputerName"]),
    run(["pmset", "-g", "batt"]),
    run(["pmset", "-g", "custom"]),
    run(["pmset", "-g", "assertions"]),
    run(["sysctl", "-n", "kern.sleeptime"]),
    run(["sysctl", "-n", "kern.waketime"]),
    run(["sysctl", "-n", "kern.boottime"]),
    prompts(),
  ])
  crashes.push(...seen.dismissed)
  crashes.splice(0, Math.max(0, crashes.length - 20))
  const laptop = batt.includes("InternalBattery")
  const slept = timeval(sleep)
  const woke = timeval(wake)
  const booted = timeval(boot)
  const scripted = automation()
  return {
    machine,
    model: model.trim(),
    name: name.trim(),
    laptop,
    sleep: sleepOf(custom),
    lidSleeps: laptop && !/SleepDisabled\s+1/u.test(custom),
    keptAwakeBy: holders(assertions),
    ...(slept !== undefined && { lastSleep: slept }),
    ...(woke !== undefined && { lastWake: woke }),
    ...(booted !== undefined && { bootedAt: booted }),
    ...(scripted !== null && { automation: scripted }),
    promptsWaiting: seen.waiting.length,
    prompts: seen.waiting.map((p) => ({ owner: p.owner, words: [...p.words] })),
    crashDialogsDismissed: [...new Set(crashes)],
  }
}

/** What changes often enough not to be news: the holders of sleep come and go with every turn. */
export const steady = (f: Facts) => JSON.stringify({ ...f, keptAwakeBy: [] })
