// A monorepo's folder packed as a package, from a bare clone of the repo kept beside the core's or
// host's extensions.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect, Semaphore } from "effect"

/** One pack at a time in a process: extensions starting together share a clone and its fetches. */
const one = Semaphore.makeUnsafe(1)

const git = (...args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
      const [code, out, err] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ])
      if (code !== 0) {
        const verb = args[0] === "-C" ? args[2] : args[0]
        throw new Error(`git ${verb ?? ""}: ${err.trim().split("\n").at(-1) ?? code}`)
      }
      return out.trim()
    },
    catch: (error) => (error instanceof Error ? error.message : "git failed"),
  })

/**
 * A monorepo's folder at `from`'s commit (its default branch's newest without one), packed as a
 * package from the repo's bare clone in `<dir>/extension-src`: the pack and its commit. The core packs
 * it to install it, and each host again for its own copy, since the pack is a file on its machine.
 */
export const packFolder = (dir: string, from: string, folder: string) =>
  Effect.gen(function* packing() {
    const [repo = "", ref = ""] = from.split("#")
    const name = repo.replace(/^github:/u, "").replaceAll("/", "-")
    const src = path.join(dir, "extension-src")
    const clone = path.join(src, `${name}.git`)
    mkdirSync(src, { recursive: true })
    if (!existsSync(path.join(clone, "HEAD"))) {
      yield* git("clone", "-q", "--bare", repo.replace(/^github:/u, "https://github.com/"), clone)
    }
    const known =
      ref !== "" &&
      (yield* git("-C", clone, "cat-file", "-e", `${ref}^{commit}`).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ))
    if (!known) {
      yield* git("-C", clone, "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*")
    }
    const commit = yield* git("-C", clone, "rev-parse", `${ref === "" ? "HEAD" : ref}^{commit}`)
    const pack = path.join(src, `${name}-${folder.replaceAll("/", "-")}-${commit}.tgz`)
    if (!existsSync(pack)) {
      const part = `${pack}.${crypto.randomUUID()}.part`
      yield* git(
        "-C",
        clone,
        "archive",
        "--format=tar.gz",
        "--prefix=package/",
        "-o",
        part,
        `${commit}:${folder}`,
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            rmSync(part, { force: true })
          }),
        ),
      )
      renameSync(part, pack)
    }
    return { pack, commit }
  }).pipe(one.withPermits(1))
