// The only account write path, shared by agent tools and private admin HTTP. An account is its
// identity: the email its login reports. Adding one is signing in: the provider's own sign-in runs
// in a fresh home under the state folder (T3 Code's provider instances: a home each), and once
// signed in the core reads who it is. A new email is a new account, that home its own; an email an
// account added here already has is that account, its credential replaced in place and the fresh
// home gone. Each provider's own login, in the home its CLI uses by itself, is never touched.
// `account.added` and `account.removed` are recorded first; the home and the hosts follow them
// (logins.ts reads them back at start).
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import {
  accountOf,
  AccountAdded,
  AccountRemoved,
  addedDir,
  allLogins,
  canInstallClaude,
  claudeCredential,
  cliCommand,
  cliVersion,
  forgetLogin,
  hasLogin,
  Hosts,
  installClaude,
  lentHost,
  loginEmail,
  moveLogin,
  ownSignedIn,
  ownedHost,
  providerOf,
  reportAccount,
  signedIn,
  signOut,
  startSignIn,
  statusEmail,
} from "@switch/agent"
import type { Host, Login, Machine, SignIn } from "@switch/agent"
import { Brain, defineRead, EventId } from "@switch/brain"
import { isLoginProvider, LOGIN_PROVIDERS, PROVIDER_LAUNCHES } from "@switch/models"
import type { LoginProvider } from "@switch/models"
import { Context, Effect, Layer, Semaphore } from "effect"
import type { AccountView } from "./account-schema.ts"
import { CoreConfig } from "./config.ts"
import { addedOf } from "./logins.ts"

/** A sign-in under way, in a fresh home that's no account yet. */
interface Flow {
  readonly flowId: string
  readonly provider: LoginProvider
  /** The id its account gets when its email is new. */
  readonly id: string
  readonly folder: string
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

/** A home of one added here, and its login with it: gone without signing out. */
const erase = (provider: LoginProvider, folder: string) =>
  Effect.gen(function* erasing() {
    yield* forgetLogin(provider, folder)
    yield* Effect.try({
      try: () => {
        rmSync(folder, { recursive: true, force: true })
      },
      catch: () => new Error("Can't remove account directory"),
    })
  })

const make = Effect.gen(function* making() {
  const c = yield* CoreConfig
  const hosts = yield* Hosts
  const here = yield* CoreMachine
  const brain = yield* Brain
  const flows = new Map<string, Flow>()
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
  const command = (provider: LoginProvider) => cliCommand(c.dir, provider)
  /** The accounts added here, each with its home and who it is. */
  const ownedLogins = Effect.gen(function* owned() {
    const recorded = yield* brain.read(loginsRead)
    return hosts.all.flatMap((h) => {
      const provider = addedProvider(h)
      if (provider === null) {
        return []
      }
      const folder = ownedFolder(provider, h.id)
      const login = recorded.find((l) => l.id === h.id)
      const email = (login?.email ?? "") || loginEmail(provider, folder)
      return [{ id: h.id, provider, folder, email, login }]
    })
  })
  /** Who an account is, recorded with it once its login says. */
  const remember = (login: Login | undefined, id: string, provider: LoginProvider, email: string) =>
    email === "" || login?.email === email
      ? Effect.void
      : record(AccountAdded.type, addedOf({ ...login, id, provider, owned: true, email }))
  const forget = (id: string, provider: LoginProvider, folder: string) =>
    Effect.gen(function* forgetting() {
      yield* record(AccountRemoved.type, { host: id })
      yield* hosts.remove(id)
      yield* erase(provider, folder)
    })
  // Once at each start, the accounts added here keyed by who they are: one never signed in (a home
  // with no login and no email) is no account and goes; one an earlier account of the same email
  // already is goes into it; each has its email recorded. One signed out takes no turns until an
  // Add account signs its email in again.
  const checked = yield* Effect.forEach(
    yield* ownedLogins,
    (a) =>
      Effect.gen(function* checking() {
        // A Claude login is the core's to refresh and lend: its credentials say it's signed in,
        // with no CLI here (a core that takes no turns needs none).
        const cli = command(a.provider)
        const on =
          (a.provider === "claude" && (yield* claudeCredential(a.folder)) !== null) ||
          (cli !== null && (yield* signedIn(a.provider, a.folder, cli)))
        const held = on || (yield* hasLogin(a.provider, a.folder))
        return { ...a, on, held }
      }),
    { concurrency: 4 },
  )
  const kept = new Map<string, (typeof checked)[number]>()
  for (const a of checked.toSorted(
    (x, y) => Number(y.on) - Number(x.on) || x.id.localeCompare(y.id),
  )) {
    const key = `${a.provider}\n${a.email}`
    if (!a.held && a.email === "") {
      yield* forget(a.id, a.provider, a.folder).pipe(Effect.ignore({ log: "Warn" }))
      continue
    }
    if (a.email !== "" && kept.has(key)) {
      yield* forget(a.id, a.provider, a.folder).pipe(Effect.ignore({ log: "Warn" }))
      continue
    }
    kept.set(a.email === "" ? `${key}${a.id}` : key, a)
    yield* remember(a.login, a.id, a.provider, a.email).pipe(Effect.orDie)
    if (!a.on) {
      yield* hosts.limit(a.id, Number.MAX_SAFE_INTEGER, "Signed out")
      yield* report(a.id)
    }
  }
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
  /** A sign-in ended without an account: its process stopped, its fresh home gone. */
  const discard = (flowId: string) =>
    Effect.gen(function* discarding() {
      const flow = flows.get(flowId)
      if (flow === undefined) {
        return
      }
      flows.delete(flowId)
      clearTimeout(flow.timer)
      yield* flow.signIn.cancel
      yield* erase(flow.provider, flow.folder).pipe(Effect.ignore({ log: "Warn" }))
    })
  yield* Effect.addFinalizer(() => Effect.forEach([...flows.keys()], discard, { discard: true }))
  /** A new account's id of its own: its provider's name and a few random letters. */
  const freshId = (provider: LoginProvider) => {
    for (;;) {
      const id = `${provider}-${crypto.randomUUID().slice(0, 6)}`
      if (
        hosts.get(id) === undefined &&
        ![...flows.values()].some((f) => f.id === id) &&
        !LOGIN_PROVIDERS.some((p) => existsSync(path.join(addedDir(c.dir, p), id)))
      ) {
        return id
      }
    }
  }
  // Signed in: the email says which account it is. A new one is an account, this home its own; a
  // known one's credential is this login's, in its own home, and this home goes.
  const adopt = (flow: Flow) =>
    Effect.gen(function* adopting() {
      const { provider, folder } = flow
      const cli = command(provider)
      if (cli === null || !(yield* signedIn(provider, folder, cli))) {
        return yield* fail(`${label(provider)} is still signed out`)
      }
      const email = loginEmail(provider, folder) || (yield* statusEmail(provider, folder, cli))
      const same =
        email === ""
          ? undefined
          : (yield* ownedLogins).find((a) => a.provider === provider && a.email === email)
      if (same !== undefined) {
        if (!(yield* moveLogin(provider, folder, same.folder))) {
          return yield* fail("Sign-in not saved")
        }
        yield* erase(provider, folder)
        yield* remember(same.login, same.id, provider, email)
        yield* hosts.limit(same.id, 0)
        yield* report(same.id)
        return { id: same.id, email }
      }
      const { id } = flow
      yield* record(
        AccountAdded.type,
        addedOf({ id, provider, owned: true, ...(email !== "" && { email }) }),
      )
      yield* hosts.add(
        ownedHost({ id, machine: here, provider, configDir: ownedFolder(provider, id) }),
      )
      yield* hosts.limit(id, 0)
      yield* report(id)
      return { id, email }
    })
  /** An account added: its provider's sign-in, started in a fresh home. */
  const begin = (provider: LoginProvider) =>
    Effect.gen(function* beginning() {
      const cli = command(provider)
      if (cli === null) {
        return yield* fail(`${label(provider)} CLI missing`)
      }
      // One sign-in a provider at a time: a new one is the one that counts.
      yield* Effect.forEach(
        [...flows.values()].filter((f) => f.provider === provider),
        (f) => lock(f.flowId, discard(f.flowId)),
        { discard: true },
      )
      const id = freshId(provider)
      const root = addedDir(c.dir, provider)
      const folder = yield* Effect.try({
        try: () => {
          mkdirSync(root, { recursive: true, mode: 0o700 })
          if (realpathSync(root) !== canonicalRoot(provider)) {
            throw new Error("Unsafe account directory")
          }
          mkdirSync(path.join(root, id), { mode: 0o700 })
          return ownedFolder(provider, id)
        },
        catch: () => new Error("Can't create account directory"),
      })
      const signIn = yield* startSignIn(provider, folder, cli).pipe(
        Effect.catchTag("SignInFailed", (error) => fail(error.reason)),
        Effect.tapError(() => erase(provider, folder).pipe(Effect.ignore)),
      )
      const flowId = crypto.randomUUID()
      const timer = setTimeout(() => {
        Effect.runFork(lock(flowId, discard(flowId)))
      }, WAIT_MS)
      const flow: Flow = { flowId, provider, id, folder, signIn, timer }
      flows.set(flowId, flow)
      // A device sign-in ends by itself once its page has the code.
      void signIn.exited.finally(() => {
        Effect.runFork(
          lock(
            flowId,
            Effect.suspend(() => {
              if (flows.get(flowId) !== flow) {
                return Effect.void
              }
              flows.delete(flowId)
              clearTimeout(timer)
              return adopt(flow).pipe(
                Effect.catchCause((cause) =>
                  Effect.andThen(
                    Effect.logWarning(`${label(provider)} sign-in not added`, cause),
                    erase(provider, folder).pipe(Effect.ignore),
                  ),
                ),
              )
            }),
          ),
        )
      })
      return { flowId, url: signIn.url, code: signIn.code }
    })
  /** A sign-in's code, from the page that gave it: its account, new or the one of its email. */
  const finish = (flowId: string, code: string) =>
    lock(
      flowId,
      Effect.gen(function* finishing() {
        const flow = flows.get(flowId)
        if (flow === undefined) {
          return yield* fail("Sign-in expired; retry")
        }
        flows.delete(flowId)
        clearTimeout(flow.timer)
        return yield* flow.signIn.finish(code).pipe(
          Effect.catchTag("SignInFailed", (error) => fail(error.reason)),
          Effect.andThen(adopt(flow)),
          Effect.tapError(() =>
            Effect.andThen(
              flow.signIn.cancel,
              erase(flow.provider, flow.folder).pipe(Effect.ignore),
            ),
          ),
        )
      }),
    )
  const cancel = (flowId: string) =>
    lock(
      flowId,
      Effect.gen(function* cancelling() {
        if (!flows.has(flowId)) {
          return yield* fail("Sign-in expired; retry")
        }
        yield* discard(flowId)
        return { flowId }
      }),
    )
  // Recorded first: what follows (the hosts, a sign-out, its home) can't bring it back.
  const remove = (id: string) =>
    lock(
      id,
      Effect.gen(function* removing() {
        const login = (yield* brain.read(loginsRead)).find((l) => l.id === id)
        if (login === undefined) {
          return yield* fail("No account")
        }
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
            yield* erase(provider, folder)
          }
        }
        return { id }
      }),
    )
  const list = Effect.gen(function* listing() {
    const states = yield* hosts.states
    const emails = new Map((yield* ownedLogins).map((a) => [a.id, a.email]))
    const accounts = states.map((s): AccountView => {
      let status: AccountView["status"] = "connected"
      if (!s.up) {
        status = "limited"
      }
      if (s.problem === "Signed out") {
        status = "signed-out"
      }
      return {
        id: s.account,
        provider: providerOf(s.host),
        machine: s.host.machine.id,
        added: addedProvider(s.host) !== null,
        email: emails.get(s.account) ?? "",
        status,
        problem: s.problem,
        used: s.used,
      }
    })
    const signIns = [...flows.values()].map((f) => ({
      provider: f.provider,
      flowId: f.flowId,
      url: f.signIn.url,
      code: f.signIn.code,
    }))
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
    return { accounts, clis, signIns }
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
  return { begin, finish, cancel, remove, list, install, checkOwn }
})

export class Accounts extends Context.Service<Accounts, Effect.Success<typeof make>>()(
  "switch/Accounts",
) {
  static readonly layer = Layer.effect(Accounts, make)
}
