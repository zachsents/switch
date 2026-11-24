// A Wallet pass: pass.json, its images and a manifest of their SHA-1s, signed (PKCS #7, detached)
// with the Pass Type ID's certificate, zipped. The format follows Switchboard's wallet appendage.
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"

import type { WalletFiles } from "./keys.ts"

export const KINDS = ["generic", "eventTicket", "boardingPass", "coupon", "storeCard"] as const
export type Kind = (typeof KINDS)[number]

const TRANSIT: Record<string, string> = {
  air: "PKTransitTypeAir",
  boat: "PKTransitTypeBoat",
  bus: "PKTransitTypeBus",
  train: "PKTransitTypeTrain",
  generic: "PKTransitTypeGeneric",
}

const FORMATS: Record<string, string> = {
  qr: "PKBarcodeFormatQR",
  aztec: "PKBarcodeFormatAztec",
  pdf417: "PKBarcodeFormatPDF417",
  code128: "PKBarcodeFormatCode128",
}

export interface Field {
  readonly label: string
  readonly value: string
}

export interface PassInput {
  readonly kind: Kind
  readonly title: string
  readonly organization?: string
  readonly serial?: string
  readonly transit?: string
  readonly primary?: readonly Field[]
  readonly secondary?: readonly Field[]
  readonly auxiliary?: readonly Field[]
  readonly back?: readonly Field[]
  readonly barcode?: {
    readonly message: string
    readonly format?: string
    /** How Wallet turns the message into the code's bytes: iso-8859-1 (the default) or utf-8. */
    readonly encoding?: string
    /** Words under the code, like the ticket number. */
    readonly altText?: string
  }
  /** ISO 8601, with its offset. */
  readonly relevantDate?: string
  readonly locations?: readonly { readonly latitude: number; readonly longitude: number }[]
}

export const run = (args: readonly string[], cwd?: string) => {
  const done = Bun.spawnSync([...args], { cwd: cwd ?? process.cwd(), stderr: "pipe" })
  if (!done.success) {
    throw new Error(`${args[0] ?? ""} failed: ${done.stderr.toString().trim().slice(0, 300)}`)
  }
  return done.stdout
}

/** The certificate's Pass Type ID and team, from its subject (UID=pass.…, OU=team). */
export const identity = (files: WalletFiles) => {
  const subject = run([
    "openssl",
    "x509",
    "-in",
    files.cert,
    "-noout",
    "-subject",
    "-nameopt",
    "RFC2253",
  ]).toString()
  const uid = /UID=(?<uid>[^,\n]+)/u.exec(subject)?.groups?.uid
  const team = /OU=(?<team>[^,\n]+)/u.exec(subject)?.groups?.team
  if (uid === undefined || team === undefined) {
    throw new Error("The pass certificate names no Pass Type ID or team")
  }
  return { passType: uid.trim(), team: team.trim() }
}

/** A PNG chunk's checksum: CRC-32 of its type and data. */
const crc32 = (data: Uint8Array) => Bun.hash.crc32(data)

const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A square PNG of one color: the pass's icon, since Wallet needs one. */
const square = (size: number, rgb: readonly [number, number, number]) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + size * 3)
  const [red, green, blue] = rgb
  for (let x = 0; x < size; x += 1) {
    row.writeUInt8(red, 1 + x * 3)
    row.writeUInt8(green, 2 + x * 3)
    row.writeUInt8(blue, 3 + x * 3)
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ])
}

const fields = (list: readonly Field[] | undefined, where: string) =>
  (list ?? []).map((f, i) => ({ key: `${where}${i}`, label: f.label, value: f.value }))

export const describe = (input: PassInput, passType: string, team: string) => {
  const serial =
    input.serial ?? createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24)
  const style: Record<string, unknown> = {
    primaryFields: fields(input.primary, "p"),
    secondaryFields: fields(input.secondary, "s"),
    auxiliaryFields: fields(input.auxiliary, "a"),
    backFields: fields(input.back, "b"),
  }
  if (input.kind === "boardingPass") {
    style.transitType = TRANSIT[input.transit ?? "generic"] ?? TRANSIT.generic
  }
  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: passType,
    teamIdentifier: team,
    serialNumber: serial,
    organizationName: input.organization ?? input.title,
    description: input.title,
    logoText: input.title,
    backgroundColor: "rgb(10, 10, 10)",
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(163, 163, 163)",
    [input.kind]: style,
  }
  if (input.barcode !== undefined) {
    const format = FORMATS[(input.barcode.format ?? "qr").toLowerCase()]
    if (format === undefined) {
      throw new Error(`barcode.format is one of ${Object.keys(FORMATS).join(", ")}`)
    }
    pass.barcodes = [
      {
        format,
        message: input.barcode.message,
        messageEncoding: input.barcode.encoding ?? "iso-8859-1",
        ...(input.barcode.altText === undefined ? {} : { altText: input.barcode.altText }),
      },
    ]
  }
  if (input.relevantDate !== undefined) {
    pass.relevantDate = input.relevantDate
  }
  if (input.locations !== undefined && input.locations.length > 0) {
    pass.locations = input.locations.slice(0, 10)
  }
  return { serial, pass }
}

/** Builds and signs a pass; returns its serial and the .pkpass's bytes. */
export const makePass = (files: WalletFiles, input: PassInput) => {
  const { passType, team } = identity(files)
  const { serial, pass } = describe(input, passType, team)
  const work = mkdtempSync(path.join(tmpdir(), "switch-pass-"))
  try {
    const content: Record<string, Uint8Array> = {
      "pass.json": Buffer.from(JSON.stringify(pass)),
      "icon.png": square(29, [10, 10, 10]),
      "icon@2x.png": square(58, [10, 10, 10]),
      "icon@3x.png": square(87, [10, 10, 10]),
    }
    const manifest = Object.fromEntries(
      Object.entries(content).map(([name, bytes]) => [
        name,
        createHash("sha1").update(bytes).digest("hex"),
      ]),
    )
    for (const [name, bytes] of Object.entries(content)) {
      writeFileSync(path.join(work, name), bytes)
    }
    writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest))
    run([
      "openssl",
      "smime",
      "-binary",
      "-sign",
      "-certfile",
      files.wwdr,
      "-signer",
      files.cert,
      "-inkey",
      files.key,
      "-in",
      path.join(work, "manifest.json"),
      "-out",
      path.join(work, "signature"),
      "-outform",
      "DER",
      "-md",
      "sha256",
    ])
    run(
      ["zip", "-q", "-X", "pass.pkpass", ...Object.keys(content), "manifest.json", "signature"],
      work,
    )
    return { serial, bytes: readFileSync(path.join(work, "pass.pkpass")) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
