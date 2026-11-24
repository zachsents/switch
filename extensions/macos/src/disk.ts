// Where the disk goes, ported from Switchboard's sb-macos (disk.rs). A Mac's disk fills with what
// tools keep (a package manager's download cache keeps every version it fetched), build folders,
// simulators, toolchains and models, and each was found only once the disk was all but full. So
// every six hours it takes a census of what holds the disk; every hour it reads the free space, and
// from three days of readings says how fast it's falling and in how many days it'll be low. What
// grew between censuses counts what make_room cleared of it meanwhile, so a build folder built and
// cleared between two still shows as grown.
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "switch-ext-kit"

export const GB = 1e9
const HOUR = 3_600_000
const DAY = 24 * HOUR
const CENSUS_EVERY = 6 * HOUR
const SAMPLE_EVERY = HOUR
const KEEP = 8 * DAY
const TREND = 3 * DAY
const TREND_LEAST = DAY
const SAMPLES_LEAST = 4
const FALLING_LEAST = GB
/** Free space under which the disk is low. */
const LOW = 20 * GB
/** Free space under which it's critical. */
const CRITICAL = 10 * GB
const WARN_DAYS = 2
const WARN_AGAIN = DAY
const GREW_LEAST = GB
const LISTED_LEAST = 0.1 * GB

const home = homedir()

export const run = async (argv: readonly string[], timeoutMs = 120_000) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const timer = setTimeout(() => {
    proc.kill("SIGKILL")
  }, timeoutMs)
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  clearTimeout(timer)
  return { out, code }
}

/** The data volume's free bytes. */
export const free = () => {
  const fs = statfsSync("/System/Volumes/Data")
  return fs.bavail * fs.bsize
}

/**
 * Runs `f` on each item in turn, one finished before the next starts (what it clears changes what
 * the next should do), until it answers false.
 */
export const inTurn = async <T>(
  items: readonly T[],
  f: (item: T) => Promise<boolean>,
): Promise<void> => {
  const [first, ...rest] = items
  if (first !== undefined && (await f(first))) {
    await inTurn(rest, f)
  }
}

/** Each path's size in bytes, as du counts it (0 for one that's gone). */
export const sizes = async (paths: readonly string[]) => {
  const out = new Map<string, number>()
  const there = paths.filter((p) => existsSync(p))
  const batches: string[][] = []
  for (let i = 0; i < there.length; i += 50) {
    batches.push(there.slice(i, i + 50))
  }
  const done = await Promise.all(
    batches.map(async (b) => await run(["du", "-sk", "--", ...b], 600_000)),
  )
  for (const { out: text } of done) {
    for (const line of text.split("\n")) {
      const tab = line.indexOf("\t")
      if (tab > 0) {
        out.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024)
      }
    }
  }
  return (p: string) => out.get(p) ?? 0
}

export const size = async (p: string) => (await sizes([p]))(p)

interface ToolCache {
  readonly name: string
  readonly path: string
  /** The tool's own command that trims it, keeping what's in use. */
  readonly trim?: readonly string[]
  /** Processes that hold it while they run: never emptied under them. */
  readonly users?: readonly string[]
}

/** Tool caches: everything in one comes back by itself, fetched again when it's needed. */
const TOOL_CACHES: readonly ToolCache[] = [
  { name: "uv's cache", path: ".cache/uv", trim: ["uv", "cache", "prune"], users: ["uv", "uvx"] },
  { name: "Bun's cache", path: ".bun/install/cache" },
  { name: "npm's cache", path: ".npm/_cacache", users: ["npm", "npx"] },
  { name: "pnpm's store", path: "Library/pnpm/store", trim: ["pnpm", "store", "prune"] },
  { name: "Yarn's cache", path: "Library/Caches/Yarn", users: ["yarn"] },
  { name: "pip's cache", path: "Library/Caches/pip", users: ["pip", "pip3"] },
  { name: "Homebrew's downloads", path: "Library/Caches/Homebrew", users: ["brew"] },
  { name: "Go's build cache", path: "Library/Caches/go-build", users: ["go"] },
  { name: "SwiftPM's cache", path: "Library/Caches/org.swift.swiftpm", users: ["swift-build"] },
  {
    name: "Puppeteer's browsers",
    path: ".cache/puppeteer",
    users: ["chrome-headless-shell", "Google Chrome for Testing"],
  },
]

/** Big things that come back only by hand: measured, never cleared. */
const KEPT: readonly (readonly [string, string])[] = [
  ["iOS simulators", "Library/Developer/CoreSimulator/Devices"],
  ["Xcode's device support", "Library/Developer/Xcode/iOS DeviceSupport"],
  ["Xcode's archives", "Library/Developer/Xcode/Archives"],
  ["Cargo's registry", ".cargo/registry"],
  ["Rust toolchains", ".rustup/toolchains"],
  ["Hugging Face models", ".cache/huggingface"],
  ["PyTorch models", ".cache/torch"],
  ["Ollama models", ".ollama/models"],
  ["Playwright's browsers", "Library/Caches/ms-playwright"],
]

export const BUILD_FOLDERS = "build folders"

export interface Holder {
  readonly name: string
  readonly path?: string
  readonly bytes: number
  /** Whether make_room clears it. */
  readonly clears: boolean
}

export interface Trimmed {
  readonly name: string
  readonly freed: number
  readonly how: string
}

const running = async () => {
  const { out } = await run(["ps", "-axo", "comm="])
  return new Set(out.split("\n").map((l) => path.basename(l.trim())))
}

/** Empties a tool cache, by its own command when it has one, else by deleting what's in it. */
const trimOne = async (cache: ToolCache, procs: ReadonlySet<string>) => {
  const folder = path.join(home, cache.path)
  if (cache.users?.some((u) => procs.has(u)) === true) {
    return "in use"
  }
  if (cache.trim !== undefined && Bun.which(cache.trim[0] ?? "") !== null) {
    const { code } = await run(cache.trim, 180_000)
    return code === 0 ? "pruned" : "prune failed"
  }
  for (const name of readdirSync(folder)) {
    rmSync(path.join(folder, name), { recursive: true, force: true })
  }
  return "emptied"
}

/** Trims each tool cache at least `least` big, biggest first, while the free space is under `enough`. */
export const trimCaches = async (least: number, enough: number) => {
  const there = TOOL_CACHES.filter((c) => existsSync(path.join(home, c.path)))
  const measure = await sizes(there.map((c) => path.join(home, c.path)))
  const procs = await running()
  const out: Trimmed[] = []
  const ranked = there
    .map((c) => ({ c, bytes: measure(path.join(home, c.path)) }))
    .filter((x) => x.bytes >= least)
    .toSorted((a, b) => b.bytes - a.bytes)
  await inTurn(ranked, async ({ c, bytes }) => {
    if (free() >= enough) {
      return false
    }
    const how = await trimOne(c, procs).catch(String)
    const after = await size(path.join(home, c.path))
    out.push({ name: c.name, freed: Math.max(0, bytes - after), how })
    return true
  })
  return out
}

export interface Census {
  readonly at: number
  readonly holders: readonly Holder[]
  readonly buildFolders: number
}

/** What holds the disk now, biggest first. */
export const census = async (buildFolders: readonly string[]): Promise<Census> => {
  const caches = TOOL_CACHES.filter((c) => existsSync(path.join(home, c.path)))
  const kept = KEPT.filter(([, p]) => existsSync(path.join(home, p)))
  const measure = await sizes([
    ...caches.map((c) => path.join(home, c.path)),
    ...kept.map(([, p]) => path.join(home, p)),
    ...buildFolders,
  ])
  const holders: Holder[] = [
    ...caches.map((c) => ({
      name: c.name,
      path: `~/${c.path}`,
      bytes: measure(path.join(home, c.path)),
      clears: true,
    })),
    ...kept.map(([name, p]) => ({
      name,
      path: `~/${p}`,
      bytes: measure(path.join(home, p)),
      clears: false,
    })),
    {
      name: BUILD_FOLDERS,
      bytes: buildFolders.reduce((sum, f) => sum + measure(f), 0),
      clears: true,
    },
  ]
  return {
    at: Date.now(),
    holders: holders.toSorted((a, b) => b.bytes - a.bytes),
    buildFolders: buildFolders.length,
  }
}

interface History {
  /** The free space every hour: when, and bytes. */
  free: [number, number][]
  /** Each census: when, and what each holder took. */
  census: [number, Record<string, number>][]
  /** What each make_room cleared: when, and by holder. */
  cleared: [number, Record<string, number>][]
  warned: number | null
}

const empty = (): History => ({ free: [], census: [], cleared: [], warned: null })

export interface Trend {
  /** Bytes a day; rising when negative. */
  readonly falling: number
  readonly over: number
  /** The free space it's heading under. */
  readonly under: number
  readonly inDays: number | null
}

export interface Grew {
  readonly name: string
  readonly bytes: number
  readonly cleared: number
}

const isHistory = (v: unknown): v is History =>
  typeof v === "object" && v !== null && "free" in v && "census" in v && "cleared" in v

const parse: (text: string) => unknown = JSON.parse

const r1 = (n: number) => Math.round(n * 10) / 10
const gb = (bytes: number) => r1(bytes / GB)

const daysSaid = (ms: number) => {
  const days = Math.max(1, Math.round(ms / DAY))
  return days === 1 ? "day" : `${days} days`
}

const recently = (warned: number | null, now: number) =>
  warned !== null && now - warned < WARN_AGAIN && now >= warned

/** The trend, when it'll be low within two days. */
const soonOf = (t: Trend | null) =>
  t !== null && t.inDays !== null && t.inDays <= WARN_DAYS ? t : null

/** What a warning opens with: the rate it's falling at. */
const headline = (machine: string, bytes: number, soon: Trend) => {
  const freeSaid = bytes < 10 * GB ? (bytes / GB).toFixed(1) : (bytes / GB).toFixed(0)
  const days = soon.inDays ?? 0
  const when = days < 1 ? "less than a day" : `about ${days.toFixed(0)} days`
  return `${machine}'s disk is falling about ${(soon.falling / GB).toFixed(0)} GB a day: ${freeSaid} GB free, so under ${(soon.under / GB).toFixed(0)} GB in ${when}.`
}

const grewLines = (g: { readonly grew: readonly Grew[]; readonly over: number } | null) => {
  if (g === null) {
    return []
  }
  if (g.grew.length === 0) {
    return [
      `Nothing measured grew by a gigabyte in the last ${daysSaid(g.over)}, so it's elsewhere (media, mail, apps' data, a project).`,
    ]
  }
  const each = g.grew.slice(0, 4).map((x) => {
    const of =
      x.cleared >= GREW_LEAST ? ` (${(x.cleared / GB).toFixed(0)} GB of it cleared since)` : ""
    return `${x.name} ${(x.bytes / GB).toFixed(0)} GB${of}`
  })
  return [`In the last ${daysSaid(g.over)}, what grew: ${each.join(", ")}.`]
}

const biggestLine = (latest: Readonly<Record<string, number>>) => {
  const biggest = Object.entries(latest)
    .filter(([, b]) => b >= GREW_LEAST)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 4)
  return biggest.length === 0
    ? []
    : [
        `The biggest measured: ${biggest.map(([n, b]) => `${n} ${(b / GB).toFixed(0)} GB`).join(", ")}.`,
      ]
}

/** The disk's outlook: readings of the free space and the censuses, kept in a file. */
export const outlook = (file: string) => {
  let h: History = empty()
  try {
    const read = parse(readFileSync(file, "utf-8"))
    h = isHistory(read) ? read : empty()
  } catch {
    h = empty()
  }
  const save = () => {
    writeFileAtomic(file, JSON.stringify(h))
  }

  const sample = (now: number, bytes: number) => {
    const last = h.free.at(-1)
    if (last !== undefined && now - last[0] < SAMPLE_EVERY && now >= last[0]) {
      return
    }
    h.free.push([now, bytes])
    h.free = h.free.filter(([at]) => now - at <= KEEP)
    save()
  }

  const censusDue = (now: number) => {
    const last = h.census.at(-1)
    return last === undefined || now - last[0] >= CENSUS_EVERY || now < last[0]
  }

  const cleared = (at: number, by: Readonly<Record<string, number>>) => {
    const kept = Object.fromEntries(Object.entries(by).filter(([, b]) => b > 0))
    if (Object.keys(kept).length === 0) {
      return
    }
    h.cleared.push([at, kept])
    h.cleared = h.cleared.filter(([then]) => at - then <= KEEP)
    save()
  }

  const counted = (c: Census) => {
    h.census.push([c.at, Object.fromEntries(c.holders.map((x) => [x.name, x.bytes]))])
    h.census = h.census.filter(([at]) => c.at - at <= KEEP)
    save()
  }

  /** A least-squares line through the last three days' readings and now. */
  const trend = (now: number, bytes: number): Trend | null => {
    const recent = h.free.filter(([at]) => now - at <= TREND && at < now)
    const points = [...recent, [now, bytes] as const]
    const [oldest] = recent
    if (oldest === undefined || now - oldest[0] < TREND_LEAST || points.length < SAMPLES_LEAST) {
      return null
    }
    const n = points.length
    const meanAt = points.reduce((s, [at]) => s + at, 0) / n
    const meanFree = points.reduce((s, [, f]) => s + f, 0) / n
    const spread = points.reduce((s, [at]) => s + (at - meanAt) ** 2, 0)
    const slope = points.reduce((s, [at, f]) => s + (at - meanAt) * (f - meanFree), 0) / spread
    const falling = -slope * DAY
    const under = bytes > LOW ? LOW : CRITICAL
    const inDays = falling >= FALLING_LEAST && bytes > under ? (bytes - under) / falling : null
    return { falling, over: now - oldest[0], under, inDays }
  }

  /** What grew since the oldest census of the last three days, counting what was cleared meanwhile. */
  const grew = (): { readonly grew: readonly Grew[]; readonly over: number } | null => {
    const latest = h.census.at(-1)
    if (latest === undefined) {
      return null
    }
    const [latestAt, now] = latest
    const then = h.census.find(([at]) => latestAt - at <= TREND && latestAt - at >= TREND_LEAST)
    if (then === undefined) {
      return null
    }
    const [thenAt, before] = then
    const clearedBy = new Map<string, number>()
    for (const [at, by] of h.cleared) {
      if (at > thenAt && at <= latestAt) {
        for (const [name, b] of Object.entries(by)) {
          clearedBy.set(name, (clearedBy.get(name) ?? 0) + b)
        }
      }
    }
    const names = new Set([...Object.keys(now), ...clearedBy.keys()])
    const out = [...names]
      .map((name) => {
        const c = clearedBy.get(name) ?? 0
        return { name, bytes: (now[name] ?? 0) - (before[name] ?? 0) + c, cleared: c }
      })
      .filter((g) => g.bytes >= GREW_LEAST)
      .toSorted((a, b) => b.bytes - a.bytes)
    return { grew: out, over: latestAt - thenAt }
  }

  /** The census as the agent reads it: what holds the disk, what grew, the trend. */
  const facts = (c: Census, bytes: number) => {
    const t = trend(c.at, bytes)
    const g = grew()
    return {
      at: new Date(c.at).toISOString(),
      freeGb: gb(bytes),
      ...(t && {
        fallingGbADay: gb(t.falling),
        overDays: r1(t.over / DAY),
        underGb: gb(t.under),
        ...(t.inDays !== null && { inDays: r1(t.inDays) }),
      }),
      ...(g && { grewOverDays: r1(g.over / DAY) }),
      holders: c.holders
        .filter((x) => x.bytes >= LISTED_LEAST)
        .map((x) => {
          const grown = g?.grew.find((y) => y.name === x.name)
          return {
            name: x.name,
            ...(x.path !== undefined && { path: x.path }),
            gb: gb(x.bytes),
            clears: x.clears,
            ...(x.name === BUILD_FOLDERS && { count: c.buildFolders }),
            ...(grown && { grewGb: gb(grown.bytes) }),
            ...(grown && grown.cleared > 0 && { clearedGb: gb(grown.cleared) }),
          }
        }),
    }
  }

  /**
   * When the disk needs someone: under the floor within two days at the rate it's falling. At most
   * once a day.
   */
  const warning = (machine: string, now: number, bytes: number) => {
    if (recently(h.warned, now)) {
      return null
    }
    const soon = soonOf(trend(now, bytes))
    if (soon === null) {
      return null
    }
    const g = grew()
    const parts = [
      headline(machine, bytes, soon),
      ...grewLines(g),
      ...biggestLine(h.census.at(-1)?.[1] ?? {}),
    ]
    h.warned = now
    save()
    const urgent = soon.under === CRITICAL || (soon.inDays ?? 0) < 1
    return {
      machine,
      severity: urgent ? "high" : "medium",
      text: parts.join(" "),
      freeGb: gb(bytes),
      fallingGbADay: gb(soon.falling),
      inDays: r1(soon.inDays ?? 0),
      grew: (g?.grew ?? [])
        .slice(0, 6)
        .map((x) => ({ name: x.name, gb: gb(x.bytes), clearedGb: gb(x.cleared) })),
    }
  }

  return { sample, censusDue, cleared, counted, trend, grew, facts, warning }
}

export type Outlook = ReturnType<typeof outlook>
