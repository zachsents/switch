// The rest of the Mac's tools: execs under way (procs.ts), what a process costs
// (profile.ts), what the Mac is (device.ts), and opening a privacy pane for the user.
import { Effect, Schema } from "effect"

import { AppEvents, defineEvent, tool } from "switch-ext-kit"
import * as device from "./device.ts"
import { said, watch } from "./health.ts"
import * as procs from "./procs.ts"
import { profile } from "./profile.ts"

const machine = process.env.SWITCH_MACHINE ?? "mac"

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

export const Device = defineEvent("macos.device", 1, device.facts)

/** Only the prompts looked at again, crash dialogs answered. */
const lookAgain = async (was: device.Facts): Promise<device.Facts> => {
  const seen = await device.prompts()
  return {
    ...was,
    promptsWaiting: seen.waiting.length,
    prompts: seen.waiting.map((p) => ({ owner: p.owner, words: [...p.words] })),
    crashDialogsDismissed: [...new Set([...was.crashDialogsDismissed, ...seen.dismissed])],
  }
}

export const deviceLooked = watch("device", 3 * 60_000, 2)

/** Prompts on screen looked for every half minute; the rest every five, an event when it changes. */
export const watchDevice = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let last = ""
  let full = 0
  let facts: device.Facts | null = null
  for (;;) {
    const now = Date.now()
    const was: device.Facts | null = facts
    const due: boolean = was === null || now - full >= 300_000
    const read = yield* Effect.result(
      task(async (): Promise<device.Facts> =>
        due || was === null ? await device.read(machine) : await lookAgain(was),
      ),
    )
    yield* deviceLooked(read._tag === "Failure" ? said(read.failure) : null)
    if (read._tag === "Success") {
      if (due) {
        full = now
      }
      facts = read.success
      const key = device.steady(read.success)
      if (key !== last) {
        last = key
        yield* events.emit(Device.make(read.success)).pipe(Effect.ignore)
      }
    }
    yield* Effect.sleep("30 seconds")
  }
})

const deviceTool = tool(
  "device",
  {
    description:
      "What this Mac is: model, whether it's a laptop, when it sleeps on its own (per power source), what holds its sleep off now, when it last slept, woke and booted; each app scripted from here and whether it may be (automation, an AppleScript to one that may not times out); and the macOS prompts waiting on its screen, which hold every script needing consent until answered. Crash dialogs are answered here with Ignore.",
    readOnly: true,
  },
  () => task(async () => await device.read(machine)),
)

const cancelTool = tool(
  "cancel",
  {
    description:
      "Stop an exec under way on this Mac by its id, with everything it started (TERM, then KILL after 10 s). Without an id, the execs under way.",
    input: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  },
  (input) => task(async () => await Promise.resolve(procs.cancel(input.id))),
)

const profileTool = tool(
  "profile",
  {
    description:
      "What a process on this Mac costs, phase by phase: each phase's CPU (percent of one core), idle wakeups a second, peak second and memory, with the processes it started counted in, and a per-second series. `process` is a pid, a process's name or an app's; `phases` names spans one after another (default one, rest), `seconds` each (default 10, at most 300).",
    readOnly: true,
    input: Schema.Struct({
      process: Schema.Union([Schema.String, Schema.Finite]),
      phases: Schema.optionalKey(Schema.Array(Schema.String)),
      seconds: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) => task(async () => await profile(input)),
)

const PANES = {
  accessibility: "Privacy_Accessibility",
  screen_recording: "Privacy_ScreenCapture",
  full_disk_access: "Privacy_AllFiles",
  automation: "Privacy_Automation",
  microphone: "Privacy_Microphone",
  camera: "Privacy_Camera",
  input_monitoring: "Privacy_ListenEvent",
  location: "Privacy_LocationServices",
  local_network: "Privacy_LocalNetwork",
} as const

const requestAccess = tool(
  "request_access",
  {
    description:
      "Open System Settings at a privacy permission's page on this Mac, for the user to turn it on for the app this extension runs under (Switch Host): accessibility, screen recording, full disk access, automation, microphone, camera, input monitoring, location or local network. The switch is theirs to flip.",
    input: Schema.Struct({
      permission: Schema.Literals([
        "accessibility",
        "screen_recording",
        "full_disk_access",
        "automation",
        "microphone",
        "camera",
        "input_monitoring",
        "location",
        "local_network",
      ]),
    }),
  },
  (input) =>
    task(async () => {
      const url = `x-apple.systempreferences:com.apple.preference.security?${PANES[input.permission]}`
      if ((await Bun.spawn(["open", url], { stderr: "ignore" }).exited) !== 0) {
        throw new Error(`Couldn't open ${input.permission}'s page`)
      }
      return { opened: input.permission }
    }),
)

export const moreTools = [deviceTool, cancelTool, profileTool, requestAccess]
