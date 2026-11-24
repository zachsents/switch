// Whose load this machine carries, as the macOS extension's load tells it for a Mac: every process
// counted toward its owner (the work or the extension whose mark it carries, the Claude Code session
// that started it, else the program the init system started it under), with its CPU over a second
// and its memory as resident and swapped out together, and its heaviest process. Read from /proc. A
// resource alarm wakes the work it names (core alarms.ts).
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const text = (file: string) => {
  try {
    return readFileSync(file, "utf-8")
  } catch {
    return null
  }
}

/** Clock ticks a second, as nearly every kernel counts them (`getconf CLK_TCK`). */
const TICKS = 100

interface P {
  readonly pid: number
  readonly ppid: number
  /** Ticks of CPU it has used. */
  readonly ticks: number
  readonly memoryMb: number
  readonly args: string
  readonly work?: string
  readonly extension?: string
}

/** The marks Switch gives what it starts, which all they start inherits (core runaway.ts). */
const markIn = (environ: string, name: string) =>
  environ
    .split("\0")
    .find((kv) => kv.startsWith(`${name}=`))
    ?.slice(name.length + 1)

const procOf = (pid: number): P | null => {
  const stat = text(`/proc/${pid}/stat`)
  const status = text(`/proc/${pid}/status`)
  if (stat === null || status === null) {
    return null
  }
  // Its name sits in parentheses and may hold spaces: the fields count from after them.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const kb = (key: string) =>
    Number(new RegExp(`^${key}:\\s+(?<kb>\\d+)`, "mu").exec(status)?.groups?.kb ?? "0")
  const cmdline = (text(`/proc/${pid}/cmdline`) ?? "").split("\0").filter((a) => a !== "")
  const name = /\((?<name>.*)\)/u.exec(stat)?.groups?.name ?? "?"
  // Another user's environment isn't readable: theirs carry no mark of ours.
  const environ = text(`/proc/${pid}/environ`) ?? ""
  const work = markIn(environ, "SWITCH_WORK")
  const extension = markIn(environ, "SWITCH_EXTENSION")
  return {
    pid,
    ppid: Number(fields[1] ?? "0"),
    ticks: Number(fields[11] ?? "0") + Number(fields[12] ?? "0"),
    memoryMb: (kb("VmRSS") + kb("VmSwap")) / 1024,
    args: cmdline.length > 0 ? cmdline.join(" ") : `[${name}]`,
    ...(work !== undefined && { work }),
    ...(extension !== undefined && { extension }),
  }
}

const all = () =>
  readdirSync("/proc").flatMap((d) => {
    const p = /^\d+$/u.test(d) ? procOf(Number(d)) : null
    return p === null ? [] : [p]
  })

const CLAUDE = /(?:^|\/)claude(?:\s|$)|@anthropic-ai\/claude-code\//u
/** What starts a machine's programs: what's under one of these is its own. */
const INIT = new Set(["systemd", "init"])

const ownerOf = (p: P, byPid: Map<number, P>) => {
  let at: P | undefined = p
  let top = p
  for (let hops = 0; at !== undefined && hops < 64; hops += 1) {
    if (at.work !== undefined) {
      return { owner: `work ${at.work}`, work: at.work }
    }
    if (at.extension !== undefined) {
      return { owner: `extension ${at.extension}`, extension: at.extension }
    }
    if (CLAUDE.test(at.args)) {
      return { owner: `Claude Code (pid ${at.pid})` }
    }
    top = at
    const parent: P | undefined = at.ppid <= 1 ? undefined : byPid.get(at.ppid)
    at =
      parent !== undefined && INIT.has(path.basename(parent.args.split(" ")[0] ?? ""))
        ? undefined
        : parent
  }
  return { owner: path.basename(top.args.split(" ")[0] ?? "?") }
}

const COMMAND_CHARS = 160

/** A command as a person reads it: its program by name, cut short. */
const short = (args: string) => {
  const [program = "", ...rest] = args.split(" ")
  const shown = [path.basename(program), ...rest].join(" ")
  return shown.length > COMMAND_CHARS ? `${shown.slice(0, COMMAND_CHARS - 1)}…` : shown
}

export const load = async (top = 12) => {
  const before = new Map(all().map((p) => [p.pid, p.ticks]))
  await Bun.sleep(1000)
  const now = all()
  const byPid = new Map(now.map((p) => [p.pid, p]))
  const owners = new Map<
    string,
    {
      readonly mark: { readonly work?: string; readonly extension?: string }
      cpu: number
      memoryMb: number
      processes: number
      heaviest: { readonly p: P; readonly score: number }
    }
  >()
  for (const p of now) {
    // Percent of one core over the second between the looks, as `top` counts it.
    const cpu = Math.max(0, p.ticks - (before.get(p.pid) ?? p.ticks)) / (TICKS / 100)
    const { owner, ...mark } = ownerOf(p, byPid)
    const score = p.memoryMb + cpu * 20
    const o = owners.get(owner) ?? {
      mark,
      cpu: 0,
      memoryMb: 0,
      processes: 0,
      heaviest: { p, score },
    }
    o.cpu += cpu
    o.memoryMb += p.memoryMb
    o.processes += 1
    if (score > o.heaviest.score) {
      o.heaviest = { p, score }
    }
    owners.set(owner, o)
  }
  return {
    owners: [...owners]
      .map(([owner, o]) => ({
        owner,
        ...o.mark,
        cpuPct: Math.round(o.cpu),
        memoryMb: Math.round(o.memoryMb),
        processes: o.processes,
        heaviest: { pid: o.heaviest.p.pid, command: short(o.heaviest.p.args) },
      }))
      .toSorted((a, b) => b.memoryMb + b.cpuPct * 20 - (a.memoryMb + a.cpuPct * 20))
      .slice(0, top),
  }
}
