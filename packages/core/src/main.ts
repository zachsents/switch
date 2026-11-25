// `bun run core`, or the compiled `switch`: the daemon. `switch host` is a machine's extension host alone,
// reporting to the core its config names, and running the agent turns the core places there.
// `switch prepare` readies the brain for this build. `switch sb` is what old appendages call `sb`.
// `switch event <name> [json]` is a script's event (scripts.ts). `switch light <model> <copy>` makes a
// model's light copy for the core (light-mesh.ts), off its thread. `switch measure <brain>` prints
// reflection's measures (measure.ts), off it too. `switch checkpoint <brain>` checkpoints the
// brain's WAL as the core commits (checkpointer.ts), off its thread as well.
// `switch guard` is the hook that keeps a turn's shell off heavy work on the user's own laptop: it
// runs before each shell command, so it loads only what it needs. `switch pairings`, `approve`,
// `deny`, `revoke` and `rotate` manage credentials.
import path from "node:path"

// Filesystem-loaded SDK workers travel with the release and every installed host bundle.
if (process.env.SWITCH_PROVIDER_RUNTIME === undefined) {
  const beside = path.join(path.dirname(process.execPath), "provider-runtime")
  const resources = path.join(path.dirname(process.execPath), "..", "Resources", "provider-runtime")
  const directories = await Promise.all(
    [beside, resources].map(async (directory) =>
      (await Bun.file(path.join(directory, "cursor-worker.mjs")).exists()) ? directory : null,
    ),
  )
  const directory = directories.find((value) => value !== null)
  if (directory !== undefined) {
    process.env.SWITCH_PROVIDER_RUNTIME = directory
  }
}

const command = process.argv.at(2)

if (command === "sb") {
  const { sb } = await import("./sb.ts")
  await sb(process.argv.slice(3))
} else if (command === "event") {
  const { event } = await import("./event.ts")
  await event(process.argv.slice(3))
} else if (command === "light") {
  const { light } = await import("./light-mesh.ts")
  await light(process.argv.slice(3))
} else if (command === "checkpoint") {
  const { checkpointing } = await import("@switch/brain")
  const brain = process.argv.at(3)
  if (brain === undefined) {
    process.stderr.write("switch checkpoint <brain>\n")
    process.exit(2)
  }
  await checkpointing(brain, Bun.stdin.stream())
} else if (command === "measure") {
  const { measure } = await import("./measure.ts")
  measure(process.argv.slice(3))
} else if (command === "guard") {
  const { guard } = await import("./guard.ts")
  await guard()
} else {
  const { run } = await import("./daemon.ts")
  run(command)
}
