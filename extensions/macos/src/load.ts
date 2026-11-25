// Whose load this Mac carries, boiled down from Switchboard's load-owners: every process counted
// toward its owner (the work or the extension whose mark it carries, the app it's part of, the
// Claude Code session that started it, else the program launchd started it under), with CPU and
// memory as each process's footprint, as Activity Monitor counts it (resident size counts every
// shared framework once per process), and its heaviest process. And the disk: free, and how fast
// it's falling. A resource alarm wakes the work it names (core alarms.ts).
import { statfsSync } from "node:fs"
import path from "node:path"

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

const UNITS: Record<string, number> = { B: 1 / 1024 ** 2, K: 1 / 1024, M: 1, G: 1024 }

/** Each process's footprint in MB, from top. */
const footprints = async () => {
  const out = await run(["top", "-l", "1", "-stats", "pid,mem", "-o", "mem", "-n", "1000"])
  const map = new Map<number, number>()
  for (const line of out.split("\n")) {
    const g = /^(?<pid>\d+)\s+(?<n>[\d.]+)(?<unit>[BKMG])\+?\s*$/u.exec(line.trim())?.groups
    if (g !== undefined) {
      map.set(Number(g.pid), Number(g.n) * (UNITS[g.unit ?? "M"] ?? 1))
    }
  }
  return map
}

interface P {
  readonly pid: number
  readonly ppid: number
  readonly cpu: number
  readonly args: string
}

/** The marks Switch gives what it starts, which all they start inherits (core runaway.ts). */
interface Mark {
  readonly work?: string
  readonly extension?: string
}

const WORK = /(?:^|\s)SWITCH_WORK=(?<id>\S+)/u
const EXTENSION = /(?:^|\s)SWITCH_EXTENSION=(?<id>\S+)/u

/** Each marked process's mark, from its environment, which macOS shows its user (not a platform
 * binary's, sh or sleep: those aren't what's heavy). */
const marksOf = async () => {
  const out = await run(["ps", "-axww", "-E", "-o", "pid=,command="])
  const map = new Map<number, Mark>()
  for (const line of out.split("\n")) {
    const pid = Number(/^\s*(?<pid>\d+)\s/u.exec(line)?.groups?.pid ?? "0")
    const work = WORK.exec(line)?.groups?.id
    const extension = EXTENSION.exec(line)?.groups?.id
    if (pid > 0 && (work !== undefined || extension !== undefined)) {
      map.set(pid, {
        ...(work !== undefined && { work }),
        ...(extension !== undefined && { extension }),
      })
    }
  }
  return map
}

/** A process's mark, or its nearest marked forebear's. */
const markOf = (p: P, byPid: Map<number, P>, marks: Map<number, Mark>) => {
  let at: P | undefined = p
  for (let hops = 0; at !== undefined && hops < 64; hops += 1) {
    const mark = marks.get(at.pid)
    if (mark !== undefined) {
      return mark
    }
    at = at.ppid <= 1 ? undefined : byPid.get(at.ppid)
  }
  return null
}

const COMMAND_CHARS = 160

/** A command as a person reads it: its program by name, cut short. */
const short = (args: string) => {
  const [program = "", ...rest] = args.replaceAll(/\s+/gu, " ").trim().split(" ")
  const shown = [path.basename(program), ...rest].join(" ")
  return shown.length > COMMAND_CHARS ? `${shown.slice(0, COMMAND_CHARS - 1)}…` : shown
}

const APP = /^.*?\/(?<name>[^/]+)\.app\//u
const CLAUDE = /(?:^|\/)claude(?:\s|$)|@anthropic-ai\/claude-code\//u

const ownerOf = (p: P, byPid: Map<number, P>, mark: Mark | null) => {
  if (mark?.work !== undefined) {
    return `work ${mark.work}`
  }
  if (mark?.extension !== undefined) {
    return `extension ${mark.extension}`
  }
  let at: P | undefined = p
  let top = p
  for (let hops = 0; at !== undefined && hops < 64; hops += 1) {
    const app = APP.exec(at.args)
    if (app !== null) {
      return app.groups?.name ?? "app"
    }
    if (CLAUDE.test(at.args)) {
      return `Claude Code (pid ${at.pid})`
    }
    top = at
    at = at.ppid <= 1 ? undefined : byPid.get(at.ppid)
  }
  return path.basename(top.args.split(" ")[0] ?? "?")
}

/** The data volume's free space over the past hour, as vitals read it. */
const samples: { at: number; gb: number }[] = []

export const noteDisk = (gb: number, at = Date.now()) => {
  samples.push({ at, gb })
  while (samples.length > 0 && (samples[0]?.at ?? at) < at - 3_600_000) {
    samples.shift()
  }
}

export const load = async (top = 12) => {
  const [ps, mem, marks] = await Promise.all([
    run(["ps", "-axww", "-o", "pid=,ppid=,%cpu=,args="]),
    footprints(),
    marksOf(),
  ])
  const all: P[] = ps.split("\n").flatMap((line) => {
    const g = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<cpu>[\d.]+)\s+(?<args>.*)$/u.exec(line)?.groups
    return g === undefined
      ? []
      : [{ pid: Number(g.pid), ppid: Number(g.ppid), cpu: Number(g.cpu), args: g.args ?? "" }]
  })
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const owners = new Map<
    string,
    { cpu: number; memoryMb: number; processes: number; mark: Mark | null; heaviest: P; mb: number }
  >()
  for (const p of all) {
    const mark = markOf(p, byPid, marks)
    const owner = ownerOf(p, byPid, mark)
    const mb = mem.get(p.pid) ?? 0
    const o = owners.get(owner) ?? { cpu: 0, memoryMb: 0, processes: 0, mark, heaviest: p, mb }
    o.cpu += p.cpu
    o.memoryMb += mb
    o.processes += 1
    if (mb + p.cpu * 20 > o.mb + o.heaviest.cpu * 20) {
      o.heaviest = p
      o.mb = mb
    }
    owners.set(owner, o)
  }
  const ranked = [...owners]
    .map(([owner, o]) => ({
      owner,
      ...(o.mark?.work !== undefined && { work: o.mark.work }),
      ...(o.mark?.extension !== undefined && { extension: o.mark.extension }),
      cpuPct: Math.round(o.cpu),
      memoryMb: Math.round(o.memoryMb),
      processes: o.processes,
      heaviest: { pid: o.heaviest.pid, command: short(o.heaviest.args) },
    }))
    .toSorted((a, b) => b.memoryMb + b.cpuPct * 20 - (a.memoryMb + a.cpuPct * 20))
    .slice(0, top)
  const fs = statfsSync("/System/Volumes/Data")
  const gb = (fs.bavail * fs.bsize) / 1e9
  const [first] = samples
  const hours = first === undefined ? 0 : (Date.now() - first.at) / 3_600_000
  const fallingGbPerHour = first !== undefined && hours > 0.1 ? (first.gb - gb) / hours : null
  return {
    disk: {
      freeGb: Math.round(gb * 10) / 10,
      ...(fallingGbPerHour === null
        ? {}
        : { fallingGbPerHour: Math.round(fallingGbPerHour * 10) / 10 }),
    },
    owners: ranked,
  }
}
