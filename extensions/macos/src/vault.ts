// The user's vault (the secrets extension), from which ui's set and type take a secret by reference
// (card/main.number) and put it straight into an app: this Mac's copy has one key pair (its secret
// half in the Keychain), allowed once by the user, and the vault seals each secret to it for one
// use. What went in is remembered only as its length and hash, so it's masked wherever an app
// shows it back (`masked`). Ported from the browser extension's keeper.ts.
import { createHash } from "node:crypto"

import { openSealed, sealedKey } from "switch-ext-kit"

const core = () => process.env.SWITCH_URL ?? "http://127.0.0.1:4871"

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** One of the vault's tools: its structured result, or its words as an error. */
const call = async (tool: string, args: Json): Promise<Json> => {
  let r: Response
  try {
    r = await fetch(`${core()}/widgets/secrets/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.SWITCH_TOKEN !== undefined && {
          authorization: `Bearer ${process.env.SWITCH_TOKEN}`,
        }),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error("Can't reach the core for the vault")
  }
  const body: unknown = await r.json().catch(() => null)
  const result = isJson(body) ? body : {}
  const content = Array.isArray(result.content) ? result.content : []
  const first: unknown = content[0]
  const text = isJson(first) && typeof first.text === "string" ? first.text : ""
  if (result.isError === true) {
    throw new TypeError(text === "" ? `The vault's ${tool} failed` : text)
  }
  if (isJson(result.structuredContent)) {
    return result.structuredContent
  }
  throw new Error(`The vault's ${tool} said nothing`)
}

const security = async (args: readonly string[], stdin: string | null = null) => {
  const proc = Bun.spawn(["security", ...args], {
    stdin: stdin === null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== null && proc.stdin) {
    await proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  return { code, out }
}

const SERVICE = "Switch macOS"
const ACCOUNT = "secrets-key"

/** This Mac's key pair for the vault, made and kept in the Keychain the first time. */
const ownKey = async () => {
  const { code, out } = await security([
    "find-generic-password",
    "-s",
    SERVICE,
    "-a",
    ACCOUNT,
    "-w",
  ])
  if (code === 0) {
    const printed = out.trim()
    // `security` prints data that isn't plain text as hex.
    const text = printed.startsWith("{") ? printed : Buffer.from(printed, "hex").toString("utf-8")
    const kept: unknown = JSON.parse(text)
    if (isJson(kept) && typeof kept.key === "string" && typeof kept.secretKey === "string") {
      return { key: kept.key, secretKey: kept.secretKey }
    }
  }
  const made = await sealedKey()
  const hex = Buffer.from(JSON.stringify(made), "utf-8").toString("hex")
  // Piped to `security -i`, so the key is never in a command line.
  const added = await security(
    ["-i"],
    `add-generic-password -U -s "${SERVICE}" -a "${ACCOUNT}" -l "${SERVICE}: ${ACCOUNT}" -X ${hex}\n`,
  )
  if (added.code !== 0) {
    throw new Error("The Keychain wouldn't keep this Mac's vault key")
  }
  return made
}

/** What the user knows this extension as on this Mac: "the Mac extension on <its name>". */
const label = async () => {
  const proc = Bun.spawn(["scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" })
  const said = await new Response(proc.stdout).text()
  const computer = said.trim()
  return computer === "" ? "the Mac extension" : `the Mac extension on ${computer}`
}

let mine: ReturnType<typeof ownKey> | null = null

/** This Mac's key, allowed by the vault under `name`. */
const allowed = async (name: string) => {
  mine ??= ownKey()
  const own = await mine.catch((error: unknown) => {
    mine = null
    throw error
  })
  const r = await call("extension_register", {
    extension: name,
    key: own.key,
    label: await label(),
  })
  if (r.status !== "active") {
    throw new Error(
      `The vault hasn't allowed ${name} yet: the user approves it (code ${String(r.code)}) in the Secrets app or the queue`,
    )
  }
  return own
}

/** Says this Mac is here, so the user can allow it before it's needed. */
export const register = async (name: string) => {
  await allowed(name).catch(() => null)
}

/** What went in, as its length and hash: never the secret. */
const sealed: { length: number; hash: string }[] = []
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * The secret a reference names (an item's name, or name.field), released by the vault for one use
 * (`why`: where it goes), and remembered for masking.
 */
export const release = async (name: string, ref: string, why: string) => {
  const own = await allowed(name)
  const r = await call("release", { extension: name, ref, use: "fill", why })
  const opened = await openSealed(
    own.secretKey,
    `release:${String(r.id)}`,
    `${name}:${String(r.item)}`,
    {
      enc: String(r.enc),
      ct: String(r.ct),
    },
  )
  const parsed: unknown = JSON.parse(opened)
  const [value] = isJson(parsed) ? Object.values(parsed).map(String) : []
  if (value === undefined || value === "") {
    throw new Error(`The vault gave nothing for ${ref}`)
  }
  const entry = { length: value.length, hash: hashOf(value) }
  if (value.length >= 3 && !sealed.some((s) => s.hash === entry.hash)) {
    sealed.push(entry)
  }
  return { value, title: String(r.title) }
}

/** `text` with every secret that went in masked, wherever an app shows it back. */
export const masked = (text: string) => {
  let out = text
  for (const { length, hash } of sealed) {
    for (let i = 0; i + length <= out.length; i += 1) {
      if (hashOf(out.slice(i, i + length)) === hash) {
        out = `${out.slice(0, i)}[secret]${out.slice(i + length)}`
        i += "[secret]".length - 1
      }
    }
  }
  return out
}
