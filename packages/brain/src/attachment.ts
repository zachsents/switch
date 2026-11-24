// A file on a message: its blob (sha256), name, type and size. Browser-safe; the store is blobs.ts.
import { Option, Schema } from "effect"

export const BlobHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("BlobHash"),
)
export type BlobHash = typeof BlobHash.Type

/** A file on a message. */
export const Attachment = Schema.Struct({
  blob: BlobHash,
  name: Schema.String,
  /** Its MIME type. */
  type: Schema.String,
  size: Schema.Number,
})
export type Attachment = typeof Attachment.Type

const decodeHash = Schema.decodeUnknownOption(BlobHash)
/** A hash as said: bare, or a `sha256:` / `blob:` URI. */
export const hashOf = (said: string) =>
  Option.getOrNull(decodeHash(said.replace(/^(?:sha256|blob):/u, "")))

/** A name safe as a file name: its last part, no leading dots, not too long. */
export const safeName = (name: string) => {
  const last = (name.split("/").at(-1) ?? "").replace(/^\.+/u, "")
  let base = ""
  for (const c of last) {
    if ((c.codePointAt(0) ?? 0) >= 32) {
      base += c
    }
  }
  return base === "" ? "file" : base.slice(-120)
}

const TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  stl: "model/stl",
  "3mf": "model/3mf",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  usdz: "model/vnd.usdz+zip",
}

/** A file's MIME type by its name, when it has none of its own. */
export const typeOf = (name: string, given = "") => {
  const plain = given.split(";")[0]?.trim() ?? ""
  if (plain !== "" && plain !== "application/octet-stream") {
    return plain
  }
  return TYPES[extension(name)] ?? "application/octet-stream"
}

const extension = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

/** What a file is, as a chat draws it. */
export const kindOf = (type: string, name: string) => {
  const ext = extension(name)
  if (["stl", "3mf", "glb", "gltf", "obj"].includes(ext) || type.startsWith("model/")) {
    return "model"
  }
  if (type.startsWith("image/")) {
    return "image"
  }
  if (type.startsWith("video/")) {
    return "video"
  }
  if (type.startsWith("audio/")) {
    return "audio"
  }
  return "file"
}
