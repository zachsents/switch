// The words in a picture, and the picture with some of them filled, for Switch's redaction (its
// brain's redact.ts): Vision through a small Swift helper (pictures-source.ts), the picture through
// its stdin and back on its stdout, so none is written here. This Mac offers them to the core
// (`redactions/pictures`), which matches the words and names the boxes to fill.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Host } from "switch-ext-kit"

import { source as swiftSource } from "./pictures-source.ts"

const version = createHash("sha256").update(swiftSource).digest("hex").slice(0, 12)
let built: Promise<string> | null = null

const build = async () => {
  const dir = path.join(homedir(), ".switch", "bin")
  const out = path.join(dir, `pictures-${version}`)
  if (existsSync(out)) {
    return out
  }
  mkdirSync(dir, { recursive: true })
  const src = path.join(tmpdir(), `switch-pictures-${version}.swift`)
  writeFileSync(src, swiftSource)
  const proc = Bun.spawn(["swiftc", "-O", src, "-o", out], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    throw new Error(`Couldn't build the picture reader: ${err.slice(0, 500)}`)
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

const run = async (args: readonly string[], picture: Uint8Array) => {
  const proc = Bun.spawn([await helper(), ...args], {
    stdin: picture,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).bytes()])
  return { ok: code === 0, out }
}

export const Read = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
  lines: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      /** Each word's UTF-16 start and end in `text`, and its box: x, y, w, h of the picture. */
      words: Schema.Array(Schema.Array(Schema.Finite)),
    }),
  ),
})
const decodeRead = Schema.decodeUnknownSync(Schema.fromJsonString(Read))
const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
)

const failed = (out: Uint8Array) => {
  const said = decodeError(new TextDecoder().decode(out))
  return new Error(said._tag === "Some" ? said.value.error : "The picture reader failed")
}

/** Its lines of text, each with its words' places. */
export const readText = async (picture: Uint8Array) => {
  const { ok, out } = await run(["read"], picture)
  if (!ok) {
    throw failed(out)
  }
  return decodeRead(new TextDecoder().decode(out))
}

/** The picture with `boxes` filled solid. */
export const fillBoxes = async (picture: Uint8Array, boxes: readonly (readonly number[])[]) => {
  const { ok, out } = await run(["fill", JSON.stringify(boxes)], picture)
  if (!ok) {
    throw failed(out)
  }
  return out
}

/** This Mac reads pictures for the core's redaction, by these tools. */
export const offerPictures = (machine: string) =>
  Effect.gen(function* offering() {
    const host = yield* Host
    yield* host.request(
      "redactions/pictures",
      { read: "picture_text", fill: "picture_fill", machine },
      Schema.Unknown,
    )
  }).pipe(Effect.ignore({ log: "Warn", message: "The core didn't take this Mac's picture reader" }))
