// A monorepo's folder packed as a package, from a bare clone of the repo kept beside the core's or
// host's extensions. A symlink in the folder to elsewhere in the repo (code extensions share, as the
// vitals widget) is packed as what it points to, so shared code reaches each extension at the
// commit it's pinned to, with no release of its own.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect, Semaphore } from "effect"

/** One pack at a time in a process: extensions starting together share a clone and its fetches. */
const one = Semaphore.makeUnsafe(1)

const gitWith = (env: Readonly<Record<string, string>>, ...args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      })
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

const git = (...args: string[]) => gitWith({}, ...args)

/**
 * The tree `folder` packs as at `commit`: its own, or, with symlinks out of it, its own built in a
 * scratch index with each such link replaced by what it points to at that commit.
 */
const treeOf = (clone: string, commit: string, folder: string) =>
  Effect.gen(function* building() {
    const links = (yield* git("-C", clone, "ls-tree", "-r", commit, "--", `${folder}/`))
      .split("\n")
      .flatMap((line) => {
        const m = /^120000 blob (?<blob>\w+)\t(?<at>.+)$/u.exec(line)
        return m?.groups?.blob === undefined || m.groups.at === undefined
          ? []
          : [{ blob: m.groups.blob, at: m.groups.at }]
      })
    const outward = yield* Effect.all(
      links.map((l) =>
        git("-C", clone, "cat-file", "blob", l.blob).pipe(
          Effect.map((target) => ({
            at: path.posix.relative(folder, l.at),
            to: path.posix.join(path.posix.dirname(l.at), target),
          })),
        ),
      ),
    ).pipe(Effect.map((all) => all.filter((l) => !l.to.startsWith(`${folder}/`))))
    if (outward.length === 0) {
      return `${commit}:${folder}`
    }
    // An empty work tree of its own, which update-index asks for and never touches.
    const scratch = path.join(path.dirname(clone), `pack-${crypto.randomUUID()}`)
    mkdirSync(scratch)
    const indexed = (...args: string[]) =>
      gitWith(
        { GIT_INDEX_FILE: path.join(scratch, "index"), GIT_WORK_TREE: scratch },
        "-C",
        clone,
        ...args,
      )
    return yield* Effect.gen(function* replacing() {
      yield* indexed("read-tree", `${commit}:${folder}`)
      for (const l of outward) {
        const [mode = "", type = "", sha = ""] = (yield* git(
          "-C",
          clone,
          "ls-tree",
          commit,
          "--",
          l.to,
        )).split(/\s/u)
        yield* indexed("update-index", "--force-remove", l.at)
        yield* type === "tree"
          ? indexed("read-tree", `--prefix=${l.at}/`, sha)
          : indexed("update-index", "--add", "--cacheinfo", `${mode},${sha},${l.at}`)
      }
      return yield* indexed("write-tree")
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(scratch, { recursive: true, force: true })
        }),
      ),
    )
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
      const tree = yield* treeOf(clone, commit, folder)
      const part = `${pack}.${crypto.randomUUID()}.part`
      yield* git(
        "-C",
        clone,
        "archive",
        "--format=tar.gz",
        "--prefix=package/",
        "-o",
        part,
        tree,
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
