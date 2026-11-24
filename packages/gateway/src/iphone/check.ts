// Checking passes as iOS does (every file's hash in the manifest, the signature through Apple's WWDR
// intermediate to Apple's root, the signer's Pass Type ID the pass's own), bundling several into one
// .pkpasses, and opening a pass link as a stranger would. Ported from Switchboard's wallet appendage.
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import { APPLE_ROOT, WWDR_G4 } from "./apple-certs.ts"
import type { WalletFiles } from "./keys.ts"
import { KINDS, run } from "./wallet.ts"

export const MIME = "application/vnd.apple.pkpass"
export const MIME_MANY = "application/vnd.apple.pkpasses"
const MAX_BYTES = 20 * 1024 * 1024
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1"

const withDir = <A>(f: (dir: string) => A) => {
  const dir = mkdtempSync(path.join(tmpdir(), "switch-check-"))
  try {
    return f(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A zip's files by name, or null when it isn't one. */
const unzip = (bytes: Uint8Array) =>
  withDir((dir) => {
    const file = path.join(dir, "in.zip")
    writeFileSync(file, bytes)
    const listed = Bun.spawnSync(["unzip", "-Z1", file], { stderr: "pipe" })
    if (!listed.success) {
      return null
    }
    const names = listed.stdout
      .toString()
      .split("\n")
      .filter((n) => n !== "" && !n.endsWith("/"))
    return new Map(
      names.map((name) => [name, Bun.spawnSync(["unzip", "-p", file, name]).stdout] as const),
    )
  })

/** "pass", "bundle" (a .pkpasses) or null, from what the zip holds. */
export const zipKind = (files: ReadonlyMap<string, Uint8Array> | null) => {
  if (files === null) {
    return null
  }
  const names = [...files.keys()]
  if (["pass.json", "manifest.json", "signature"].every((n) => files.has(n))) {
    return "pass"
  }
  return names.length > 0 && names.every((n) => n.toLowerCase().endsWith(".pkpass"))
    ? "bundle"
    : null
}

const Pass = Schema.Record(Schema.String, Schema.Unknown)
const decodePass = Schema.decodeUnknownSync(Schema.fromJsonString(Pass))
const Manifest = Schema.Record(Schema.String, Schema.String)
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

/** A .pkpass checked as iOS does: its pass.json, or an error saying what's wrong. */
export const verify = (bytes: Uint8Array) => {
  const files = unzip(bytes)
  if (files === null) {
    throw new Error("It isn't a zip")
  }
  for (const need of ["pass.json", "manifest.json", "signature"]) {
    if (!files.has(need)) {
      throw new Error(`It has no ${need}`)
    }
  }
  const manifest = files.get("manifest.json") ?? new Uint8Array()
  const listed = decodeManifest(Buffer.from(manifest).toString("utf-8"))
  for (const [name, data] of files) {
    if (name === "manifest.json" || name === "signature") {
      continue
    }
    if (listed[name] !== createHash("sha1").update(data).digest("hex")) {
      throw new Error(`${name}'s hash doesn't match the manifest`)
    }
  }
  for (const name of Object.keys(listed)) {
    if (!files.has(name)) {
      throw new Error(`The manifest lists ${name}, which isn't there`)
    }
  }
  if (!["icon.png", "icon@2x.png", "icon@3x.png"].some((n) => files.has(n))) {
    throw new Error("It has no icon, which Wallet requires")
  }
  const signer = withDir((dir) => {
    const at = (name: string, data: Uint8Array | string) => {
      const file = path.join(dir, name)
      writeFileSync(file, data)
      return file
    }
    const signature = at("signature", files.get("signature") ?? new Uint8Array())
    const content = at("manifest.json", manifest)
    const root = at("root.pem", APPLE_ROOT)
    const wwdr = at("wwdr.pem", WWDR_G4)
    const done = Bun.spawnSync(
      [
        "openssl",
        "smime",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        signature,
        "-content",
        content,
        "-CAfile",
        root,
        "-certfile",
        wwdr,
        "-purpose",
        "any",
        "-out",
        "/dev/null",
      ],
      { stderr: "pipe" },
    )
    if (!done.success) {
      throw new Error(
        `Its signature doesn't chain to Apple's root: ${done.stderr.toString().trim().slice(0, 200)}`,
      )
    }
    return run([
      "openssl",
      "pkcs7",
      "-inform",
      "DER",
      "-in",
      signature,
      "-print_certs",
      "-noout",
    ]).toString()
  })
  const pass = decodePass(Buffer.from(files.get("pass.json") ?? new Uint8Array()).toString("utf-8"))
  const uid = /UID\s*=\s*(?<uid>[^,\n/]+)/u.exec(signer)?.groups?.uid?.trim()
  if (uid !== pass.passTypeIdentifier) {
    throw new Error("It isn't signed by its own Pass Type ID's certificate")
  }
  for (const key of [
    "formatVersion",
    "passTypeIdentifier",
    "teamIdentifier",
    "serialNumber",
    "organizationName",
    "description",
  ]) {
    if (!(key in pass)) {
      throw new Error(`pass.json has no ${key}`)
    }
  }
  return pass
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined)

/** An ISO 8601 moment, or null when it isn't one. */
const parse = (s: string) => {
  try {
    return Temporal.Instant.from(s)
  } catch {
    return null
  }
}

/** Why a pass's date would trouble Wallet, if it does. */
const dateTrouble = (
  value: unknown,
  now: Temporal.Instant,
  bad: string,
  past: (s: string) => string,
) => {
  const s = str(value)
  if (s === undefined) {
    return []
  }
  const at = parse(s)
  if (at === null) {
    return [bad]
  }
  return Temporal.Instant.compare(at, now) < 0 ? [past(s)] : []
}

const Code = Schema.Struct({ format: Schema.String, message: Schema.String })
const decodeCodes = Schema.decodeUnknownOption(Schema.Array(Code))

/** What a pass is, with its barcode only as its kind and length, and what would trouble Wallet. */
export const summary = (pass: Record<string, unknown>, now = Temporal.Now.instant()) => {
  const title = str(pass.logoText) ?? str(pass.description) ?? ""
  const codes = decodeCodes(pass.barcodes ?? (pass.barcode === undefined ? [] : [pass.barcode]))
  const code = codes._tag === "Some" ? codes.value[0] : undefined
  const warnings: string[] = []
  if (pass.voided === true) {
    warnings.push(`${title} is voided`)
  }
  warnings.push(
    ...dateTrouble(
      pass.expirationDate,
      now,
      `${title}'s expirationDate isn't ISO 8601 with an offset`,
      (d) => `${title} expired ${d}`,
    ),
    ...dateTrouble(
      pass.relevantDate,
      now,
      `${title}'s relevantDate isn't ISO 8601 with an offset`,
      (d) => `${title} was for ${d}, which has passed`,
    ),
  )
  return {
    pass: {
      title,
      organization: str(pass.organizationName),
      kind: KINDS.find((k) => k in pass),
      serial: str(pass.serialNumber),
      passType: str(pass.passTypeIdentifier),
      ...(code === undefined
        ? {}
        : {
            barcode: `${code.format.replace(/^PKBarcodeFormat/u, "")}, ${code.message.length} characters`,
          }),
      ...(str(pass.relevantDate) === undefined ? {} : { relevantDate: str(pass.relevantDate) }),
      ...(str(pass.expirationDate) === undefined ? {} : { expires: str(pass.expirationDate) }),
    },
    warnings,
  }
}

/** Every pass in a .pkpass or .pkpasses, each checked. */
export const checkBytes = (bytes: Uint8Array) => {
  const files = unzip(bytes)
  const kind = zipKind(files)
  if (files === null || kind === null) {
    throw new Error("It isn't a pass or a bundle of passes")
  }
  const inner = kind === "pass" ? [bytes] : [...files.values()]
  return {
    kind,
    passes: inner.map((data) => {
      try {
        return { valid: true as const, ...summary(verify(data)) }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        return { valid: false as const, why, warnings: [] }
      }
    }),
  }
}

/** Several checked passes in one .pkpasses, which Wallet adds with one tap. */
export const makeBundle = (passes: readonly Uint8Array[]) =>
  withDir((dir) => {
    const names = passes.map((data, i) => {
      const pass = verify(data)
      const serial = (str(pass.serialNumber) ?? String(i)).replaceAll(/[^A-Za-z0-9_-]/gu, "")
      const name = `${i + 1}-${serial}.pkpass`
      writeFileSync(path.join(dir, name), data)
      return name
    })
    run(["zip", "-q", "-X", "-0", "passes.pkpasses", ...names], dir)
    const bytes = readFileSync(path.join(dir, "passes.pkpasses"))
    const id = `bundle-${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`
    return { id, bytes }
  })

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** The certificate passes are signed with: its Pass Type ID, team and expiry. */
export const certificate = (files: WalletFiles) => {
  const out = run([
    "openssl",
    "x509",
    "-in",
    files.cert,
    "-noout",
    "-enddate",
    "-subject",
    "-nameopt",
    "RFC2253",
  ]).toString()
  // notAfter=Dec 13 23:59:59 2027 GMT
  const end = /notAfter=(?<month>\w{3}) +(?<day>\d+) (?<time>[\d:]+) (?<year>\d{4})/u.exec(
    out,
  )?.groups
  const month = MONTHS.indexOf(end?.month ?? "") + 1
  const expires = Temporal.Instant.from(
    `${end?.year ?? ""}-${String(month).padStart(2, "0")}-${(end?.day ?? "").padStart(2, "0")}T${end?.time ?? ""}Z`,
  )
  const daysLeft = Math.floor(Temporal.Now.instant().until(expires).total({ unit: "hours" }) / 24)
  return {
    passType: /UID=(?<uid>[^,\n]+)/u.exec(out)?.groups?.uid,
    team: /OU=(?<team>[^,\n]+)/u.exec(out)?.groups?.team,
    expires: expires.toString(),
    daysLeft,
  }
}

// Links.

/** GET as someone else would: Safari on an iPhone, no cookies or credentials. */
const stranger = async (url: string) => {
  const res = await fetch(url, {
    redirect: "follow",
    credentials: "omit",
    headers: { "user-agent": SAFARI, accept: "*/*", "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(30_000),
  })
  const body = new Uint8Array(await res.arrayBuffer())
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  return { status: res.status, url: res.url, type, body, redirected: res.redirected }
}

interface Link {
  readonly url: string
  readonly label: string
}

/** A page's links to passes: .pkpass or .pkpasses files, /passes/ links, or ones that say Wallet. */
const passLinks = (html: string, base: string) => {
  const found: Link[] = []
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["']?(?<href>[^"'\s>]+)[^>]*>(?<label>[\s\S]*?)<\/a>/giu,
  )) {
    const href = (m.groups?.href ?? "").replaceAll("&amp;", "&")
    const label = (m.groups?.label ?? "")
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim()
    let url: URL
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    const p = url.pathname.toLowerCase()
    const meant =
      p.endsWith(".pkpass") ||
      p.endsWith(".pkpasses") ||
      p.includes("/passes/") ||
      /\bwallet\b|\bpkpass/iu.test(label)
    if (meant && !found.some((l) => l.url === url.href)) {
      found.push({ url: url.href, label })
    }
  }
  return found
}

/** One link checked: what it's served as, and every pass in it verified. */
const inspect = async (link: Link) => {
  const problems: string[] = []
  const warnings: string[] = []
  let got: Awaited<ReturnType<typeof stranger>>
  try {
    got = await stranger(link.url)
  } catch (error) {
    return { ...link, problems: [`It won't open: ${String(error)}`], warnings, passes: [] }
  }
  const head = { ...link, status: got.status, type: got.type, bytes: got.body.length }
  if (got.status !== 200) {
    problems.push(`It answers ${got.status}`)
    return { ...head, problems, warnings, passes: [] }
  }
  if (got.body.length > MAX_BYTES) {
    problems.push("It's over 20 MB, more than a pass ever is")
    return { ...head, problems, warnings, passes: [] }
  }
  const kind = zipKind(unzip(got.body))
  if (kind === null) {
    problems.push(`It serves ${got.type === "" ? "something untyped" : got.type}, not a pass`)
    return { ...head, problems, warnings, passes: [] }
  }
  const want = kind === "pass" ? MIME : MIME_MANY
  if (got.type !== want) {
    problems.push(
      `It's served as ${got.type === "" ? "nothing" : got.type}, not ${want}, so Safari won't offer to add it`,
    )
  }
  if (!got.url.startsWith("https://")) {
    warnings.push("It isn't served over HTTPS")
  }
  const checked = checkBytes(got.body)
  for (const [i, p] of checked.passes.entries()) {
    warnings.push(...p.warnings)
    if (!p.valid) {
      problems.push(
        checked.passes.length > 1
          ? `Pass ${i + 1} isn't valid: ${p.why}`
          : `Its pass isn't valid: ${p.why}`,
      )
    }
  }
  return { ...head, kind, problems, warnings, passes: checked.passes }
}

/** A page's link, or a pass's own, opened as a stranger would, and every pass on it checked. */
export const checkLink = async (link: string) => {
  const got = await stranger(link)
  const opened = {
    status: got.status,
    type: got.type,
    ...(got.redirected ? { redirectedTo: got.url } : {}),
  }
  const problems: string[] = []
  let links: Awaited<ReturnType<typeof inspect>>[] = []
  if (got.status !== 200) {
    problems.push(`The link answers ${got.status}`)
  } else if (got.type === "text/html") {
    const found = passLinks(Buffer.from(got.body).toString("utf-8"), got.url)
    links = await Promise.all(found.map(async (l) => await inspect(l)))
    if (links.length === 0) {
      problems.push("Nothing on it links to a pass")
    }
  } else {
    links = [await inspect({ url: got.url, label: "" })]
  }
  for (const l of links) {
    const name = l.label === "" ? "The link" : `'${l.label}'`
    problems.push(...l.problems.map((p) => (name === "The link" ? p : `${name}: ${p}`)))
  }
  const valid = links.flatMap((l) => l.passes.filter((p) => p.valid))
  return {
    ok: problems.length === 0,
    link,
    opened,
    passes: valid.length,
    problems,
    warnings: [...new Set(links.flatMap((l) => l.warnings))],
    links,
  }
}
