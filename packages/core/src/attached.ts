// A message's files as a turn takes them: each a path it can read, by its own name, and images also
// as images the model sees, scaled to what it reads well.
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import type { Image } from "@switch/agent"
import type { Attachment, BlobsShape } from "@switch/brain"
import { Effect } from "effect"

/** What models take as an image as it is. */
const SEEN = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const SEEN_MAX = 3_500_000
/** Its long side, at most: what models read before they scale it down themselves. */
const SIDE = 1568
const SIPS = "/usr/bin/sips"
/** Elsewhere, ImageMagick's, when it's installed. */
const MAGICK = ["/usr/bin/magick", "/usr/bin/convert", "/usr/local/bin/magick"].find((p) =>
  existsSync(p),
)

const megabytes = (n: number) =>
  n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`

/** An image as the model gets it: scaled to a JPEG beside it, or itself when that fits as is. */
const seen = (at: string, a: Attachment) =>
  Effect.promise(async (): Promise<Image | null> => {
    const scaled = path.join(path.dirname(at), "seen.jpg")
    if (existsSync(scaled)) {
      return { path: scaled, type: "image/jpeg" }
    }
    let scale: string[] | null = null
    if (existsSync(SIPS)) {
      scale = [SIPS, "-Z", String(SIDE), "-s", "format", "jpeg", at, "--out", scaled]
    } else if (MAGICK !== undefined) {
      scale = [MAGICK, `${at}[0]`, "-auto-orient", "-resize", `${SIDE}x${SIDE}>`, `jpeg:${scaled}`]
    }
    if (scale !== null && a.type !== "image/gif") {
      const proc = Bun.spawn(scale, { stdout: "ignore", stderr: "ignore" })
      if ((await proc.exited) === 0 && existsSync(scaled)) {
        return { path: scaled, type: "image/jpeg" }
      }
    }
    return SEEN.has(a.type) && statSync(at).size <= SEEN_MAX ? { path: at, type: a.type } : null
  })

/** The lines a turn reads its files by, and the images among them. */
export const attached = (blobs: BlobsShape, attachments: readonly Attachment[]) =>
  Effect.gen(function* attaching() {
    const lines: string[] = []
    const images: Image[] = []
    for (const a of attachments) {
      const at = yield* blobs.path(a.blob, a.name)
      if (at === null) {
        lines.push(`${a.name} (gone)`)
        continue
      }
      lines.push(`${at} (${a.type}, ${megabytes(a.size)})`)
      if (a.type.startsWith("image/")) {
        const image = yield* seen(at, a)
        if (image !== null) {
          images.push(image)
        }
      }
    }
    return { note: lines.length > 0 ? `Attached:\n${lines.join("\n")}` : "", images }
  })
