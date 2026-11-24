// FX's native one-shot contract supports first_call_tool_choice=none in user settings,
// with a single model step. Keep this per-process; never edit the terminal user's settings.
import path from "node:path"
import { Effect, Schema } from "effect"
import { channel, childEnv, lifecycle } from "./provider.ts"
import type { Runner, Start } from "./provider.ts"

const Status = Schema.Struct({ model: Schema.String, auth: Schema.String })
const Reply = Schema.Struct({
  final_output: Schema.String,
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  recovery: Schema.optionalKey(
    Schema.Struct({
      state: Schema.String,
      need: Schema.optionalKey(Schema.String),
    }),
  ),
  exit_code: Schema.Number,
  tool_calls: Schema.Array(Schema.Unknown),
})
const environment = (s: Start) =>
  childEnv(
    s.host.machine,
    /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|CODEX_HOME|FX_HOME)$/u,
    {
      ...(s.host.configDir === undefined ? {} : { FX_HOME: s.host.configDir }),
      FX_PROVIDER: "gateway",
      FX_SOUND: "off",
      FX_AUTO_UPGRADE: "0",
    },
  )
export const fxCompletion = (s: Start): Effect.Effect<Runner> =>
  Effect.gen(function* starting() {
    const env = environment(s)
    // This path uses exactly the selected host's existing environment credential, not a copied
    // login or a fallback to another account. Other FX credential sources stay unsupported here.
    if (env.AI_GATEWAY_API_KEY === undefined || env.AI_GATEWAY_API_KEY === "") {
      return yield* Effect.die(new Error("FX completion needs its host's Gateway credential"))
    }
    const status = yield* s.host.machine.spawn(["fx", "status", "--json"], { cwd: s.cwd, env })
    status.end()
    const original = yield* Effect.promise(async () => {
      const [text] = await Promise.all([
        new Response(status.stdout).text(),
        new Response(status.stderr).text(),
        status.exited,
      ])
      return Schema.decodeUnknownSync(Schema.fromJsonString(Status))(text)
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => {
          status.kill()
        }),
      ),
    )
    if (original.auth !== "AI_GATEWAY_API_KEY") {
      return yield* Effect.die(new Error("FX completion credential source unavailable"))
    }
    const directory = path.join(s.host.machine.home, ".switch", "completions", crypto.randomUUID())
    yield* s.host.machine.writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({ first_call_tool_choice: "none", max_agent_steps: 1, context: false }),
    )
    const cleanup = Effect.gen(function* cleaning() {
      const removed = yield* s.host.machine.spawn(["/bin/rm", "-rf", "--", directory], {
        cwd: s.cwd,
        env,
      })
      removed.end()
      yield* Effect.promise(async () => {
        await removed.exited
      })
    })
    return yield* Effect.acquireUseRelease(
      s.host.machine
        .spawn(
          [
            "fx",
            "ask",
            "--provider",
            "gateway",
            "--model",
            s.model === "default" ? original.model : s.model,
            "--effort",
            s.effort,
            "--permission-mode",
            "ask",
            "--no-save",
            "--json",
            "--system",
            s.system,
          ],
          { cwd: directory, env: { ...env, FX_HOME: directory, FX_SOUND: "off" } },
        )
        .pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? cleanup : Effect.void))),
      (proc) =>
        Effect.gen(function* owning() {
          const out = channel()
          let uuid = ""
          const reading = Effect.promise(async () => {
            const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
            const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Reply))(text)
            const quota =
              decoded.recovery?.state === "need_user" && decoded.recovery.need === "quota"
            const failed =
              quota || code !== 0 || decoded.exit_code !== 0 || decoded.tool_calls.length !== 0
            out.push(lifecycle(uuid, "completed"))
            const limited =
              quota ||
              (failed &&
                /rate.?limit|quota|usage.?limit|too many requests|429/iu.test(
                  [decoded.error, decoded.output, decoded.final_output].join(" "),
                ))
            if (limited) {
              out.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })
            }
            let resultText = decoded.final_output
            if (failed) {
              resultText = limited ? "Usage limit reached" : "FX completion failed"
            }
            const result = {
              type: "result",
              is_error: failed,
              result: resultText,
            }
            out.push(result)
          }).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                out.push({ type: "result", is_error: true, result: "FX completion failed" })
              }),
            ),
            Effect.ensuring(cleanup),
            Effect.ensuring(
              Effect.sync(() => {
                out.end()
              }),
            ),
          )
          yield* Effect.sync(() => {
            Effect.runFork(reading)
          })
          return {
            proc,
            session: crypto.randomUUID(),
            messages: out.messages,
            send: (text, id) =>
              Effect.sync(() => {
                uuid = id
                out.push(lifecycle(id, "started"))
                proc.write(text)
                proc.end()
              }),
            interrupt: Effect.sync(() => {
              proc.kill()
            }),
            effort: () => Effect.void,
          } satisfies Runner
        }),
      (proc, exit) =>
        exit._tag === "Failure"
          ? Effect.andThen(
              Effect.sync(() => {
                proc.kill("SIGKILL")
              }),
              cleanup,
            )
          : Effect.void,
    )
  })
