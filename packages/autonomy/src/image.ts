// Any picture the agent wants, from a gateway image model (the profile's Image, or one it names):
// words, and pictures to work from or edit, in; files out. What a picture is for, and how it looks,
// is the agent's: a space's cover is one, set with `autonomy_cover`.
import { homedir } from "node:os"
import { Blobs, hashOf } from "@switch/brain"
import { Models } from "@switch/models"
import type { ImageRequest } from "@switch/models"
import { Context, Effect, Layer } from "effect"

export interface Drawing extends Omit<ImageRequest, "images" | "mask"> {
  /** Paths on this machine or blobs. */
  readonly images: readonly string[]
  readonly mask?: string
}

export interface Drawn {
  /** The files, on the core's machine, and their blobs. */
  readonly images: readonly { readonly path: string; readonly blob: string }[]
  readonly model: string
  /** Dollars, as the gateway reports it. */
  readonly cost: number
  readonly usage: { readonly input: number; readonly output: number }
}

export interface ImagesShape {
  readonly draw: (drawing: Drawing) => Effect.Effect<Drawn, string>
}

const extension = (bytes: Uint8Array) => {
  if (bytes[0] === 0x89) {
    return "png"
  }
  return bytes[0] === 0x52 && bytes[8] === 0x57 ? "webp" : "jpg"
}

export class Images extends Context.Service<Images, ImagesShape>()("switch/Images") {
  static readonly layer = Layer.effect(
    Images,
    Effect.gen(function* making() {
      const blobs = yield* Blobs
      const models = yield* Models

      const read = (given: string) =>
        Effect.gen(function* reading() {
          const hash = hashOf(given.trim().replace(/^\/blobs\//u, ""))
          const file =
            hash === null
              ? given
                  .trim()
                  .replace(/^file:\/\//u, "")
                  .replace(/^~(?=\/)/u, homedir())
              : yield* blobs.path(hash)
          if (file === null) {
            return yield* Effect.fail(`No blob ${given}`)
          }
          return yield* Effect.tryPromise({
            try: async () => new Uint8Array(await Bun.file(file).arrayBuffer()),
            catch: () => `Can't read ${given}`,
          })
        })

      const keep = (bytes: Uint8Array) =>
        Effect.gen(function* keeping() {
          const { hash } = yield* blobs.put(new Blob([bytes]).stream())
          const path = yield* blobs.path(hash, `image.${extension(bytes)}`)
          return { path: path ?? (yield* Effect.fail(`Blob ${hash} is gone`)), blob: hash }
        })

      const draw: ImagesShape["draw"] = ({ images, mask, ...rest }) =>
        Effect.gen(function* drawing() {
          const p = yield* models
            .image({
              ...rest,
              images: yield* Effect.all(images.map((i) => read(i))),
              ...(mask !== undefined && { mask: yield* read(mask) }),
            })
            .pipe(Effect.mapError((e) => e.reason))
          return {
            images: yield* Effect.all(p.images.map((i) => keep(i))),
            model: p.model,
            cost: p.cost,
            usage: p.usage,
          }
        })
      return { draw } satisfies ImagesShape
    }),
  )
}
