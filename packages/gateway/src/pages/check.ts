// A page checked at its link as a stranger would see it, as Switchboard's `object` op did
// (crates/sb/src/stranger.rs, document.rs): no credential or cookie, and for an https link the
// public internet's way there. This machine's resolver won't do for that: on the tailnet it
// answers with the tailnet's address, a shortcut no one else gets, so the host is looked up in
// public DNS, asked over HTTPS, and the request goes to the address it gives (curl's --resolve).
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import { MARKDOWN } from "./render.ts"

/** Public DNS, asked over HTTPS. */
const DOH = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]

const DnsAnswer = Schema.Struct({
  Answer: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String })),
  ),
})
const decodeDns = Schema.decodeUnknownOption(DnsAnswer)

/** Where one public resolver says a host is (IPv4): null when it has no address there. */
const askDns = async (server: string, host: string) => {
  const asked = await fetch(`${server}?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8000),
  })
  const said = decodeDns(await asked.json())
  if (said._tag === "None") {
    throw new TypeError("Not an answer")
  }
  return said.value.Answer?.find((a) => a.type === 1)?.data ?? null
}

/** Where public DNS says a host is, or why it can't say. */
const publicAddress = async (host: string): Promise<{ ip: string } | { why: string }> => {
  try {
    const ip = await Promise.any(DOH.map(async (server) => await askDns(server, host)))
    return ip === null ? { why: `public DNS has no address for ${host}` } : { ip }
  } catch {
    return { why: "no public DNS answered" }
  }
}

export interface Opened {
  readonly status: number
  readonly type: string
  readonly body: Uint8Array
  /** How it was opened: over the public internet, or from here and why. */
  readonly way: string
}

/** GETs `url` as someone else would. */
export const open = async (url: string): Promise<Opened> => {
  const at = new URL(url)
  const pin: string[] = []
  let way = "from here, with no credential: the link is on the private network"
  if (at.protocol === "https:") {
    const found = await publicAddress(at.hostname)
    if ("ip" in found) {
      pin.push("--resolve", `${at.hostname}:${at.port || "443"}:${found.ip}`)
      way = "as a stranger: no credential, over the public internet"
    } else {
      way = `from here, with no credential: ${found.why}`
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "switch-stranger-"))
  try {
    const out = path.join(dir, "body")
    const run = Bun.spawn(
      [
        "curl",
        "-sS",
        "--max-time",
        "60",
        ...pin,
        "-o",
        out,
        "-w",
        "%{http_code}\t%{content_type}",
        url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [said, problem] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ])
    if ((await run.exited) !== 0) {
      throw new Error(`Couldn't open ${url}: ${problem.trim()}`)
    }
    const [status = "0", type = ""] = said.split("\t")
    return { status: Number(status), type, body: new Uint8Array(readFileSync(out)), way }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
}

/** The words a reader sees in some HTML, in order. */
export const wordsOf = (html: string) =>
  html
    .replaceAll(/<(?<tag>script|style|head)\b[\s\S]*?<\/\k<tag>>/giu, " ")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/&(?<name>[a-z]+|#\d+);/giu, (whole, name: string) => ENTITIES[name] ?? whole)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "")

/** Whether `line`'s words are among `page`'s, in order and together. */
export const shows = (page: readonly string[], line: readonly string[]) => {
  if (line.length === 0) {
    return true
  }
  const joined = ` ${page.join(" ")} `
  return joined.includes(` ${line.join(" ")} `)
}

/** A markdown line's words as the page shows them: a table row's cells one by one. */
export const lineWords = (line: string) => {
  const trimmed = line.trim()
  if (/^\|?\s*:?-{3,}/u.test(trimmed) || /^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
    return []
  }
  if (trimmed.startsWith("|")) {
    return trimmed
      .split("|")
      .map((cell) => wordsOf(Bun.markdown.html(cell.trim(), MARKDOWN)))
      .filter((words) => words.length > 0)
  }
  return [
    wordsOf(
      Bun.markdown.html(
        trimmed.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, ""),
        MARKDOWN,
      ),
    ),
  ]
}

/** A document's lines that this version changed: every line, for a new one. */
export const changedLines = (before: string | null, after: string) => {
  const had = new Set((before ?? "").split("\n").map((l) => l.trim()))
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !had.has(l))
}

/** The images a document's lines show, by where the page reads them. */
export const imagesIn = (lines: readonly string[]) =>
  lines.flatMap((l) =>
    [...l.matchAll(/!\[[^\]]*\]\((?<src>[^)\s]+)/gu)].map((m) => m.groups?.src ?? ""),
  )
