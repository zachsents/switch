// Whose load this Mac carries, boiled down from Switchboard's load-owners: every process counted
// toward its owner (the app it's part of, the Claude Code session that started it, else the program
// launchd started it under), with CPU and memory as each process's footprint, as Activity Monitor
// counts it (resident size counts every shared framework once per process). And the disk: free,
// and how fast it's falling.
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

const APP = /^.*?\/(?<name>[^/]+)\.app\//u
const CLAUDE = /(?:^|\/)claude(?:\s|$)|@anthropic-ai\/claude-code\//u

const ownerOf = (p: P, byPid: Map<number, P>) => {
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
  const [ps, mem] = await Promise.all([
    run(["ps", "-axww", "-o", "pid=,ppid=,%cpu=,args="]),
    footprints(),
  ])
  const all: P[] = ps.split("\n").flatMap((line) => {
    const g = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<cpu>[\d.]+)\s+(?<args>.*)$/u.exec(line)?.groups
    return g === undefined
      ? []
      : [{ pid: Number(g.pid), ppid: Number(g.ppid), cpu: Number(g.cpu), args: g.args ?? "" }]
  })
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const owners = new Map<string, { cpu: number; memoryMb: number; processes: number }>()
  for (const p of all) {
    const owner = ownerOf(p, byPid)
    const o = owners.get(owner) ?? { cpu: 0, memoryMb: 0, processes: 0 }
    o.cpu += p.cpu
    o.memoryMb += mem.get(p.pid) ?? 0
    o.processes += 1
    owners.set(owner, o)
  }
  const ranked = [...owners]
    .map(([owner, o]) => ({
      owner,
      cpuPct: Math.round(o.cpu),
      memoryMb: Math.round(o.memoryMb),
      processes: o.processes,
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
