// On the user's own laptop (its config provides `personal`), what keeps an agent turn's own shell
// off heavy work, ported from Switchboard's `sb guard`: a PreToolUse hook (`switch guard`) that
// refuses a shell command running builds, tests, Blender, encoders or simulators, following its
// variables, `sh -c`, `eval` and scripts, saying where to run it instead; and PATH stand-ins, put
// first before each shell command, for what a script runs deeper down. A command led by
// PERSON_ASKED='<the user's words>' runs.
import path from "node:path"
import type { Guard } from "@switch/agent"
import { writeFileAtomic } from "@switch/brain/files"
import { heavy, PERSONAL, refusal, standIns } from "switch-ext-kit"
import { Option, Schema } from "effect"

const compiled = Bun.main.startsWith("/$bunfs/")

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

/** This machine's guard, made under `dir`, when it's the user's laptop. */
export const guardOf = (dir: string, provides: readonly string[]): Guard | undefined => {
  if (!provides.includes(PERSONAL)) {
    return undefined
  }
  const root = path.join(dir, "laptop-guard")
  const bin = standIns(path.join(root, "bin"))
  const envFile = path.join(root, "env.sh")
  writeFileAtomic(envFile, `export PATH=${quote(bin)}:"$PATH"\n`)
  const self = compiled ? [process.execPath] : [process.execPath, Bun.main]
  return { hook: [...self, "guard"].map(quote).join(" "), bin, envFile }
}

/** Its hook in Claude Code's settings, naming the machines to run heavy work on instead. */
export const guardHook = (guard: Guard, elsewhere: readonly string[]) => ({
  matcher: "Bash",
  hooks: [
    {
      type: "command",
      command: elsewhere.length > 0 ? `${guard.hook} ${quote(elsewhere.join(","))}` : guard.hook,
      timeout: 10,
    },
  ],
})

const decodeInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      tool_name: Schema.String,
      tool_input: Schema.Struct({ command: Schema.optionalKey(Schema.String) }),
      cwd: Schema.optionalKey(Schema.String),
    }),
  ),
)

/** `switch guard [machines]`: a PreToolUse hook's answer, on stdout. */
export const guard = async () => {
  const input = decodeInput(await Bun.stdin.text())
  if (Option.isNone(input) || input.value.tool_name !== "Bash") {
    return
  }
  const { command } = input.value.tool_input
  const found =
    command === undefined
      ? null
      : heavy(command, input.value.cwd === undefined ? {} : { cwd: input.value.cwd })
  if (found === null) {
    return
  }
  const elsewhere = (process.argv[3] ?? "").split(",").filter((m) => m !== "")
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: refusal(`run ${found}`, elsewhere),
      },
    }),
  )
}
