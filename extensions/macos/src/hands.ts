// The Swift helper (hands-source.ts), built once per source on the Mac that runs it, into
// ~/.switch/bin. $SWITCH_HANDS names a prebuilt one (the signed host app's).
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { source } from "./hands-source.ts"
import { masked } from "./vault.ts"

const version = createHash("sha256").update(source).digest("hex").slice(0, 12)
let built: Promise<string> | null = null

const build = async () => {
  const fixed = process.env.SWITCH_HANDS
  if (fixed !== undefined && fixed !== "") {
    return fixed
  }
  const dir = path.join(homedir(), ".switch", "bin")
  const out = path.join(dir, `hands-${version}`)
  if (existsSync(out)) {
    return out
  }
  mkdirSync(dir, { recursive: true })
  const src = path.join(tmpdir(), `switch-hands-${version}.swift`)
  writeFileSync(src, source)
  const proc = Bun.spawn(["swiftc", "-O", src, "-o", out], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    throw new Error(`Couldn't build the hands helper: ${err.slice(0, 500)}`)
  }
  return out
}

export const helper = async () => {
  built ??= build()
  try {
    return await built
  } catch (error) {
    built = null
    throw error
  }
}

const parse: (json: string) => unknown = JSON.parse

/**
 * Runs one op; fails with its error. `secrets` (reference → value, from the vault) go in on its
 * standard input, never its command line, and every secret that went in is masked in what it says.
 */
export const hands = async (
  op: string,
  args: Record<string, unknown> = {},
  secrets: Record<string, string> | null = null,
): Promise<unknown> => {
  const bin = await helper()
  const argv = [bin, op, JSON.stringify(secrets === null ? args : { ...args, secrets: true })]
  const proc = Bun.spawn(argv, {
    stdin: secrets === null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (secrets !== null && proc.stdin) {
    await proc.stdin.write(JSON.stringify(secrets))
    await proc.stdin.end()
  }
  const [code, raw] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  const out = masked(raw)
  const value = out.trim() === "" ? null : parse(out)
  if (code !== 0) {
    const said =
      typeof value === "object" && value !== null && "error" in value ? String(value.error) : ""
    throw new Error(said === "" ? `hands ${op} exited ${code}` : said)
  }
  return value
}

/** Each of a process's windows: its CoreGraphics id, name and size. */
export const windowsOf = async (pid: number) => {
  const list = await hands("windows", { pid })
  return Array.isArray(list)
    ? list.flatMap((w: unknown) =>
        typeof w === "object" && w !== null && "id" in w && typeof w.id === "number"
          ? [{ id: w.id, name: "name" in w ? String(w.name) : "" }]
          : [],
      )
    : []
}

/** A JPEG of the screen (`display`, 1 the main one) or of one window, at most `width` wide. */
export const capture = async (target: { display?: number; window?: number }, width = 1600) => {
  const file = path.join(tmpdir(), `switch-shot-${crypto.randomUUID()}.jpg`)
  const args = ["-x", "-t", "jpg"]
  if (target.window === undefined) {
    args.push("-D", String(target.display ?? 1))
  } else {
    args.push("-o", "-l", String(target.window))
  }
  const shot = Bun.spawn(["screencapture", ...args, file], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([shot.exited, new Response(shot.stderr).text()])
  if (code !== 0 || !existsSync(file)) {
    throw new Error(err.trim() === "" ? "No Screen Recording permission" : err.trim())
  }
  // A window is its own size; a display is scaled down to `width`.
  if (target.window === undefined) {
    await Bun.spawn(["sips", "-Z", String(width), file], { stdout: "ignore", stderr: "ignore" })
      .exited
  }
  const f = Bun.file(file)
  const data = Buffer.from(await f.arrayBuffer()).toString("base64")
  await f.delete()
  return data
}
