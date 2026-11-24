// Files, named by their sha256, in a folder beside the brain: the same bytes are kept once. Each is
// a folder, `data` and a hard link per name it was given, so a turn reads it by its real name.
// Nothing deletes one a message or anything else may name; a file isn't taken when the disk is all
// but full.
import { existsSync, linkSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer } from "effect"

import { BlobHash, kindOf, safeName, typeOf } from "./attachment.ts"
import type { Attachment } from "./attachment.ts"

export interface BlobsConfig {
  readonly dir: string
}

export interface Stored {
  readonly hash: BlobHash
  readonly size: number
}

const GiB = 1024 ** 3
/** One file, at most. */
export const BLOB_MAX = 4 * GiB
/** Free disk a new file must leave. */
const LAST_GIB = GiB

const freeOn = (dir: string) => {
  const s = statfsSync(dir)
  return s.bavail * s.bsize
}

export interface BlobsShape {
  readonly dir: string
  /** Stores bytes as they stream in. */
  readonly put: (body: ReadableStream<Uint8Array>) => Effect.Effect<Stored, string>
  /** Stores a copy of a file on this machine. */
  readonly putFile: (file: string) => Effect.Effect<Stored, string>
  /** Its path, under `name` when given; null when it isn't here. */
  readonly path: (hash: BlobHash, name?: string) => Effect.Effect<string | null>
}

const make = (config: BlobsConfig): BlobsShape => {
  const { dir } = config
  const tmp = path.join(dir, "tmp")
  mkdirSync(tmp, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  const folder = (hash: BlobHash) => path.join(dir, hash)

  // Written to a file of its own, hashed on the way, then moved into its folder.
  const keep = (
    write: (out: string, hasher: Bun.CryptoHasher) => Promise<number>,
  ): Effect.Effect<Stored, string> =>
    Effect.tryPromise({
      try: async () => {
        if (freeOn(dir) < LAST_GIB) {
          throw new Error("Disk full")
        }
        const out = path.join(tmp, crypto.randomUUID())
        const hasher = new Bun.CryptoHasher("sha256")
        try {
          const size = await write(out, hasher)
          const hash = BlobHash.make(hasher.digest("hex"))
          const data = path.join(folder(hash), "data")
          if (!existsSync(data)) {
            mkdirSync(folder(hash), { recursive: true })
            renameSync(out, data)
          }
          return { hash, size }
        } finally {
          rmSync(out, { force: true })
        }
      },
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    })

  const put = (body: ReadableStream<Uint8Array>) =>
    keep(async (out, hasher) => {
      const sink = Bun.file(out).writer()
      let size = 0
      try {
        for await (const chunk of body) {
          size += chunk.byteLength
          if (size > BLOB_MAX) {
            throw new Error("Too big")
          }
          if (size % (256 * 1024 * 1024) < chunk.byteLength && freeOn(dir) < LAST_GIB) {
            throw new Error("Disk full")
          }
          hasher.update(chunk)
          void sink.write(chunk)
        }
      } finally {
        await sink.end()
      }
      return size
    })

  const putFile = (file: string) =>
    Effect.suspend(() =>
      existsSync(file) && statSync(file).isFile()
        ? put(Bun.file(file).stream())
        : Effect.fail(`No file ${file}`),
    )

  const pathOf = (hash: BlobHash, name?: string) =>
    Effect.sync(() => {
      const data = path.join(folder(hash), "data")
      if (!existsSync(data)) {
        return null
      }
      if (name === undefined) {
        return data
      }
      const named = path.join(folder(hash), safeName(name))
      if (named !== data && !existsSync(named)) {
        try {
          linkSync(data, named)
        } catch {
          return data
        }
      }
      return named
    })

  return { dir, put, putFile, path: pathOf }
}

export class Blobs extends Context.Service<Blobs, BlobsShape>()("switch/Blobs") {
  static readonly layer = (config: BlobsConfig) => Layer.sync(Blobs, () => make(config))
}

const IMAGE_LINK =
  /!\[(?<alt>[^\]]*)\]\(\s*(?:<(?<bracketed>[^>]+)>|(?<bare>(?:file:\/\/)?\/[^)\s]+))\s*\)/gu

const unescaped = (at: string) => {
  try {
    return decodeURI(at)
  } catch {
    return at
  }
}

/**
 * Files in Markdown as images at paths on this machine, stored: an image stays in the text, linked
 * as `/blobs/<hash>`; anything else (a video, a model, a PDF) comes out of it as an attachment.
 */
export const localFiles = (blobs: BlobsShape, text: string) =>
  Effect.gen(function* storing() {
    let out = text
    const attachments: Attachment[] = []
    for (const m of text.matchAll(IMAGE_LINK)) {
      const at = unescaped((m.groups?.bracketed ?? m.groups?.bare ?? "").replace(/^file:\/\//u, ""))
      if (!at.startsWith("/")) {
        continue
      }
      const stored = yield* Effect.option(blobs.putFile(at))
      if (stored._tag === "Some") {
        const type = typeOf(at)
        const { hash, size } = stored.value
        if (kindOf(type, at) === "image") {
          out = out.replace(
            m[0],
            `![${m.groups?.alt ?? ""}](/blobs/${hash}?type=${encodeURIComponent(type)})`,
          )
        } else {
          out = out.replace(m[0], "")
          attachments.push({ blob: hash, name: safeName(at), type, size })
        }
      }
    }
    return { text: out.trim(), attachments }
  })
