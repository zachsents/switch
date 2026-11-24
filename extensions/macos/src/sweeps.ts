// What clears the disk, ported from Switchboard's sb-macos (caches.rs). A build folder is only a
// cache: the next build there makes it again. Build folders are found by what's in them (Cargo's
// record of rustc, Xcode's info.plist) or, in a git worktree, by being a build output git ignores
// (target, build, dist…); a piece of work is a linked worktree, and what each holds is counted
// against its 8 GB budget. Nothing is deleted on its own: `make_room` clears tool caches, then
// build folders nothing built in for half an hour and nothing works in, oldest first, toward the
// room asked for.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { free, GB, inTurn, run, sizes, trimCaches } from "./disk.ts"
import type { Trimmed } from "./disk.ts"

const MINUTE = 60_000
/** Free space make_room stops at by default. */
const ENOUGH = 40 * GB
/** A tool cache under this isn't worth make_room's trim. */
const FLOOR = GB
/** Nothing built in a build folder for this long before make_room takes it. */
const IDLE = 30 * MINUTE
/** What one piece of work's build folders may hold before its turns should clear them. */
export const BUDGET = 8 * GB
const DEPTH = 6
const TEMP_DEPTH = 3
/** The home folder's folders macOS guards: reading them can prompt, or hang. */
const GUARDED = new Set([
  "Library",
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  ".Trash",
])
const SKIP = new Set([".git", "node_modules"])
/** A file in a build folder that keeps it from make_room. */
const KEEPS = [".keep", ".switchboard-keep"]
/** Switch's own state: never cleared. */
const STATE = process.env.SWITCH_DIR ?? path.resolve(process.cwd(), "../..")

const kept = (folder: string) =>
  folder.startsWith(`${STATE}/`) || KEEPS.some((k) => existsSync(path.join(folder, k)))

/** Build outputs by name, counted only where git ignores them. */
const OUTPUTS = new Set([
  "target",
  "build",
  "dist",
  ".build",
  ".next",
  ".turbo",
  "DerivedData",
  ".gradle",
])
const DERIVED_DATA = path.join(homedir(), "Library/Developer/Xcode/DerivedData")

const home = homedir()

const isDir = (e: Dirent) => e.isDirectory() && !e.isSymbolicLink()

const entries = (folder: string) => {
  try {
    return readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Cargo keeps its record of rustc in a build folder it made; Xcode, its info.plist. */
const marked = (folder: string) => {
  if (existsSync(path.join(folder, "Cargo.toml")) || existsSync(path.join(folder, ".git"))) {
    return false
  }
  return existsSync(path.join(folder, ".rustc_info.json")) || xcodeBuilt(folder)
}

/** Xcode's build folder names the project it builds in its info.plist. */
const xcodeBuilt = (folder: string) => {
  const info = path.join(folder, "info.plist")
  if (!existsSync(path.join(folder, "Build")) || !existsSync(info)) {
    return false
  }
  try {
    return statSync(info).size < 64 * 1024 && readFileSync(info, "latin1").includes("WorkspacePath")
  } catch {
    return false
  }
}

/** Whether git ignores `folder` in its repository: a build output, not source. */
const ignored = async (folder: string) => {
  const done = await run(["git", "-C", path.dirname(folder), "check-ignore", "-q", folder], 10_000)
  return done.code === 0
}

interface Found {
  /** Build folders by marker, anywhere. */
  readonly marked: string[]
  /** Linked worktrees: each piece of work. */
  readonly worktrees: string[]
}

/** Walks `root` `depth` down for build folders and worktrees, past what macOS guards and caches. */
const walk = (root: string, depth: number, found: Found) => {
  const folders: [string, number][] = [[root, 0]]
  for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
    const [folder, level] = next
    if (folder !== root) {
      if (marked(folder)) {
        found.marked.push(folder)
        continue
      }
      if (existsSync(path.join(folder, "CACHEDIR.TAG"))) {
        continue
      }
    }
    const git = path.join(folder, ".git")
    if (existsSync(git) && statSync(git).isFile()) {
      found.worktrees.push(folder)
    }
    if (level === depth) {
      continue
    }
    for (const e of entries(folder)) {
      const guarded = folder === home && GUARDED.has(e.name)
      if (isDir(e) && !guarded && !SKIP.has(e.name)) {
        folders.push([path.join(folder, e.name), level + 1])
      }
    }
  }
}

const temps = () => [
  ...new Set([tmpdir(), "/tmp"].filter((p) => existsSync(p)).map((p) => realpathSync(p))),
]

/** A worktree's build folders: marked ones, and the outputs git ignores, three levels in. */
const buildsIn = async (worktree: string) => {
  const out: string[] = []
  const outputs: string[] = []
  const folders: [string, number][] = [[worktree, 0]]
  for (let next = folders.pop(); next !== undefined; next = folders.pop()) {
    const [folder, level] = next
    for (const e of entries(folder)) {
      const p = path.join(folder, e.name)
      if (!isDir(e) || SKIP.has(e.name)) {
        continue
      }
      if (marked(p)) {
        out.push(p)
      } else if (OUTPUTS.has(e.name)) {
        outputs.push(p)
      } else if (level < 2 && !existsSync(path.join(p, ".git"))) {
        folders.push([p, level + 1])
      }
    }
  }
  const checked = await Promise.all(outputs.map(async (p) => ((await ignored(p)) ? [p] : [])))
  out.push(...checked.flat())
  return out
}

export interface Work {
  readonly worktree: string
  readonly folders: readonly string[]
}

export interface Scan {
  /** Every build folder: marked anywhere, and each worktree's. */
  readonly folders: readonly string[]
  readonly works: readonly Work[]
}

export const scan = async (): Promise<Scan> => {
  const found: Found = { marked: [], worktrees: [] }
  walk(home, DEPTH, found)
  for (const t of temps()) {
    walk(t, TEMP_DEPTH, found)
  }
  for (const e of entries(DERIVED_DATA)) {
    const p = path.join(DERIVED_DATA, e.name)
    if (isDir(e) && marked(p)) {
      found.marked.push(p)
    }
  }
  const works: Work[] = await Promise.all(
    found.worktrees.map(async (w) => ({ worktree: w, folders: await buildsIn(w) })),
  )
  const all = new Set([...found.marked, ...works.flatMap((w) => w.folders)])
  return { folders: [...all].toSorted(), works }
}

/** Where every process works and what it runs from: a folder in one is in use. */
export const inUse = async () => {
  const [cwds, ps] = await Promise.all([
    run(["lsof", "-a", "-d", "cwd", "-Fn"], 30_000),
    run(["ps", "-axww", "-o", "args="]),
  ])
  const places = cwds.out
    .split("\n")
    .filter((l) => l.startsWith("n/"))
    .map((l) => l.slice(1))
  const args = ps.out.split("\n")
  return (folder: string) =>
    places.some((p) => p === folder || p.startsWith(`${folder}/`)) ||
    args.some((a) => a.includes(`${folder}/`) || a.endsWith(folder))
}

/** Whether anything in it changed in the last `ms`, three levels in, where builds write. */
export const changedWithin = async (folder: string, ms: number) => {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  const { out } = await run(
    ["find", folder, "-maxdepth", "3", "-mmin", `-${minutes}`, "-print", "-quit"],
    60_000,
  )
  return out.trim() !== ""
}

export interface Swept {
  readonly folder: string
  readonly freed: number
  readonly worktree?: string
}

const remove = async (folder: string) => {
  const before = (await sizes([folder]))(folder)
  rmSync(folder, { recursive: true, force: true })
  const after = existsSync(folder) ? (await sizes([folder]))(folder) : 0
  return Math.max(0, before - after)
}

export interface ByWork {
  readonly worktree: string
  readonly gb: number
  readonly buildFolders: number
  readonly running: boolean
  readonly overBudget: boolean
}

/** What each piece of work's build folders hold, biggest first. */
export const byWork = async (s: Scan): Promise<readonly ByWork[]> => {
  const using = await inUse()
  const measure = await sizes(s.works.flatMap((w) => w.folders))
  return s.works
    .map((w) => {
      const bytes = w.folders.reduce((sum, f) => sum + measure(f), 0)
      return {
        worktree: w.worktree,
        gb: Math.round((bytes / GB) * 10) / 10,
        buildFolders: w.folders.filter((f) => existsSync(f)).length,
        running: using(w.worktree),
        overBudget: bytes > BUDGET,
      }
    })
    .filter((w) => w.gb >= 0.05)
    .toSorted((a, b) => b.gb - a.gb)
}

const lastChange = (folder: string) => {
  try {
    return statSync(folder).mtimeMs
  } catch {
    return 0
  }
}

/** Build folders nothing built in for `idle` and nothing works in, oldest first, while short. */
const sweepIdle = async (s: Scan, idle: number, enough: number) => {
  const using = await inUse()
  const out: Swept[] = []
  const oldest = s.folders
    .filter((f) => existsSync(f) && !kept(f))
    .toSorted((a, b) => lastChange(a) - lastChange(b))
  await inTurn(oldest, async (f) => {
    if (free() >= enough) {
      return false
    }
    if (!using(f) && !(await changedWithin(f, idle))) {
      const worktree = s.works.find((w) => w.folders.includes(f))?.worktree
      out.push({ folder: f, freed: await remove(f), ...(worktree !== undefined && { worktree }) })
    }
    return true
  })
  return out
}

export interface Cleared {
  readonly trimmed: readonly Trimmed[]
  readonly swept: readonly Swept[]
}

/** What a clearing freed, by holder, for the outlook. */
export const byHolder = (c: Cleared): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const t of c.trimmed) {
    out[t.name] = (out[t.name] ?? 0) + t.freed
  }
  out["build folders"] = c.swept.reduce((s, x) => s + x.freed, 0)
  return out
}

export const freedOf = (c: Cleared) =>
  c.trimmed.reduce((s, x) => s + x.freed, 0) + c.swept.reduce((s, x) => s + x.freed, 0)

/**
 * `make_room`: tool caches first (a download takes seconds where a build takes minutes), then
 * build folders idle for half an hour, toward `want` free; then the biggest build folders left.
 */
export const makeRoom = async (want: number | undefined) => {
  const target = want ?? ENOUGH
  const before = free()
  const s = await scan()
  const trimmed = free() < target ? await trimCaches(FLOOR, target) : []
  const swept = free() < target ? await sweepIdle(s, IDLE, target) : []
  const cleared: Cleared = { trimmed, swept }
  const after = free()
  const measure = await sizes(s.folders.filter((f) => existsSync(f)))
  const held = s.folders
    .filter((f) => existsSync(f))
    .map((f) => ({ folder: f, gb: Math.round((measure(f) / GB) * 10) / 10 }))
    .filter((h) => h.gb >= 0.1)
    .toSorted((a, b) => b.gb - a.gb)
    .slice(0, 5)
  return { s, cleared, before, after, target, held }
}
