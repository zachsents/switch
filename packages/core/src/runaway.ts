// Runaways, ported from Switchboard's macOS appendage (runaway.rs): a process an agent started on a
// Mac whose memory grows past half the Mac's is stopped, and is a surprise for the work it ran for.
// macOS stops nothing for outgrowing its memory: it swaps it out to the disk for as long as there's
// room, so a runaway takes the disk down with the memory, and everything that writes there with it.
// On Nov 21 a mesh check grew to 75 GB on a 16 GB Mac in ten minutes, its swap taking the disk from
// 23 GB free to 5.6; on Nov 23 an image outpaint left detached by a job script grew to 11 GB there,
// and a canary failed on the full disk (`SQLiteError: disk I/O error`). Its memory is its footprint,
// as Activity Monitor and macOS count it, so what's compressed or swapped out still counts.
// - An agent's process is one carrying a mark, which all it starts inherits, a job left detached
//   too: `SWITCH_WORK`, the work a turn or a script ran for (hosts.ts `workOn`, scripts.ts), or
//   `SWITCH_EXTENSION`, an extension's (host.ts). macOS shows a program's environment to its user,
//   though not a platform binary's (sh, sleep): those aren't what grows.
// - What launchd keeps (the core, the hosts) isn't stopped: one that grows is theirs to fix, not to
//   lose. Nor is anything without a mark: the user's own programs, their own Claude Code sessions.
// - Each machine's host looks every five seconds, and tells the core what it stopped.
import { dlopen, FFIType, ptr } from "bun:ffi"
import type { Library } from "bun:ffi"
import { totalmem } from "node:os"
import path from "node:path"
import { spaceOfWork } from "@switch/autonomy"
import { Brain, defineRead, HOME, ThreadId } from "@switch/brain"
import { Effect } from "effect"

import type { ToCore } from "./link.ts"
import { troubled } from "./trouble.ts"

/** How often it looks: a runaway grows by gigabytes a minute. */
export const EVERY_MS = 5000
/** Memory counts in binary gigabytes, as Activity Monitor's do. */
const GB = 1024 ** 3
const RUSAGE_INFO_V4 = 4
/** `ri_phys_footprint`'s place in a `struct rusage_info_v4` (sys/resource.h), in 64-bit words. */
const FOOTPRINT = 9
const RUSAGE_WORDS = 37
const CTL_KERN = 1
const KERN_PROCARGS2 = 49
/** kern.argmax: the most a process's arguments and environment hold. */
const ARGMAX = 1024 * 1024
const COMMAND_CHARS = 160

type Runaway = Extract<ToCore, { t: "runaway" }>

const symbols = {
  proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  sysctl: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
} as const

/** Every process's pid, as the kernel lists them. */
const pidsOf = (lib: Library<typeof symbols>) => {
  const count = lib.symbols.proc_listallpids(null, 0)
  if (count <= 0) {
    return []
  }
  // Room for those started since it counted.
  const pids = new Int32Array(count + 64)
  const listed = lib.symbols.proc_listallpids(ptr(pids), pids.byteLength)
  return [...pids.subarray(0, Math.max(listed, 0))]
}

/** A process's command line and environment, as the kernel keeps them. */
const argsOf = (lib: Library<typeof symbols>, buffer: Uint8Array, pid: number) => {
  const size = new BigUint64Array([BigInt(buffer.byteLength)])
  const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid])
  if (lib.symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(size), null, 0) !== 0) {
    return null
  }
  // Its argument count, the program's path, padding, the arguments, then the environment.
  const argc = new DataView(buffer.buffer).getInt32(0, true)
  const words = new TextDecoder().decode(buffer.subarray(4, Number(size[0]))).split("\0")
  let at = 1
  while (at < words.length && words[at] === "") {
    at += 1
  }
  const argv = words.slice(at, at + argc)
  const env = new Map<string, string>()
  for (const word of words.slice(at + argc)) {
    if (word === "") {
      break
    }
    const equals = word.indexOf("=")
    if (equals > 0) {
      env.set(word.slice(0, equals), word.slice(equals + 1))
    }
  }
  return { argv, env }
}

/** A command as a person reads it: its program by name, cut short. */
const short = (argv: readonly string[]) => {
  const [program = "", ...rest] = argv
  const shown = [path.basename(program), ...rest].join(" ")
  return shown.length > COMMAND_CHARS ? `${shown.slice(0, COMMAND_CHARS - 1)}…` : shown
}

/** The processes launchd runs as this user's jobs. */
const launchdJobs = () =>
  new Set(
    Bun.spawnSync(["launchctl", "list"])
      .stdout.toString()
      .split("\n")
      .slice(1)
      .map((line) => Number(line.split(/\s+/u)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )

/** How long a process has run, in seconds, from `ps`'s `[[dd-]hh:]mm:ss`. */
const ranOf = (pid: number) => {
  const etime = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)])
    .stdout.toString()
    .trim()
  const [days, clock = ""] = etime.includes("-") ? etime.split("-") : ["0", etime]
  return clock
    .split(":")
    .map(Number)
    .reduce((s, n) => s * 60 + n, Number(days) * 86_400)
}

/**
 * The looker for this machine, called every `EVERY_MS`: it stops each agent's process over half the
 * machine's memory, and answers what it stopped. Only on macOS: elsewhere the kernel stops a process
 * that outgrows the memory before its swap can fill the disk.
 */
export const runaways = (): (() => Runaway[]) => {
  if (process.platform !== "darwin") {
    return () => []
  }
  const lib = dlopen("/usr/lib/libSystem.B.dylib", symbols)
  const total = totalmem()
  const cap = total / 2
  const usage = new BigUint64Array(RUSAGE_WORDS)
  const args = new Uint8Array(ARGMAX)
  /** Its footprint in bytes, or 0 when it isn't this user's to read. */
  const footprint = (pid: number) =>
    lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(usage)) === 0
      ? Number(usage[FOOTPRINT])
      : 0
  return () => {
    const over = pidsOf(lib).filter((pid) => pid > 1 && pid !== process.pid && footprint(pid) > cap)
    if (over.length === 0) {
      return []
    }
    const kept = launchdJobs()
    const stopped: Runaway[] = []
    for (const pid of over) {
      const found = kept.has(pid) ? null : argsOf(lib, args, pid)
      const work = found?.env.get("SWITCH_WORK") ?? ""
      const extension = found?.env.get("SWITCH_EXTENSION") ?? ""
      if (found === null || (work === "" && extension === "")) {
        continue
      }
      // Measured again just before it's stopped: still this big, so still the same process.
      const bytes = footprint(pid)
      if (bytes <= cap) {
        continue
      }
      const ran = ranOf(pid)
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        continue
      }
      stopped.push({
        t: "runaway",
        pid,
        command: short(found.argv),
        bytes,
        total,
        ran,
        ...(work !== "" && { work }),
        ...(extension !== "" && { extension }),
      })
    }
    return stopped
  }
}

const gb = (bytes: number) => (bytes / GB).toFixed(1)

const took = (seconds: number) => {
  if (seconds < 120) {
    return `${seconds} s`
  }
  if (seconds < 7200) {
    return `${Math.round(seconds / 60)} min`
  }
  return `${Math.round(seconds / 3600)} h`
}

/** What a host stopped: a surprise for the work it ran for, so its next turn knows what and why. */
/** A work's space and title, when there's a work. */
const workRead = defineRead("core/runaway/work", (db, work: ThreadId | null) => ({
  space: work === null ? null : spaceOfWork(db, work),
  title:
    work === null
      ? null
      : (db
          .query<{ title: string }, [string]>("SELECT title FROM threads WHERE thread = ?")
          .get(work)?.title ?? null),
}))

export const stoppedRunaway = (machine: string, m: Runaway) =>
  Effect.gen(function* raising() {
    const brain = yield* Brain
    const work = m.work === undefined ? null : ThreadId.make(m.work)
    const { space, title } = yield* brain.read(workRead, work)
    let ranFor = `the extension ${m.extension ?? "it was started by"}`
    if (work !== null) {
      ranFor = title === null ? work : `“${title}” (${work})`
    }
    const name = m.command.split(" ")[0] ?? "A process"
    const text =
      `${name} outgrew ${machine}'s memory, stopped at ${gb(m.bytes)} GB. Stopped ${m.command} ` +
      `(pid ${m.pid}) on ${machine}: it grew to ${gb(m.bytes)} GB of memory, past the ` +
      `${gb(m.total / 2)} GB one agent's process may hold there (half the Mac's ` +
      `${gb(m.total)} GB), and macOS would have gone on swapping it out to the disk until the ` +
      `disk was full. It ran ${took(m.ran)}, for ${ranFor}. Run something that needs this much ` +
      `on less (fewer points, coarser voxels, a case at a time), or on a box rented for it, as ` +
      `fea and cfd do.`
    yield* Effect.logWarning(text)
    yield* troubled({
      id: `runaway:${machine}:${m.pid}`,
      space: space ?? HOME,
      ...(work !== null && { thread: work }),
      text,
    })
  })
