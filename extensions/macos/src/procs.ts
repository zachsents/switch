// Execs under way on this Mac, which `cancel` stops with everything they started.
const STOP_GRACE_MS = 10_000

const kill = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Gone.
    }
  }
}

interface Running {
  readonly id: string
  readonly command: string
  readonly pid: number
  readonly at: number
}

const execs = new Map<string, Running>()

export const began = (id: string, command: string, pid: number) => {
  execs.set(id, { id, command, pid, at: Date.now() })
}

export const ended = (id: string) => {
  execs.delete(id)
}

/** Stops an exec under way, with everything it started; or lists them. */
export const cancel = (id: string | undefined) => {
  if (id === undefined) {
    return {
      running: [...execs.values()].map((e) => ({
        id: e.id,
        command: e.command.slice(0, 200),
        forS: Math.round((Date.now() - e.at) / 1000),
      })),
    }
  }
  const e = execs.get(id)
  if (e === undefined) {
    throw new Error(`No exec ${id} running`)
  }
  kill(e.pid, "SIGTERM")
  setTimeout(() => {
    kill(e.pid, "SIGKILL")
  }, STOP_GRACE_MS)
  return { cancelled: id }
}
