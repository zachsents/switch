// Every host runs the core's release, wherever the landing that made it came from: forward after a
// ship, back after a rollback. As Rust Switchboard's appendages each took every release themselves,
// "so it reaches every Mac the person uses, not only the one that deployed"
// (crates/macos/src/update.rs). The core says its release first on each host's link (`release`,
// with the builds it carries); a host on another one takes the core's before its hello, so it
// offers nothing to the new core and no turn the swap paused is cut again by its update. It fetches
// its target's build from `/hosts/build` with its own credential and checks it: on a Mac,
// Apple-anchored and signed with the identifier and team of the bundle running; elsewhere, by the
// SHA-256 the core stated. It swaps it in on disk and exits, and launchd (KeepAlive) or systemd
// (Restart=always) starts the new one. A build without a release (dev) says none and takes none; a
// bundle signed without a team can't tell a release is its own, so it takes none either.
//
// A release on its way is fetched ahead, as the deploy once fetched a workstation's bundle as soon
// as it was built: once its canary passes, the live core tells its hosts (`next`), and each fetches
// and checks its build then. When the deploy pauses the turns to swap the core, it says so (`next`,
// `now`), and a host holding that release swaps it in and exits in the same pause, so it's back as
// soon as the new core listens.
//
// A release's builds are scripts/ship.sh's, each packed once as it's built: the signed host bundle
// for the core's own target, zipped (`host-<target>.zip`), and a `host-<target>.tar.gz` (beside it,
// its SHA-256) for each other target a host said it runs in its hello, kept in `<dir>/host-targets`.
import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs"
import { mkdir, readdir, rename, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { CoreConfig } from "./config.ts"
import type { ToHost } from "./link.ts"

declare const SWITCH_RELEASE: string | undefined
/** This build's commit, set by scripts/build-core.ts; null in dev. */
export const RELEASE: string | null = typeof SWITCH_RELEASE === "string" ? SWITCH_RELEASE : null
/** What this build runs on, as Bun's targets name it after `bun-`: "darwin-arm64", "linux-x64". */
export const TARGET = `${process.platform}-${process.arch}`

const TARGET_NAME = /^[a-z0-9]+-[a-z0-9]+$/u

type Release = Extract<ToHost, { t: "release" }>
type Next = Extract<ToHost, { t: "next" }>

/** A release's name: the commit it was built from. */
export const RELEASE_NAME = /^[0-9a-f]{40}$/u

/** The builds in a release's folder, by target. */
export const buildsOf = (dir: string, release: string) => {
  const folder = path.join(dir, "releases", release)
  const builds: Record<string, string | null> = {}
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      const zipped = /^host-(?<target>darwin-.+)\.zip$/u.exec(name)?.groups?.target
      const target = /^host-(?<target>.+)\.tar\.gz\.sha256$/u.exec(name)?.groups?.target
      if (zipped !== undefined && TARGET_NAME.test(zipped)) {
        builds[zipped] = null
      } else if (target !== undefined && TARGET_NAME.test(target)) {
        builds[target] = readFileSync(path.join(folder, name), "utf-8").trim()
      }
    }
  }
  return builds
}

/** The core's release and its builds. */
export const releaseOf = (dir: string): Release => ({
  t: "release",
  release: RELEASE,
  builds: RELEASE === null ? {} : buildsOf(dir, RELEASE),
})

/** A target a host said it runs, kept for the next ship to build. */
export const noteTarget = (dir: string, target: string) => {
  const file = path.join(dir, "host-targets")
  const known = existsSync(file) ? readFileSync(file, "utf-8").split("\n") : []
  if (TARGET_NAME.test(target) && !known.includes(target)) {
    appendFileSync(file, `${target}\n`)
  }
}

/**
 * GET /hosts/build?target=linux-x64[&release=<sha>]: a release's build for a target (the core's own
 * unless named), to a host's credential.
 */
export const buildRoute = HttpRouter.add("GET", "/hosts/build", (request) =>
  Effect.gen(function* serving() {
    const c = yield* CoreConfig
    const params = new URL(request.url, "http://core").searchParams
    const target = params.get("target") ?? ""
    const release = params.get("release") ?? RELEASE ?? ""
    if (!RELEASE_NAME.test(release) || !TARGET_NAME.test(target)) {
      return HttpServerResponse.text("No such build", { status: 404 })
    }
    const archive = path.join(
      c.dir,
      "releases",
      release,
      target.startsWith("darwin-") ? `host-${target}.zip` : `host-${target}.tar.gz`,
    )
    return existsSync(archive)
      ? HttpServerResponse.fromWeb(new Response(Bun.file(archive)))
      : HttpServerResponse.text("No such build", { status: 404 })
  }),
)

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

/** The running bundle's identifier and team, from its own signature: null when it has no team. */
const signer = async (bundle: string) => {
  const said = await run(["codesign", "-dv", bundle])
  const shown = said.err.split("\n")
  const field = (key: string) =>
    shown
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim()
  const identifier = field("Identifier")
  const team = field("TeamIdentifier")
  return identifier === undefined || team === undefined || !/^[A-Z0-9]+$/u.test(team)
    ? null
    : { identifier, team }
}

/** A release's build fetched whole into `file`, and its SHA-256. */
const fetchBuild = async (url: string, release: string, file: string) => {
  const build = new URL(url)
  const token = build.searchParams.get("token") ?? ""
  build.protocol = build.protocol === "wss:" ? "https:" : "http:"
  build.pathname = "/hosts/build"
  build.search = ""
  build.searchParams.set("target", TARGET)
  build.searchParams.set("release", release)
  const response = await fetch(build, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok || response.body === null) {
    throw new Error(`The core gave no build (${response.status})`)
  }
  const bytes: ReadableStream<Uint8Array> = response.body
  const writer = Bun.file(file).writer()
  const hash = new Bun.CryptoHasher("sha256")
  for await (const chunk of bytes) {
    hash.update(chunk)
    void writer.write(chunk)
  }
  await writer.end()
  return hash.digest("hex")
}

/** On a Mac, the running bundle; each release is staged in its own folder of `<bundle>.new`. */
const bundle = path.resolve(process.execPath, "..", "..", "..")
const freshOf = (release: string) => path.join(`${bundle}.new`, release, path.basename(bundle))

/** On a Mac: the release's bundle fetched and checked as this one's, beside the running one. */
const stageBundle = async (url: string, release: string) => {
  if (!bundle.endsWith(".app")) {
    throw new Error(`${process.execPath} isn't in a bundle`)
  }
  const signed = await signer(bundle)
  if (signed === null) {
    throw new Error(`${bundle} isn't signed by a team, so it can't tell a release is its own`)
  }
  const work = path.join(`${bundle}.new`, release)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const zip = path.join(work, "bundle.zip")
  await fetchBuild(url, release, zip)
  const unpacked = await run(["ditto", "-x", "-k", zip, work])
  await rm(zip, { force: true })
  if (unpacked.code !== 0) {
    throw new Error(`The bundle didn't unpack: ${unpacked.err.trim()}`)
  }
  const requirement = `anchor apple generic and identifier "${signed.identifier}" and certificate leaf[subject.OU] = "${signed.team}"`
  const verified = await run([
    "codesign",
    "--verify",
    "--deep",
    "--strict",
    `-R=${requirement}`,
    freshOf(release),
  ])
  if (verified.code !== 0) {
    throw new Error(`Its signature doesn't check out: ${verified.err.trim()}`)
  }
}

/** On a Mac: a staged bundle in place of the running one. */
const swapBundle = async (release: string) => {
  const old = `${bundle}.old`
  await rm(old, { recursive: true, force: true })
  await rename(bundle, old)
  try {
    await rename(freshOf(release), bundle)
  } catch (error) {
    await rename(old, bundle)
    throw error
  }
  await rm(old, { recursive: true, force: true })
  await rm(`${bundle}.new`, { recursive: true, force: true })
}

/**
 * Elsewhere: the release's binary and provider runtime, as scripts/install-host.sh lays them out
 * (`switch`, and `provider-runtime` naming `provider-runtimes/<release>/provider-runtime`).
 */
const bin = path.dirname(process.execPath)
const runtimes = path.join(bin, "provider-runtimes")

/** Elsewhere: the release's build fetched, checked by its SHA-256 and unpacked beside this one. */
const stageArchive = async (url: string, release: string, want: string) => {
  const into = path.join(runtimes, release)
  const archive = path.join(runtimes, `.${release}.tar.gz`)
  await mkdir(runtimes, { recursive: true })
  const got = await fetchBuild(url, release, archive)
  if (got !== want) {
    await rm(archive, { force: true })
    throw new Error(`Its SHA-256 is ${got}, not the ${want} the core said`)
  }
  await rm(into, { recursive: true, force: true })
  await mkdir(into, { recursive: true })
  const unpacked = await run(["tar", "-xzf", archive, "-C", into])
  await rm(archive, { force: true })
  if (unpacked.code !== 0) {
    throw new Error(`The build didn't unpack: ${unpacked.err.trim()}`)
  }
}

/** Elsewhere: a staged build in place of the running one; the runtimes of other releases go. */
const swapArchive = async (release: string) => {
  const link = path.join(bin, "provider-runtime.new")
  await rm(link, { force: true })
  await symlink(path.join("provider-runtimes", release, "provider-runtime"), link)
  await rename(link, path.join(bin, "provider-runtime"))
  // Renamed over the running binary, which keeps its own until it exits.
  await rename(path.join(runtimes, release, "switch"), path.join(bin, "switch"))
  const all = await readdir(runtimes)
  await Promise.all(
    all
      .filter((other) => other !== release)
      .map(async (other) => {
        await rm(path.join(runtimes, other), { recursive: true, force: true })
      }),
  )
}

/** The release being staged, or staged: one asked for again waits on the same. */
let staged: { readonly release: string; readonly ready: Promise<void> } | null = null
/** A release that failed to come in, not tried again until the host restarts. */
let failed: string | null = null

/**
 * A release's build for this host, if it should take it: its SHA-256, or null for a signed bundle.
 * A Mac takes the signed bundle; elsewhere, an archive by its SHA-256.
 */
const wanted = (release: string | null, builds: Readonly<Record<string, string | null>>) => {
  const want = builds[TARGET]
  return RELEASE === null ||
    release === null ||
    release === RELEASE ||
    release === failed ||
    want === undefined ||
    (want === null) !== (process.platform === "darwin")
    ? null
    : { want }
}

const stage = async (url: string, release: string, want: string | null) => {
  if (staged?.release !== release) {
    staged = {
      release,
      ready: want === null ? stageBundle(url, release) : stageArchive(url, release, want),
    }
  }
  await staged.ready
}

/** A release staged, or staged now, then swapped in: true once it's in place, to exit. */
const take = (url: string, release: string, want: string | null) =>
  Effect.tryPromise(async () => {
    await stage(url, release, want)
    await (process.platform === "darwin" ? swapBundle(release) : swapArchive(release))
  }).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        failed = release
        staged = null
      }).pipe(
        Effect.andThen(Effect.logWarning(`Couldn't take ${release}: staying on ${RELEASE}`, cause)),
        Effect.as(false),
      ),
    ),
  )

/** The core's release in place of this one when they differ: true once it's swapped in, to exit. */
export const takeRelease = (url: string, m: Release) =>
  Effect.gen(function* taking() {
    if (m.release === null || m.release === RELEASE || m.release === failed) {
      return false
    }
    const build = wanted(m.release, m.builds)
    if (build === null) {
      yield* Effect.logWarning(
        `The core runs ${m.release}, with no ${TARGET} build: staying on ${RELEASE}`,
      )
      return false
    }
    yield* Effect.logInfo(`The core runs ${m.release}: taking it in place of ${RELEASE}`)
    return yield* take(url, m.release, build.want)
  })

/**
 * The release coming next: fetched and checked ahead; once it's going in (`now`), one this host
 * holds is swapped in, true, to exit in the deploy's pause.
 */
export const takeNext = (url: string, m: Next) =>
  Effect.gen(function* coming() {
    const build = wanted(m.release, m.builds)
    if (build === null) {
      return false
    }
    if (m.now) {
      if (staged?.release !== m.release) {
        return false
      }
      yield* Effect.logInfo(`${m.release} is going in: swapping it in for ${RELEASE}`)
      return yield* take(url, m.release, build.want)
    }
    yield* Effect.logInfo(`${m.release} is coming: fetching it ahead`)
    yield* Effect.forkDetach(
      Effect.tryPromise(async () => {
        await stage(url, m.release, build.want)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (staged?.release === m.release) {
              staged = null
            }
          }).pipe(Effect.andThen(Effect.logWarning(`Couldn't fetch ${m.release} ahead`, cause))),
        ),
      ),
    )
    return false
  })
