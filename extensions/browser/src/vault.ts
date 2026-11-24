// This Mac's login Keychain through the `security` tool, one generic item per name under a service,
// each a JSON object; and the private files beside it that index what's kept (never a secret).
// What goes in is piped to `security -i`, so no secret is ever in a command line. Ported from
// Switchboard's keychain.rs.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { Schema } from "effect"

/** A JSON file as `schema` reads it, or `fallback` when it's missing or isn't that. */
export const readJson = <A>(file: string, schema: Schema.Codec<A>, fallback: A): A => {
  if (!existsSync(file)) {
    return fallback
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"))
    return Schema.decodeUnknownSync(schema)(parsed)
  } catch {
    return fallback
  }
}

/** Writes a file only its owner reads, whole or not at all. */
export const writePrivate = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  const partial = `${file}.partial`
  writeFileSync(partial, text, { mode: 0o600 })
  chmodSync(partial, 0o600)
  renameSync(partial, file)
}

const run = async (args: readonly string[], stdin: string | null = null) => {
  const proc = Bun.spawn(["security", ...args], {
    stdin: stdin === null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== null && proc.stdin) {
    await proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err }
}

const hex = (text: string) => Buffer.from(text, "utf-8").toString("hex")

/** One item's JSON object. */
export const keychainRead = async (service: string, name: string): Promise<unknown> => {
  const { code, out, err } = await run(["find-generic-password", "-s", service, "-a", name, "-w"])
  if (code !== 0) {
    throw new Error(`${name} has no item in this Mac's Keychain (${err.trim().slice(0, 120)})`)
  }
  const printed = out.trim()
  // `security` prints data that isn't plain text as hex.
  const text = printed.startsWith("{") ? printed : Buffer.from(printed, "hex").toString("utf-8")
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new Error(`${name}'s Keychain item isn't JSON`)
  }
}

/** Keeps an item (replacing one by the name), and checks it reads back as written. */
export const keychainWrite = async (service: string, name: string, value: unknown) => {
  const data = JSON.stringify(value)
  const line = `add-generic-password -U -s "${service}" -a "${name}" -l "${service}: ${name}" -X ${hex(data)}\n`
  const { code, err } = await run(["-i"], line)
  if (code !== 0 || err.includes("error")) {
    throw new Error(`The Keychain wouldn't keep ${name}'s item: ${err.trim().slice(0, 160)}`)
  }
  if (JSON.stringify(await keychainRead(service, name)) !== data) {
    throw new Error(`The Keychain didn't keep ${name}'s item as written`)
  }
}

export const keychainDelete = async (service: string, name: string) => {
  const { code, err } = await run(["delete-generic-password", "-s", service, "-a", name])
  if (code !== 0 && !err.includes("could not be found")) {
    throw new Error(`The Keychain wouldn't delete ${name}'s item: ${err.trim().slice(0, 160)}`)
  }
}
