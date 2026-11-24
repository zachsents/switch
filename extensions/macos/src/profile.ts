// What a process costs on this Mac, phase by phase, from Switchboard's sb-macos profile: for each
// phase its CPU (percent of one core), idle wakeups a second and memory, each second and in all,
// with the processes it started counted in. Phases are spans of rest one after another, named so
// a turn can do something between them (open a window, start a load) and compare.
import { inTurn } from "./disk.ts"

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

/** The pid of a process given by pid, or by its name, or an app's. */
const resolve = async (which: string | number) => {
  if (typeof which === "number") {
    return which
  }
  const exact = await firstLine(["pgrep", "-x", which])
  if (exact !== "") {
    return Number(exact)
  }
  const loose = await firstLine(["pgrep", "-f", `${which}.app/Contents/MacOS/`])
  if (loose === "") {
    throw new Error(`No process ${which}`)
  }
  return Number(loose)
}

const descendants = async (root: number) => {
  const listed = await run(["ps", "-A", "-o", "pid=,ppid="])
  const rows = listed.trim().split("\n")
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const [pid, ppid] = row.trim().split(/\s+/u).map(Number)
    if (pid !== undefined && ppid !== undefined) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid])
    }
  }
  const out: number[] = []
  const walk = (pid: number) => {
    for (const c of children.get(pid) ?? []) {
      out.push(c)
      walk(c)
    }
  }
  walk(root)
  return out
}

const UNITS: Record<string, number> = { B: 1 / 1024 ** 2, K: 1 / 1024, M: 1, G: 1024 }

const firstLine = async (argv: readonly string[]) => {
  const out = await run(argv)
  return out.trim().split("\n")[0] ?? ""
}

interface Second {
  readonly cpu: number
  readonly wakeups: number
  readonly memoryMb: number
}

/** `top`'s samples a second apart for these pids, each summed; the first, which has no CPU yet, dropped. */
const sample = async (pids: readonly number[], seconds: number): Promise<Second[]> => {
  const args = pids.flatMap((p) => ["-pid", String(p)])
  const out = await run([
    "top",
    "-l",
    String(seconds + 1),
    "-s",
    "1",
    ...args,
    "-stats",
    "pid,cpu,idlew,mem",
  ])
  const blocks = out
    .split(/^Processes:/mu)
    .slice(1)
    .map(parseBlock)
  // Idle wakeups are counted since each process started: each second's are the difference.
  return blocks.slice(1).map((b, i) => ({
    ...b,
    wakeups: Math.max(0, b.wakeups - (blocks[i]?.wakeups ?? b.wakeups)),
  }))
}

const parseBlock = (block: string): Second => {
  let cpu = 0
  let wakeups = 0
  let memoryMb = 0
  for (const line of block.split("\n")) {
    const g = /^\s*(?<pid>\d+)\s+(?<cpu>[\d.]+)\s+(?<w>\d+)\s+(?<mem>[\d.]+)(?<unit>[BKMG])/u.exec(
      line,
    )?.groups
    if (g !== undefined) {
      cpu += Number(g.cpu)
      wakeups += Number(g.w)
      memoryMb += Number(g.mem) * (UNITS[g.unit ?? "M"] ?? 1)
    }
  }
  return { cpu, wakeups, memoryMb }
}

const r1 = (n: number) => Math.round(n * 10) / 10

const summary = (name: string, series: readonly Second[]) => {
  const n = Math.max(1, series.length)
  let peak = 0
  let total = 0
  let wakeups = 0
  for (const x of series) {
    peak = Math.max(peak, x.cpu)
    total += x.cpu
    wakeups += x.wakeups
  }
  return {
    phase: name,
    seconds: series.length,
    cpuPct: r1(total / n),
    wakeupsPerS: r1(wakeups / n),
    peakCpuPct: r1(peak),
    memoryMb: Math.round(series.at(-1)?.memoryMb ?? 0),
    series: series.map((x) => ({ cpu: r1(x.cpu), wakeups: x.wakeups })),
  }
}

export const profile = async (input: {
  readonly process: string | number
  readonly phases?: readonly string[]
  readonly seconds?: number
}) => {
  const pid = await resolve(input.process)
  const helpers = await descendants(pid)
  const seconds = Math.min(Math.max(1, input.seconds ?? 10), 300)
  const phases = (input.phases ?? ["rest"]).slice(0, Math.max(1, Math.floor(600 / seconds)))
  const out: ReturnType<typeof summary>[] = []
  await inTurn(phases, async (name) => {
    out.push(summary(name, await sample([pid, ...helpers], seconds)))
    return true
  })
  const command = await firstLine(["ps", "-p", String(pid), "-o", "args="])
  const age = await firstLine(["ps", "-p", String(pid), "-o", "etime="])
  return {
    pid,
    command: command.slice(0, 300),
    runningFor: age,
    helpers: helpers.length,
    phases: out,
  }
}
