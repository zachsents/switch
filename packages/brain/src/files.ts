// The one way a machine-local file is written: whole, to a file of its own beside it, flushed, then
// moved over it (as the blob store keeps a file). A reader, or the next run after a crash, sees the
// old bytes or the new, never a torn file.
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import path from "node:path"

export interface WriteOptions {
  /** Its permissions, `0o600` for a secret. */
  readonly mode?: number
}

/** The bytes in a new file beside `file`, flushed to disk; its name. */
const stage = (file: string, data: string | Uint8Array, options: WriteOptions) => {
  mkdirSync(path.dirname(file), { recursive: true })
  const staged = `${file}.${crypto.randomUUID()}.tmp`
  const fd = openSync(staged, "wx", options.mode ?? 0o644)
  try {
    const bytes = typeof data === "string" ? Buffer.from(data) : data
    let at = 0
    while (at < bytes.byteLength) {
      at += writeSync(fd, bytes, at)
    }
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(staged, { force: true })
    throw error
  }
  closeSync(fd)
  return staged
}

/** Replaces `file` with `data`, all at once. */
export const writeFileAtomic = (
  file: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
) => {
  const staged = stage(file, data, options)
  try {
    renameSync(staged, file)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }
}

/** Makes `file` with `data`, all at once, unless it's there: false then, and it's left as it is. */
export const createFileAtomic = (
  file: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
) => {
  const staged = stage(file, data, options)
  try {
    linkSync(staged, file)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false
    }
    throw error
  } finally {
    rmSync(staged, { force: true })
  }
}
