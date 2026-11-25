// The brain's WAL checkpoints, off the core's thread: a child (`switch checkpoint <brain>`, the
// brain's checkpoint.ts) told of each commit through its stdin, which ends with the core. A
// checkpoint writes the WAL's pages into the main file and syncs it; in the commit that filled the
// WAL, as SQLite does by itself, that held the core's thread 3 to 18 s on the Mac mini's busy disk
// (Nov 24: sqlite3WalDefaultHook under sqlite3_step in its samples).
import type { FileSink, Subprocess } from "bun"
import { yielding } from "@switch/agent"

/** This build run again: the compiled `switch`, else bun on its main.ts. */
const self = Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]

/** A child that stopped isn't started again sooner than this after the last start. */
const AGAIN_MS = 10_000

/**
 * A line for a commit: the child reads however many came as one. One that stopped meanwhile drops
 * it, and the next commit starts it again, saying why; `alive` says whether it's still running.
 */
const tell = async (stdin: FileSink, alive: () => boolean) => {
  try {
    await stdin.write("\n")
    await stdin.flush()
  } catch (error) {
    if (alive()) {
      console.warn(`checkpointer not told of a commit: ${String(error)}`)
    }
  }
}

/** What the brain calls after each commit (BrainConfig's `checkpoint`). */
export const checkpointer = (brain: string) => {
  let child: Subprocess<"pipe", "ignore", "inherit"> | null = null
  let started = 0
  const running = () => child !== null && child.exitCode === null && child.signalCode === null
  return () => {
    if (!running()) {
      const now = Date.now()
      if (child !== null) {
        if (now - started < AGAIN_MS) {
          return
        }
        console.warn(
          `checkpointer stopped (${child.signalCode ?? child.exitCode}); starting it again`,
        )
      }
      started = now
      child = Bun.spawn(yielding([...self, "checkpoint", brain]), {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "inherit",
      })
    }
    if (child !== null) {
      void tell(child.stdin, running)
    }
  }
}
