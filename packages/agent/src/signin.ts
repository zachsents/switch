// Signing a login in where nobody is at the keyboard, as Switchboard's signin did: the provider's own
// sign-in in a terminal of its own, under the login's own home (CLAUDE_CONFIG_DIR, CODEX_HOME or
// FX_HOME, one per account, as T3 Code's instance homes). It shows a sign-in page. Claude's page
// then gives a code, which goes back to the same process: good once, and only to the process that
// showed the page. Codex and FX sign in by device: the terminal shows a code to type on the page,
// and the process ends by itself once the page has it. Nothing the terminal shows is kept but the
// address and that code: it echoes what's typed.
import { mkdirSync } from "node:fs"
import type { LoginProvider } from "@switch/models"
import { Data, Effect, Schema } from "effect"

import { DROP } from "./claude.ts"
import { DROP as CODEX_DROP } from "./codex.ts"
import { processEnv } from "./hosts.ts"
import { childEnv } from "./provider.ts"

export class SignInFailed extends Data.TaggedError("SignInFailed")<{ readonly reason: string }> {}

/** A provider's CLI, as it keeps each login in a home of its own. */
interface Cli {
  /** The variable naming the home. */
  readonly home: string
  readonly signIn: readonly string[]
  readonly signOut: readonly string[]
  readonly status: readonly string[]
  /** Whether what `status` said, and how it exited, mean signed in. */
  readonly signedIn: (said: string, code: number) => boolean
  /** The sign-in page's address, in what the terminal shows. */
  readonly page: RegExp
  /** A device sign-in's code, shown after the page to type there; none when the page gives one. */
  readonly code: RegExp | null
  /** What the child doesn't get: the parent's agent wiring, and other ways to sign it in. */
  readonly drop: RegExp
  readonly env: Readonly<Record<string, string>>
}

const json = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      loggedIn: Schema.optionalKey(Schema.Boolean),
      auth: Schema.optionalKey(Schema.String),
    }),
  ),
)
const DEVICE_CODE = /(?<![A-Z0-9])[A-Z0-9]{4}-[A-Z0-9]{4,}(?![A-Z0-9])/u

const LOGINS = {
  claude: {
    home: "CLAUDE_CONFIG_DIR",
    signIn: ["auth", "login", "--claudeai"],
    signOut: ["auth", "logout"],
    status: ["auth", "status", "--json"],
    signedIn: (said) => {
      const status = json(said)
      return status._tag === "Some" && status.value.loggedIn === true
    },
    page: /https:\/\/[\w.-]+\/[\w/.-]*oauth\/authorize\?[\w%&=+.~:/?-]+/u,
    code: null,
    drop: DROP,
    env: { DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" },
  },
  // `codex login --device-auth`, as T3 Code's "Run `codex login` with CODEX_HOME set to" its home.
  codex: {
    home: "CODEX_HOME",
    signIn: ["login", "--device-auth"],
    signOut: ["logout"],
    status: ["login", "status"],
    signedIn: (_said, code) => code === 0,
    page: /https:\/\/auth\.openai\.com\/[\w/?=&.%-]+/u,
    code: DEVICE_CODE,
    drop: CODEX_DROP,
    env: {},
  },
  // fx keeps its login in FX_HOME (T3 Code's provider-fx). The Gateway key in this process's
  // environment would sign every home in as one: a home's own login is its own.
  fx: {
    home: "FX_HOME",
    signIn: ["login"],
    signOut: ["logout"],
    status: ["status", "--json"],
    signedIn: (said, code) => {
      const status = json(said)
      return code === 0 && status._tag === "Some" && (status.value.auth ?? "missing") !== "missing"
    },
    page: /https:\/\/vercel\.com\/oauth\/device[\w/?=&.%-]*/u,
    code: DEVICE_CODE,
    drop: /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|CODEX_HOME|FX_HOME|AI_GATEWAY_|VERCEL_OIDC)/u,
    env: { FX_SOUND: "off", FX_AUTO_UPGRADE: "0" },
  },
} as const satisfies Readonly<Record<LoginProvider, Cli>>

const cliOf = (provider: LoginProvider): Cli => LOGINS[provider]

export interface SignIn {
  /** The provider's sign-in page, for the user. */
  readonly url: string
  /** What to type on the page; empty when the page gives a code back instead. */
  readonly code: string
  /** The code the page gave the user: signs the home in. */
  readonly finish: (code: string) => Effect.Effect<void, SignInFailed>
  readonly cancel: Effect.Effect<void>
  /** Resolves when the process is gone, however it ended. */
  readonly exited: Promise<number>
}

// No browser opens where nobody is at the keyboard; the address goes to the user instead.
const env = (cli: Cli, home: string) =>
  childEnv({ env: processEnv() }, cli.drop, {
    BROWSER: "/usr/bin/true",
    ...cli.env,
    [cli.home]: home,
  })

// Waits until `check` holds or `ms` pass, looking every tenth of a second.
const until = (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  const look: Effect.Effect<void> = Effect.suspend(() =>
    check() || Date.now() >= end ? Effect.void : Effect.andThen(Effect.sleep("100 millis"), look),
  )
  return look
}

/** Signs `provider`'s login in `home` in, with its CLI at `command`. */
export const startSignIn = (
  provider: LoginProvider,
  home: string,
  command: string,
): Effect.Effect<SignIn, SignInFailed> =>
  Effect.gen(function* starting() {
    const cli = cliOf(provider)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const decoder = new TextDecoder()
    let shown = ""
    let done = false
    let collecting = true
    const proc = Bun.spawn([command, ...cli.signIn], {
      cwd: home,
      env: env(cli, home),
      terminal: {
        cols: 500,
        rows: 50,
        data: (_terminal, data) => {
          if (collecting) {
            shown = (shown + decoder.decode(data, { stream: true })).slice(-65_536)
          }
        },
      },
    })
    const exited = proc.exited.then((code) => {
      done = true
      proc.terminal?.close()
      return code
    })
    // Each whole once something follows it: the page, then a device sign-in's code.
    const read = () => {
      const words = Bun.stripANSI(shown)
      const page = cli.page.exec(words)
      if (page === null || page.index + page[0].length >= words.length) {
        return null
      }
      if (cli.code === null) {
        return { url: page[0], code: "" }
      }
      const after = words.slice(page.index + page[0].length)
      const code = cli.code.exec(after)
      return code === null || code.index + code[0].length >= after.length
        ? null
        : { url: page[0], code: code[0] }
    }
    const cancel = Effect.gen(function* cancelling() {
      if (!done) {
        proc.kill()
      }
      yield* until(() => done, 1000)
      if (!done) {
        proc.kill("SIGKILL")
      }
      yield* Effect.promise(async () => {
        await exited
      })
    })
    const shownPage = yield* Effect.gen(function* waiting() {
      yield* until(() => read() !== null || done, 60_000)
      const found = read()
      if (found === null) {
        return yield* new SignInFailed({ reason: "No sign-in page" })
      }
      return found
    }).pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? cancel : Effect.void)))
    collecting = false
    shown = ""
    const finish = (code: string) =>
      Effect.gen(function* finishing() {
        if (cli.code !== null) {
          return yield* new SignInFailed({ reason: "No code to give" })
        }
        if (done) {
          return yield* new SignInFailed({ reason: "This sign-in ended" })
        }
        if (!/^[!-~]+$/u.test(code.trim())) {
          return yield* new SignInFailed({ reason: "Invalid sign-in code" })
        }
        // Words and Return together read as a paste, and the Return is lost.
        proc.terminal?.write(code.trim())
        yield* Effect.sleep("500 millis")
        proc.terminal?.write("\r")
        yield* until(() => done, 30_000)
        if (!done) {
          yield* cancel
          return yield* new SignInFailed({ reason: "Code not taken" })
        }
        const status = yield* Effect.promise(async () => await exited)
        if (status !== 0) {
          return yield* new SignInFailed({ reason: "Code not taken" })
        }
        return status
      })
    return { ...shownPage, finish, cancel, exited } satisfies SignIn
  })

// Runs `provider`'s CLI with `args` on the login in `home`: what it said, and how it exited.
const run = (provider: LoginProvider, home: string, command: string, args: readonly string[]) =>
  Effect.promise(async () => {
    const cli = cliOf(provider)
    const proc = Bun.spawn([command, ...args], {
      cwd: home,
      env: env(cli, home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
    }, 15_000)
    const [said, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return { said, code }
  })

/** Whether the login in `home` is signed in, as its CLI says. */
export const signedIn = (provider: LoginProvider, home: string, command: string) =>
  Effect.map(run(provider, home, command, cliOf(provider).status), ({ said, code }) =>
    cliOf(provider).signedIn(said, code),
  )

/** Signs the login in `home` out, so its credentials go with it. */
export const signOut = (provider: LoginProvider, home: string, command: string) =>
  Effect.asVoid(run(provider, home, command, cliOf(provider).signOut))
