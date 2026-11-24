// Barcodes off a ticket, boarding pass, bib or flyer: an image or PDF (a path on this Mac, a URL or
// a data: URL) read by Vision through a small Swift helper, or a Wallet pass's own codes. Each code
// comes with `wallet`, the barcode a Wallet pass takes as it is, when Wallet can draw its kind.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import { source as swiftSource } from "./barcodes-source.ts"

const version = createHash("sha256").update(swiftSource).digest("hex").slice(0, 12)
const MAX_BYTES = 40 * 1024 * 1024
let built: Promise<string> | null = null

const build = async () => {
  const dir = path.join(homedir(), ".switch", "bin")
  const out = path.join(dir, `barcodes-${version}`)
  if (existsSync(out)) {
    return out
  }
  mkdirSync(dir, { recursive: true })
  const src = path.join(tmpdir(), `switch-barcodes-${version}.swift`)
  writeFileSync(src, swiftSource)
  const proc = Bun.spawn(["swiftc", "-O", src, "-o", out], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    throw new Error(`Couldn't build the barcode reader: ${err.slice(0, 500)}`)
  }
  return out
}

const reader = async () => {
  built ??= build()
  try {
    return await built
  } catch (error) {
    built = null
    throw error
  }
}

const Found = Schema.Struct({
  codes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        symbology: Schema.String,
        text: Schema.optionalKey(Schema.String),
        page: Schema.optionalKey(Schema.Finite),
        box: Schema.Array(Schema.Finite),
      }),
    ),
  ),
  pages: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String),
})
const decodeFound = Schema.decodeUnknownSync(Schema.fromJsonString(Found))

/** Vision's symbology names, short: VNBarcodeSymbologyPDF417 → pdf417. */
const SHORT: Record<string, string> = {
  QR: "qr",
  MicroQR: "microqr",
  Aztec: "aztec",
  PDF417: "pdf417",
  MicroPDF417: "micropdf417",
  Code128: "code128",
  DataMatrix: "datamatrix",
  EAN13: "ean13",
  EAN8: "ean8",
  UPCE: "upce",
  Code39: "code39",
  Code93: "code93",
  ITF14: "itf",
  I2of5: "itf",
  Codabar: "codabar",
  GS1DataBar: "databar",
}

/** The kinds Wallet draws, by short name. */
const WALLET: Record<string, string> = {
  qr: "qr",
  microqr: "qr",
  aztec: "aztec",
  pdf417: "pdf417",
  micropdf417: "pdf417",
  code128: "code128",
}

const PASS_FORMATS: Record<string, string> = {
  PKBarcodeFormatQR: "qr",
  PKBarcodeFormatAztec: "aztec",
  PKBarcodeFormatPDF417: "pdf417",
  PKBarcodeFormatCode128: "code128",
}

export interface Code {
  readonly format: string
  readonly text: string
  readonly where: string
  readonly box?: readonly number[]
  readonly wallet?: { readonly format: string; readonly message: string; readonly encoding: string }
}

const forWallet = (format: string, text: string) => {
  const kind = WALLET[format]
  if (kind === undefined) {
    return {}
  }
  const latin = Buffer.from(text, "latin1").toString("latin1") === text
  return { wallet: { format: kind, message: text, encoding: latin ? "iso-8859-1" : "utf-8" } }
}

const fetched = async (source: string) => {
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",")
    const body = source.slice(comma + 1)
    return source.slice(0, comma).endsWith(";base64")
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body))
  }
  const res = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    throw new Error(`${new URL(source).host} answered ${res.status}`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) {
    throw new Error(`Over ${MAX_BYTES / 1024 / 1024} MB`)
  }
  return bytes
}

const run = (args: readonly string[]) => {
  const done = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: done.success, out: done.stdout.toString() }
}

const PassJson = Schema.fromJsonString(
  Schema.Struct({
    organizationName: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    barcodes: Schema.optionalKey(
      Schema.Array(Schema.Struct({ format: Schema.String, message: Schema.String })),
    ),
    barcode: Schema.optionalKey(Schema.Struct({ format: Schema.String, message: Schema.String })),
  }),
)
const decodePass = Schema.decodeUnknownSync(PassJson)

/** A Wallet pass's codes as its issuer wrote them, and each pass's of a .pkpasses. */
const passCodes = (file: string, where: string): Code[] => {
  const listed = run(["unzip", "-Z1", file])
  if (!listed.ok) {
    throw new Error("Not an image, PDF or Wallet pass")
  }
  const names = listed.out.split("\n").filter((n) => n !== "")
  if (!names.includes("pass.json")) {
    const inner = names.filter((n) => n.toLowerCase().endsWith(".pkpass"))
    if (inner.length === 0) {
      throw new Error("A zip with no pass.json")
    }
    const dir = mkdtempSync(path.join(tmpdir(), "switch-passes-"))
    try {
      return inner.flatMap((name, i) => {
        const at = path.join(dir, `${i}.pkpass`)
        writeFileSync(at, Bun.spawnSync(["unzip", "-p", file, name]).stdout)
        return passCodes(at, `pass ${i + 1}`)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const pass = decodePass(run(["unzip", "-p", file, "pass.json"]).out)
  const list = pass.barcodes ?? (pass.barcode === undefined ? [] : [pass.barcode])
  return list.map((b) => {
    const format = PASS_FORMATS[b.format] ?? b.format.replace(/^PKBarcodeFormat/u, "").toLowerCase()
    return { format, text: b.message, where, ...forWallet(format, b.message) }
  })
}

/** Every barcode in `source`: a path on this Mac, an http(s) URL or a data: URL. */
export const decode = async (source: string) => {
  const remote = /^(?:https?:|data:)/u.test(source)
  const dir = mkdtempSync(path.join(tmpdir(), "switch-barcodes-"))
  try {
    let file = source.startsWith("~") ? path.join(homedir(), source.slice(1)) : source
    if (remote) {
      file = path.join(dir, "in")
      writeFileSync(file, await fetched(source))
    }
    if (!existsSync(file)) {
      throw new Error(`No file at ${file}`)
    }
    const head = readFileSync(file).subarray(0, 4).toString("latin1")
    if (head === "PK\u0003\u0004") {
      return { codes: passCodes(file, "the pass") }
    }
    const proc = Bun.spawn([await reader(), file], { stdout: "pipe", stderr: "ignore" })
    const [, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    const found = decodeFound(out)
    if (found.error !== undefined || found.codes === undefined) {
      throw new Error(found.error ?? "The reader said nothing")
    }
    const seen = new Set<string>()
    const codes = found.codes.flatMap((c): Code[] => {
      const name = c.symbology.replace(/^VNBarcodeSymbology/u, "")
      const format = SHORT[name] ?? name.toLowerCase()
      const key = `${format}:${c.text ?? ""}`
      if (c.text === undefined || seen.has(key)) {
        return []
      }
      seen.add(key)
      const where = c.page === undefined ? "the image" : `page ${c.page}`
      return [{ format, text: c.text, where, box: c.box, ...forWallet(format, c.text) }]
    })
    return { codes, ...(found.pages === undefined ? {} : { pages: found.pages }) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
