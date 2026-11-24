// The autofill helper (autofill-source.ts), built once per source on the Mac that runs it, into
// ~/.switch/bin. It runs as this extension's child, so Accessibility is the host app's.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { source } from "./autofill-source.ts"
import { isJson } from "./chrome.ts"

const version = createHash("sha256").update(source).digest("hex").slice(0, 12)
let built: Promise<string> | null = null

const build = async () => {
  const dir = path.join(homedir(), ".switch", "bin")
  const out = path.join(dir, `autofill-${version}`)
  if (existsSync(out)) {
    return out
  }
  mkdirSync(dir, { recursive: true })
  const src = path.join(tmpdir(), `switch-autofill-${version}.swift`)
  writeFileSync(src, source)
  const proc = Bun.spawn(["swiftc", "-O", src, "-o", out], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    throw new Error(`Couldn't build the autofill helper: ${err.slice(0, 500)}`)
  }
  return out
}

const helper = async () => {
  built ??= build()
  try {
    return await built
  } catch (error) {
    built = null
    throw error
  }
}

const run = async (args: readonly string[]) => {
  const proc = Bun.spawn([await helper(), ...args], { stdout: "pipe", stderr: "ignore" })
  const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text)
  const value = isJson(parsed) ? parsed : {}
  if (code !== 0) {
    throw new Error(typeof value.error === "string" ? value.error : `autofill exited ${code}`)
  }
  return value
}

export interface Offered {
  readonly labels: readonly string[]
  readonly chose: string | null
}

/**
 * Opens the browser's suggestions for the focused field and fills the one `pick`'s words are in;
 * without `pick`, closes them again and says what they were.
 */
export const fill = async (pid: number, pick: string | null): Promise<Offered> => {
  const v = await run(["fill", JSON.stringify({ pid, ...(pick !== null && { pick }) })])
  const labels = Array.isArray(v.labels) ? v.labels.filter((l) => typeof l === "string") : []
  return { labels, chose: typeof v.chose === "string" ? v.chose : null }
}
