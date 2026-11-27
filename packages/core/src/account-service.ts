// The only account write path, shared by agent tools and private admin HTTP. An account added here
// is its provider's login in a home of its own under the state folder (T3 Code's provider
// instances: a home each), signed in and out with the provider's own CLI. Each provider's own login,
// in the home its CLI uses by itself, is never touched. `account.added` and `account.removed` are
// recorded first; the home and the hosts follow them (logins.ts reads them back at start).
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import {
  accountOf,
  AccountAdded,
  AccountRemoved,
  addedDir,
  allLogins,
  canInstallClaude,
  cliCommand,
  cliVersion,
  Hosts,
  installClaude,
  lentHost,
  ownSignedIn,
  ownedHost,
  providerOf,
  reportAccount,
  signedIn,
  signOut,
  startSignIn,
} from "@switch/agent"
import type { Host, Machine, SignIn } from "@switch/agent"
import { Brain, defineRead, EventId } from "@switch/brain"
import { isLoginProvider, LOGIN_PROVIDERS, PROVIDER_LAUNCHES, SUBSCRIPTIONS } from "@switch/models"
import type { LoginProvider } from "@switch/models"
import { Context, Effect, Layer, Semaphore } from "effect"
import type { AccountView } from "./account-schema.ts"
import { CoreConfig } from "./config.ts"
import { addedOf } from "./logins.ts"

interface Pending {
  readonly flowId: string
  readonly signIn: SignIn
  readonly timer: ReturnType<typeof setTimeout>
}
const WAIT_MS = 10 * 60_000
const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,31}$/u.test(id)
const fail = (message: string) => Effect.fail(new Error(message))
const label = (provider: LoginProvider) => PROVIDER_LAUNCHES[provider].label
/** The core's logins, as recorded. */
const loginsRead = defineRead("core/account-service/logins", allLogins)

/** The core's own machine, where accounts added here sign in: there before any login is, as on a
 * new Mac whose CLI Providers installs. */
export class CoreMachine extends Context.Service<CoreMachine, Machine>()("switch/CoreMachine") {}

const make = Effect.gen(function* making() {
  const c = yield* CoreConfig
  const hosts = yield* Hosts
  const here = yield* CoreMachine
  const brain = yield* Brain
  const pending = new Map<string, Pending>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const lock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => {
    let semaphore = locks.get(id)
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(1)
      locks.set(id, semaphore)
    }
    return semaphore.withPermit(effect)
  }
  const canonicalRoot = (provider: LoginProvider) =>
    path.join(realpathSync(c.dir), "logins", provider)
  const ownedFolder = (provider: LoginProvider, id: string) => {
    if (!validId(id)) {
      throw new Error("Invalid account id")
    }
    const root = addedDir(c.dir, provider)
    const folder = path.join(root, id)
    if (
      realpathSync(root) !== canonicalRoot(provider) ||
      lstatSync(folder).isSymbolicLink() ||
      realpathSync(folder) !== path.join(canonicalRoot(provider), id)
    ) {
      throw new Error("Unsafe account directory")
    }
    return realpathSync(folder)
  }
  /** Its provider's, when it was added here: another machine's, one lent or a CLI's own isn't. */
  const addedProvider = (host: Host) => {
    const provider = providerOf(host)
    if (
      host.lent === true ||
      !isLoginProvider(provider) ||
      host.machine.id !== c.machine ||
      host.configDir === undefined
    ) {
      return null
    }
    try {
      return realpathSync(host.configDir) === ownedFolder(provider, host.id) ? provider : null
    } catch {
      return null
    }
  }
  const requireOwned = (id: string) =>
    Effect.try({
      try: () => {
        const host = hosts.get(id)
        const provider = host === undefined ? null : addedProvider(host)
        if (provider === null) {
          throw new Error("Account wasn't added here")
        }
        return { provider, folder: ownedFolder(provider, id) }
      },
      catch: () => new Error("Account wasn't added here"),
    })
  const report = (id: string) =>
    Effect.gen(function* reporting() {
      const state = (yield* hosts.states).find((s) => s.account === hosts.account(id))
      if (state !== undefined) {
        yield* reportAccount(accountOf(state)).pipe(Effect.provideService(Brain, brain))
      }
    })
  const record = (type: string, payload: unknown) =>
    brain.ingest([
      { id: EventId.make(`account:${crypto.randomUUID()}`), type, source: "agent", payload },
    ])
  const drop = (id: string) =>
    Effect.gen(function* dropping() {
      const flow = pending.get(id)
      if (flow === undefined) {
        return
      }
      pending.delete(id)
      clearTimeout(flow.timer)
      yield* flow.signIn.cancel
    })
  const command = (provider: LoginProvider) => cliCommand(c.dir, provider)
  // An account added here that isn't signed in is a host that takes no turns until it is.
  yield* Effect.forEach(
    hosts.all.flatMap((h) => {
      const provider = addedProvider(h)
      return provider === null ? [] : [{ id: h.id, provider, folder: ownedFolder(provider, h.id) }]
    }),
    ({ id, provider, folder }) =>
      Effect.gen(function* checking() {
        const cli = command(provider)
        if (cli === null || !(yield* signedIn(provider, folder, cli))) {
          yield* hosts.limit(id, Number.MAX_SAFE_INTEGER, "Signed out")
          yield* report(id)
        }
      }),
    { concurrency: 4, discard: true },
  )
  // The CLI's own login on this machine takes turns while its CLI says it's signed in: a turn on
  // it otherwise fails as signed out, and the user's message with it. Its status runs as its turns
  // do (the same environment, tokens in it included), and is read again each minute, so signing
  // it in or out at the CLI is felt without a restart. A status it didn't print judges nothing.
  const checkOwn = (provider: LoginProvider) =>
    Effect.gen(function* checkingOwn() {
      const cli = command(provider)
      const own = hosts.get(provider)
      if (
        cli === null ||
        own === undefined ||
        own.machine.id !== c.machine ||
        own.lent === true ||
        own.configDir !== undefined ||
        own.token !== undefined ||
        providerOf(own) !== provider
      ) {
        return
      }
      const signed = yield* ownSignedIn(provider, cli)
      const state = (yield* hosts.states).find((s) => s.account === hosts.account(provider))
      const out = state?.problem === "Signed out"
      if (signed === false && !out) {
        yield* hosts.limit(provider, Number.MAX_SAFE_INTEGER, "Signed out")
        yield* report(provider)
      } else if (signed === true && out) {
        yield* hosts.limit(provider, 0)
        yield* report(provider)
      }
    })
  const checkAllOwn = Effect.forEach(LOGIN_PROVIDERS, checkOwn, { discard: true })
  yield* checkAllOwn
  yield* Effect.forkScoped(
    Effect.forever(Effect.andThen(Effect.sleep("1 minute"), Effect.ignore(checkAllOwn))),
  )
  // Each account added here goes to every machine linked in, lent: its own home there, its login
  // the core's. hosts.add and hosts.remove lend again.
  yield* hosts.lend((machine) =>
    hosts.all.filter((h) => addedProvider(h) !== null).flatMap((h) => lentHost(h, machine) ?? []),
  )
  yield* Effect.addFinalizer(() => Effect.forEach([...pending.keys()], drop, { discard: true }))
  /** A new account's id of its own: its provider's name and a few random letters. */
  const freshId = (provider: LoginProvider) => {
    for (;;) {
      const id = `${provider}-${crypto.randomUUID().slice(0, 6)}`
      if (
        hosts.get(id) === undefined &&
        !LOGIN_PROVIDERS.some((p) => existsSync(path.join(addedDir(c.dir, p), id)))
      ) {
        return id
      }
    }
  }
  const add = (provider: LoginProvider, given?: string) => {
    const id = given ?? freshId(provider)
    return lock(
      id,
      Effect.gen(function* adding() {
        if (!validId(id)) {
          return yield* fail("Invalid account id")
        }
        // A provider's name stays its own login's, as T3 Code keeps its default instances' ids.
        if (
          SUBSCRIPTIONS.some((s) => s === id) ||
          hosts.get(id) !== undefined ||
          (yield* brain.read(loginsRead)).some((l) => l.id === id) ||
          LOGIN_PROVIDERS.some((p) => existsSync(path.join(addedDir(c.dir, p), id)))
        ) {
          return yield* fail("Name taken")
        }
        yield* record(AccountAdded.type, addedOf({ id, provider, owned: true }))
        const root = addedDir(c.dir, provider)
        yield* Effect.try({
          try: () => {
            mkdirSync(root, { recursive: true, mode: 0o700 })
            if (realpathSync(root) !== canonicalRoot(provider)) {
              throw new Error("Unsafe account directory")
            }
            mkdirSync(path.join(root, id), { mode: 0o700 })
          },
          catch: () => new Error("Can't create account directory"),
        }).pipe(Effect.tapError(() => record(AccountRemoved.type, { host: id })))
        yield* hosts.add(
          ownedHost({ id, machine: here, provider, configDir: ownedFolder(provider, id) }),
        )
        yield* hosts.limit(id, Number.MAX_SAFE_INTEGER, "Signed out")
        yield* report(id)
        return { id }
      }),
    )
  }
  // A sign-in that ended by itself (a device sign-in, once its page has the code): signed in, the
  // account takes turns.
  const settle = (id: string, provider: LoginProvider, folder: string) =>
    Effect.gen(function* settling() {
      const flow = pending.get(id)
      if (flow !== undefined) {
        pending.delete(id)
        clearTimeout(flow.timer)
      }
      const cli = command(provider)
      if (cli !== null && (yield* signedIn(provider, folder, cli))) {
        yield* hosts.limit(id, 0)
        yield* report(id)
      }
    })
  const start = (id: string) =>
    lock(
      id,
      Effect.gen(function* starting() {
        const { provider, folder } = yield* requireOwned(id)
        const cli = command(provider)
        if (cli === null) {
          return yield* fail(`${label(provider)} CLI missing`)
        }
        yield* drop(id)
        const signIn = yield* startSignIn(provider, folder, cli).pipe(
          Effect.catchTag("SignInFailed", (error) => fail(error.reason)),
        )
        const flowId = crypto.randomUUID()
        const timer = setTimeout(() => {
          Effect.runFork(
            lock(
              id,
              Effect.suspend(() => (pending.get(id)?.flowId === flowId ? drop(id) : Effect.void)),
            ),
          )
        }, WAIT_MS)
        pending.set(id, { flowId, signIn, timer })
        void signIn.exited.finally(() => {
          Effect.runFork(
            lock(
              id,
              Effect.suspend(() =>
                pending.get(id)?.flowId === flowId ? settle(id, provider, folder) : Effect.void,
              ),
            ),
          )
        })
        return { flowId, url: signIn.url, code: signIn.code }
      }),
    )
  const finish = (id: string, flowId: string, code: string) =>
    lock(
      id,
      Effect.gen(function* finishing() {
        const { provider, folder } = yield* requireOwned(id)
        const flow = pending.get(id)
        if (flow === undefined || flow.flowId !== flowId) {
          return yield* fail("Sign-in expired; retry")
        }
        yield* flow.signIn.finish(code).pipe(
          Effect.ensuring(drop(id)),
          Effect.catchTag("SignInFailed", (error) => fail(error.reason)),
        )
        if (!(yield* signedIn(provider, folder, command(provider) ?? provider))) {
          return yield* fail(`${label(provider)} is still signed out`)
        }
        yield* hosts.limit(id, 0)
        yield* report(id)
        return { id }
      }),
    )
  const cancel = (id: string, flowId: string) =>
    lock(
      id,
      Effect.gen(function* cancelling() {
        yield* requireOwned(id)
        if (pending.get(id)?.flowId !== flowId) {
          return yield* fail("Sign-in expired; retry")
        }
        yield* drop(id)
        return { id }
      }),
    )
  const logout = (id: string) =>
    Effect.gen(function* loggingOut() {
      const { provider, folder } = yield* requireOwned(id)
      const cli = command(provider)
      if (cli === null) {
        return yield* fail(`${label(provider)} CLI missing`)
      }
      yield* drop(id)
      yield* signOut(provider, folder, cli)
      if (yield* signedIn(provider, folder, cli)) {
        return yield* fail(`${label(provider)} is still signed in`)
      }
      yield* hosts.limit(id, Number.MAX_SAFE_INTEGER, "Signed out")
      yield* report(id)
      return { id }
    })
  const signout = (id: string) => lock(id, logout(id))
  // Recorded first: what follows (the hosts, a sign-out, its home) can't bring it back.
  const remove = (id: string) =>
    lock(
      id,
      Effect.gen(function* removing() {
        const login = (yield* brain.read(loginsRead)).find((l) => l.id === id)
        if (login === undefined) {
          return yield* fail("No account")
        }
        yield* drop(id)
        yield* record(AccountRemoved.type, { host: id })
        yield* hosts.remove(id)
        const provider = login.provider ?? "claude"
        if (login.owned === true && isLoginProvider(provider)) {
          const root = addedDir(c.dir, provider)
          if (existsSync(path.join(root, id))) {
            const folder = yield* Effect.try({
              try: () => ownedFolder(provider, id),
              catch: () => new Error("Unsafe account directory"),
            })
            const cli = command(provider)
            if (cli !== null && (yield* signedIn(provider, folder, cli))) {
              yield* signOut(provider, folder, cli).pipe(
                Effect.catchCause((cause) => Effect.logWarning(`${id} not signed out`, cause)),
              )
            }
            yield* Effect.try({
              try: () => {
                rmSync(folder, { recursive: true })
              },
              catch: () => new Error("Can't remove account directory"),
            })
          }
        }
        return { id }
      }),
    )
  const list = Effect.gen(function* listing() {
    const states = yield* hosts.states
    const accounts = states.map((s): AccountView => {
      const flow = pending.get(s.account)
      let status: AccountView["status"] = "connected"
      if (!s.up) {
        status = "limited"
      }
      if (s.problem === "Signed out") {
        status = "signed-out"
      }
      if (flow !== undefined) {
        status = "pending"
      }
      return {
        id: s.account,
        provider: providerOf(s.host),
        machine: s.host.machine.id,
        added: addedProvider(s.host) !== null,
        status,
        problem: s.problem,
        used: s.used,
        flow:
          flow === undefined
            ? null
            : { flowId: flow.flowId, url: flow.signIn.url, code: flow.signIn.code },
      }
    })
    const clis = yield* Effect.promise(
      async () =>
        await Promise.all(
          LOGIN_PROVIDERS.map(async (provider) => {
            const executable = command(provider)
            let version = ""
            if (executable !== null) {
              try {
                version = await cliVersion(executable)
              } catch {
                /* Executable is present but unusable. */
              }
            }
            return {
              provider,
              machine: c.machine,
              command: executable ?? "",
              version,
              installable: provider === "claude" && canInstallClaude(),
            }
          }),
        ),
    )
    return { accounts, clis }
  })
  const install = (provider: string) =>
    lock(
      `cli:${provider}`,
      Effect.gen(function* installing() {
        if (provider !== "claude") {
          return yield* fail("Managed installation unavailable")
        }
        yield* Effect.tryPromise({
          try: async () => {
            await installClaude(c.dir)
          },
          catch: () => new Error("Claude CLI installation failed"),
        })
        yield* checkOwn(provider)
        return { provider }
      }),
    )
  return { add, start, finish, cancel, signout, remove, list, install, checkOwn }
})

export class Accounts extends Context.Service<Accounts, Effect.Success<typeof make>>()(
  "switch/Accounts",
) {
  static readonly layer = Layer.effect(Accounts, make)
}
