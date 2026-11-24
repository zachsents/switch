// Strays, ported from Switchboard's proc-sweep (strays.rs): processes left running on this Mac by
// agent turns and execs once what started them is gone, and stopping the ones provably done with.
// A stray is a process of this user left to launchd (its parent is pid 1), not a launchd job,
// with no terminal; with what it started, it's one unit. One that carries an agent's work's mark
// (SWITCH_WORK, which Switch gives each turn and script and all they start) is one whatever it runs;
// one without is a stray only when it isn't macOS's or an app's. By kind:
// - work: one carrying its work's mark. Stopped WORK_ENDED after it's first seen with its work over
//   (the work neither running, nor waiting on a watch or script of its own, nor carried on).
// - claude-shell: a Claude Code Bash shell whose session is gone. Stopped SHELL_GONE after.
// - exec: started by this extension's exec (SWITCH_EXEC), like a dev server. Stopped once it's run
//   WORK_IDLE and nothing is connected to it.
// - leftover: what nobody keeps on purpose (log stream, tail -f, a headless browser, a screen
//   recording). Stopped LEFTOVER after it's first seen.
// - unclaimed: anything else. Only reported.
// Never stopped: launchd jobs, anything with a terminal, anything a keep rule matches, anything
// younger than YOUNG. Each is checked again by pid and start just before TERM, then KILL.
import { existsSync, readFileSync } from "node:fs"
import { writeFileAtomic } from "switch-ext-kit"

export const SHELL_GONE_S = 15 * 60
export const WORK_ENDED_S = 15 * 60
export const WORK_IDLE_S = 24 * 3600
export const LEFTOVER_S = 2 * 3600
const YOUNG_S = 300
const GRACE_MS = 10_000

const SYSTEM =
  /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/Apple\/|\/Library\/Developer\/PrivateFrameworks\/|\/Library\/PrivilegedHelperTools\/|\/Library\/Application Support\/)/u
const APP = /\.app\/Contents\//u
const NOT_OURS =
  /(?:^|\/)(?:codex\b.*\bapp-server|ssh-agent|sshd|chrome_crashpad_handler|crashpad_handler)\b|^(?:\/bin\/)?sleep \S+$/u
const CLAUDE_SHELL = /\/\.claude\/shell-snapshots\/snapshot-/u
const LEFTOVERS: readonly (readonly [string, RegExp])[] = [
  ["log stream", /^(?:\/usr\/bin\/)?log\s+(?:stream|show)\b/u],
  ["tail -f", /^(?:\/usr\/bin\/)?tail\s+(?:-\S*[fF])/u],
  [
    "headless browser",
    /(?:Chromium|Chrome|chrome-headless-shell|Google Chrome for Testing|msedge|firefox)[^ ]*\s.*--(?:headless|remote-debugging-(?:port|pipe))/u,
  ],
  [
    "screen recording",
    /ffmpeg\b.*-f\s+avfoundation|simctl\s+io\s+\S+\s+recordVideo|screencapture\s+-\S*v/u,
  ],
]

export interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly ageS: number
  readonly tty: string
  readonly args: string
}

export type Kind = "work" | "claude-shell" | "exec" | "leftover" | "unclaimed"

/** Which of these works still go on; null when that can't be told. */
export type Live = (works: readonly string[]) => Promise<ReadonlySet<string> | null>

export interface Stray {
  readonly pid: number
  readonly kind: Kind
  readonly what: string
  readonly ageS: number
  /** Its unit's processes, itself first. */
  readonly pids: readonly number[]
  /** When it's due to be stopped (s from now), or null: only reported. */
  readonly stopInS: number | null
  /** Why its kind couldn't be read: it's kept, only reported. */
  readonly unread?: string
}

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

/** `[[dd-]hh:]mm:ss` in seconds. */
const seconds = (etime: string) => {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime]
  const parts = (rest ?? "").split(":").map(Number).toReversed()
  return Number(days) * 86_400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600
}

export const processes = async (): Promise<readonly Proc[]> => {
  const uid = process.getuid?.() ?? 0
  const out = await run(["ps", "-axww", "-o", "pid=,ppid=,uid=,etime=,tty=,args="])
  return out.split("\n").flatMap((line) => {
    const g =
      /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<uid>\d+)\s+(?<etime>\S+)\s+(?<tty>\S+)\s+(?<args>.*)$/u.exec(
        line,
      )?.groups
    if (g === undefined || Number(g.uid) !== uid) {
      return []
    }
    return [
      {
        pid: Number(g.pid),
        ppid: Number(g.ppid),
        ageS: seconds(g.etime ?? "0"),
        tty: g.tty ?? "??",
        args: g.args ?? "",
      },
    ]
  })
}

const launchdJobs = async () => {
  const out = await run(["launchctl", "list"])
  return new Set(
    out.split("\n").flatMap((l) => (/^\d+/u.test(l) ? [Number(l.split("\t")[0])] : [])),
  )
}

// A process's environment, after its command (macOS shows a program's to its user, though not a
// platform binary's, sh or sleep: a unit's other members still show theirs).
const envOf = async (pid: number) =>
  await run(["ps", "-E", "-ww", "-o", "command=", "-p", String(pid)])

const WORK = /(?:^|\s)SWITCH_WORK=(?<work>\S+)/u

/** The work a unit's members carry the mark of, or null. */
const workOf = async (unit: readonly Proc[]) => {
  const envs = await Promise.all(unit.map(async (p) => await envOf(p.pid)))
  return envs.map((e) => WORK.exec(e)?.groups?.work).find((w) => w !== undefined) ?? null
}

const connected = async (pids: readonly number[]) => {
  const out = await run(["lsof", "-a", "-nP", "-iTCP", "-sTCP:ESTABLISHED", "-p", pids.join(",")])
  return out.trim().split("\n").length > 1
}

interface Rules {
  /** Substrings of a command line never stopped. */
  readonly keep: readonly string[]
  /** When each unit (pid:start) was first seen, in ms. */
  readonly seen: Record<string, number>
}

export const loadRules = (file: string): Rules => {
  if (!existsSync(file)) {
    return { keep: [], seen: {} }
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"))
    if (typeof raw === "object" && raw !== null && "keep" in raw && Array.isArray(raw.keep)) {
      const seen =
        "seen" in raw && typeof raw.seen === "object" && raw.seen !== null ? raw.seen : {}
      return {
        keep: raw.keep.map(String),
        seen: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, Number(v)])),
      }
    }
  } catch {
    // A broken file starts over.
  }
  return { keep: [], seen: {} }
}

const save = (file: string, rules: Rules) => {
  writeFileAtomic(file, JSON.stringify(rules))
}

/** The kind of a unit, from what its members run and carry. */
const kindOf = async (
  unit: readonly Proc[],
  work: string | null,
  going: ReadonlySet<string> | null,
): Promise<{ kind: Kind; what: string; over?: boolean }> => {
  if (work !== null) {
    if (going === null) {
      return { kind: "work", what: `${work}'s, whose state can't be told` }
    }
    return going.has(work)
      ? { kind: "work", what: `${work}'s, which goes on` }
      : { kind: "work", what: `left by ${work}, which is over`, over: true }
  }
  for (const p of unit) {
    const leftover = LEFTOVERS.find(([, re]) => re.test(p.args))
    if (leftover !== undefined) {
      return { kind: "leftover", what: leftover[0] }
    }
  }
  if (unit.some((p) => CLAUDE_SHELL.test(p.args))) {
    return { kind: "claude-shell", what: "a gone Claude Code session's shell" }
  }
  const envs = await Promise.all(unit.map(async (p) => await envOf(p.pid)))
  if (envs.some((e) => e.includes("SWITCH_EXEC="))) {
    return { kind: "exec", what: "left running by an exec" }
  }
  return { kind: "unclaimed", what: "unclaimed" }
}

const dueIn = (kind: Kind, firstSeenS: number, ageS: number, inUse: boolean, over: boolean) => {
  if (kind === "work") {
    return over ? WORK_ENDED_S - firstSeenS : null
  }
  if (kind === "claude-shell") {
    return SHELL_GONE_S - firstSeenS
  }
  if (kind === "leftover") {
    return LEFTOVER_S - firstSeenS
  }
  if (kind === "exec") {
    return inUse ? null : WORK_IDLE_S - ageS
  }
  return null
}

/** Every stray now, and the rules file updated with when each was first seen. */
export const look = async (file: string, live: Live): Promise<readonly Stray[]> => {
  const rules = loadRules(file)
  const [all, jobs] = await Promise.all([processes(), launchdJobs()])
  const kids = new Map<number, Proc[]>()
  for (const p of all) {
    kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  }
  const tree = (p: Proc): Proc[] => [p, ...(kids.get(p.pid) ?? []).flatMap(tree)]
  const now = Date.now()
  const seen: Record<string, number> = {}
  const orphans = all.filter(
    (p) =>
      p.ppid === 1 &&
      p.tty === "??" &&
      !jobs.has(p.pid) &&
      p.pid !== process.pid &&
      !rules.keep.some((k) => p.args.includes(k)),
  )
  const works = new Map(
    await Promise.all(orphans.map(async (p) => [p.pid, await workOf(tree(p))] as const)),
  )
  const candidates = orphans.filter((p) => {
    const exe = p.args.split(" ")[0] ?? ""
    return (
      (works.get(p.pid) ?? null) !== null ||
      (!SYSTEM.test(exe) && !APP.test(p.args) && !NOT_OURS.test(p.args))
    )
  })
  const marked = [...new Set([...works.values()].filter((w) => w !== null))]
  const going = marked.length === 0 ? new Set<string>() : await live(marked)
  const found = await Promise.all(
    candidates.map(async (p): Promise<Stray> => {
      const unit = tree(p)
      const key = `${p.pid}:${p.args}`
      const first = rules.seen[key] ?? now
      const pids = unit.map((u) => u.pid)
      try {
        const { kind, what, over = false } = await kindOf(unit, works.get(p.pid) ?? null, going)
        // A work's process is first seen once its work is over: its wait starts then.
        if (kind !== "work" || over) {
          seen[key] = first
        }
        const inUse = kind === "exec" ? await connected(pids) : false
        const due = p.ageS < YOUNG_S ? null : dueIn(kind, (now - first) / 1000, p.ageS, inUse, over)
        return {
          pid: p.pid,
          kind,
          what: `${what}: ${p.args.slice(0, 160)}`,
          ageS: p.ageS,
          pids,
          stopInS: due === null ? null : Math.max(0, Math.round(due)),
        }
      } catch (error) {
        // One unit that can't be read is kept and said, never a reason to skip the rest.
        const unread = error instanceof Error ? error.message : String(error)
        const what = `unclaimed: ${p.args.slice(0, 160)}`
        return { pid: p.pid, kind: "unclaimed", what, ageS: p.ageS, pids, stopInS: null, unread }
      }
    }),
  )
  save(file, { keep: rules.keep, seen })
  return found
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** TERM, then KILL after the grace, each unit checked again first: still a stray, same start. */
export const stop = async (strays: readonly Stray[]) => {
  const now = await processes()
  const still = strays.filter((s) =>
    now.some((p) => p.pid === s.pid && p.ppid === 1 && Math.abs(p.ageS - s.ageS) < 120),
  )
  for (const s of still) {
    for (const pid of s.pids) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // Gone already.
      }
    }
  }
  if (still.length > 0) {
    await Bun.sleep(GRACE_MS)
  }
  for (const s of still) {
    for (const pid of s.pids.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Gone in between.
      }
    }
  }
  return still
}

/** Adds a rule: command lines holding `text` are never stopped. */
export const keep = (file: string, text: string) => {
  const rules = loadRules(file)
  const kept = [...new Set([...rules.keep, text])]
  save(file, { keep: kept, seen: rules.seen })
  return { keep: kept }
}
