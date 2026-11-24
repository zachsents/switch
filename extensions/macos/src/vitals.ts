// A Mac's vitals, as Switchboard's sb-macos read them (vitals.rs, pressure.rs): load, CPU, memory
// and its pressure, swap, the data volume's free space, and the battery.
import { statfsSync } from "node:fs"
import { cpus, loadavg } from "node:os"

import { Schema } from "effect"

export const reading = Schema.Struct({
  machine: Schema.String,
  cores: Schema.Finite,
  load: Schema.Finite,
  /** Percent of all cores, since the last reading. */
  cpu: Schema.Finite,
  /** CPU over 90% for five minutes or more. */
  cpuHot: Schema.optionalKey(Schema.Boolean),
  memoryPct: Schema.Finite,
  pressure: Schema.Literals(["normal", "warn", "critical"]),
  swapGb: Schema.Finite,
  diskFreeGb: Schema.Finite,
  /** Of the data volume, as `df` counts it. */
  diskUsedPct: Schema.optionalKey(Schema.Finite),
  battery: Schema.optionalKey(
    Schema.Struct({ pct: Schema.Finite, charging: Schema.Boolean, onBattery: Schema.Boolean }),
  ),
})
export type Reading = typeof reading.Type

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

const round = (n: number) => Math.round(n * 10) / 10

const busy = () => {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}
let last = busy()

const battery = (text: string): Reading["battery"] => {
  const line = text.split("\n").find((l) => l.includes("InternalBattery"))
  const pct = line === undefined ? undefined : /(?<pct>\d+)%;/u.exec(line)?.groups?.pct
  if (line === undefined || pct === undefined) {
    return undefined
  }
  return {
    pct: Number(pct),
    charging: line.includes("; charging;"),
    onBattery: text.includes("'Battery Power'"),
  }
}

const PRESSURE: Record<string, Reading["pressure"]> = {
  "1": "normal",
  "2": "warn",
  "4": "critical",
}

const HOT_CPU = 90
const HOT_FOR_NS = 5 * 60 * 1e9
/** Since when the CPU has stayed over `HOT_CPU`, on the monotonic clock; null if it isn't. */
let hotFrom: number | null = null

/** Whether the CPU has stayed over 90% for five minutes, readings about a minute apart. */
const sustained = (cpu: number) => {
  const now = Bun.nanoseconds()
  if (cpu <= HOT_CPU) {
    hotFrom = null
    return false
  }
  hotFrom ??= now
  return now - hotFrom >= HOT_FOR_NS
}

export const read = async (machine: string): Promise<Reading> => {
  const [free, level, swap, batt] = await Promise.all([
    run(["memory_pressure", "-Q"]),
    run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]),
    run(["sysctl", "-n", "vm.swapusage"]),
    run(["pmset", "-g", "batt"]),
  ])
  const now = busy()
  const spent = now.total - last.total
  const cpu = spent > 0 ? (1 - (now.idle - last.idle) / spent) * 100 : 0
  last = now
  const freePct = Number(/(?<pct>\d+)%/u.exec(free)?.groups?.pct ?? "100")
  const used = /used = (?<mb>[\d.]+)M/u.exec(swap)?.groups?.mb ?? "0"
  const disk = statfsSync("/System/Volumes/Data")
  const usedBlocks = disk.blocks - disk.bfree
  const b = battery(batt)
  return {
    machine,
    cores: cpus().length,
    load: round(loadavg()[0] ?? 0),
    cpu: round(cpu),
    cpuHot: sustained(cpu),
    memoryPct: 100 - freePct,
    pressure: PRESSURE[level.trim()] ?? "normal",
    swapGb: round(Number(used) / 1024),
    diskFreeGb: round((disk.bavail * disk.bsize) / 1e9),
    diskUsedPct: round((usedBlocks / (usedBlocks + disk.bavail)) * 100),
    ...(b === undefined ? {} : { battery: b }),
  }
}

const LOW_DISK_GB = 10

/** What a glance at it should notice, worst first, by the meter it shows on: critical pressure, a
 * full disk, a flat battery, sustained CPU. */
const warnings = (r: Reading) => [
  ...(r.pressure === "critical" ? [{ on: "pressure", say: "Memory critical" }] : []),
  ...(r.diskFreeGb < LOW_DISK_GB
    ? [{ on: "disk", say: `${r.diskFreeGb.toFixed(0)} GB free` }]
    : []),
  ...(r.battery !== undefined && r.battery.onBattery && r.battery.pct <= 15
    ? [{ on: "battery", say: `Battery ${r.battery.pct}%` }]
    : []),
  ...(r.cpuHot === true ? [{ on: "cpu", say: "CPU busy" }] : []),
]

export const alerts = (r: Reading): readonly string[] => warnings(r).map((w) => w.say)

/** The meters `alerts` show on. */
export const alerting = (r: Reading): readonly string[] => warnings(r).map((w) => w.on)

/** A change worth an event between the regular ones: a new alert, or the power plugged or pulled. */
export const notable = (was: Reading | null, now: Reading) =>
  was === null ||
  alerts(was).join(",") !== alerts(now).join(",") ||
  was.battery?.onBattery !== now.battery?.onBattery
