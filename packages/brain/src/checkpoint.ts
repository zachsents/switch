// The WAL's checkpoints, made by a process of their own (`switch checkpoint <brain>`, the core's
// checkpointer.ts) so the core's thread never writes WAL pages into the main file or waits on its
// sync. Told of each commit on stdin; checkpoints once the WAL holds FRAMES pages the main file
// lacks, SQLite's own autocheckpoint mark. PASSIVE: it never waits on, or holds up, a reader or a
// writer; what a reader still holds is checkpointed after.
import { Database } from "bun:sqlite"
import { closeSync, openSync, readSync } from "node:fs"
import { endianness } from "node:os"

/** SQLite's default `wal_autocheckpoint`. */
const FRAMES = 1000

// The WAL-index header (https://www.sqlite.org/walformat.html): mxFrame, the WAL's last valid
// frame, at byte 16 of its first copy; nBackfill, the frames already in the main file, at byte 96.
// Both in the machine's byte order.
const MX_FRAME = 16
const N_BACKFILL = 96
const HEADER = 100

/** Frames in the WAL not yet in the main file, from its index; 0 when there's none to read. */
export const behind = (brain: string) => {
  let fd: number
  try {
    fd = openSync(`${brain}-shm`, "r")
  } catch {
    return 0
  }
  try {
    const bytes = new Uint8Array(HEADER)
    if (readSync(fd, bytes, 0, HEADER, 0) < HEADER) {
      return 0
    }
    const view = new DataView(bytes.buffer)
    const little = endianness() === "LE"
    return Math.max(0, view.getUint32(MX_FRAME, little) - view.getUint32(N_BACKFILL, little))
  } finally {
    closeSync(fd)
  }
}

/** Checkpoints `brain` as `commits` says it committed, until it ends (the core is gone). */
export const checkpointing = async (brain: string, commits: AsyncIterable<unknown>) => {
  const db = new Database(brain, { readwrite: true, create: false })
  const checkpoint = db.query<{ busy: number; log: number; checkpointed: number }, []>(
    "PRAGMA wal_checkpoint(PASSIVE)",
  )
  try {
    // Each read is every commit told since the last: one look however many came.
    for await (const _ of commits) {
      if (behind(brain) >= FRAMES) {
        checkpoint.get()
      }
    }
  } finally {
    db.close()
  }
}
