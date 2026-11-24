// This Mac's login Keychain through the `security` tool: one generic item per account under a
// service, each a JSON object. What goes in is piped to `security -i`, so no secret is ever in a
// command line. With $SWITCH_SECRETS_KEYFILE set (a test vault), a file only its owner reads
// stands in for it. Ported from switch-ext-browser's vault.ts.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Writes a file only its owner reads, whole or not at all. */
export const writePrivate = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
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

const keyFile = () => process.env.SWITCH_SECRETS_KEYFILE

const fileItems = (file: string): Record<string, unknown> => {
  if (!existsSync(file)) {
    return {}
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"))
  return typeof parsed === "object" && parsed !== null ? { ...parsed } : {}
}

/** One item's JSON object, or null if there's none. */
export const keychainRead = async (service: string, account: string): Promise<unknown> => {
  const file = keyFile()
  if (file !== undefined) {
    return fileItems(file)[`${service}/${account}`] ?? null
  }
  const { code, out, err } = await run([
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ])
  // 44 is "not found"; anything else (a locked Keychain, no one to answer it) isn't an answer.
  if (code === 44) {
    return null
  }
  if (code !== 0) {
    throw new Error(`This Mac's Keychain can't be read here: ${err.trim().slice(0, 160)}`)
  }
  const printed = out.trim()
  // `security` prints data that isn't plain text as hex.
  const text = printed.startsWith("{") ? printed : Buffer.from(printed, "hex").toString("utf-8")
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw new Error(`${service}'s Keychain item ${account} isn't JSON`)
  }
}

/** Keeps an item (replacing one by the account unless `fresh`), and checks it reads back as written. */
export const keychainWrite = async (
  service: string,
  account: string,
  value: unknown,
  fresh = false,
) => {
  const data = JSON.stringify(value)
  const file = keyFile()
  if (file !== undefined) {
    writePrivate(file, JSON.stringify({ ...fileItems(file), [`${service}/${account}`]: value }))
    return
  }
  const line = `add-generic-password ${fresh ? "" : "-U "}-s "${service}" -a "${account}" -l "${service}" -X ${hex(data)}\n`
  const { code, err } = await run(["-i"], line)
  if (code !== 0 || err.includes("error")) {
    throw new Error(`The Keychain wouldn't keep ${account}: ${err.trim().slice(0, 160)}`)
  }
  if (JSON.stringify(await keychainRead(service, account)) !== data) {
    throw new Error(`The Keychain didn't keep ${account} as written`)
  }
}

export const keychainDelete = async (service: string, account: string) => {
  const file = keyFile()
  if (file !== undefined) {
    const { [`${service}/${account}`]: _, ...rest } = fileItems(file)
    writePrivate(file, JSON.stringify(rest))
    return
  }
  const { code, err } = await run(["delete-generic-password", "-s", service, "-a", account])
  if (code !== 0 && !err.includes("could not be found")) {
    throw new Error(`The Keychain wouldn't delete ${account}: ${err.trim().slice(0, 160)}`)
  }
}
