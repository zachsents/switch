// Files to and from the core's blobs: each dropped or pasted file uploads at once, as a query of its
// own keyed by its id, so its chip shows how it's going and a send waits on the uploads still out.
import { hashOf, typeOf } from "@switch/brain/commands"
import type { Attachment } from "@switch/brain/commands"
import { queryOptions } from "@tanstack/react-query"

import { queryClient } from "../query.ts"
import { coreUrl } from "./auth.ts"
import { getFile } from "./outbox-files.ts"
import type { KeptFile } from "./outbox.ts"

/** Where a file is served, under its name; `download` asks for it saved. */
export const blobUrl = (a: Attachment, download = false) => {
  const url = new URL(coreUrl(`/blobs/${a.blob}`))
  url.searchParams.set("type", a.type)
  url.searchParams.set("name", a.name)
  if (download) {
    url.searchParams.set("download", "1")
  }
  return url.toString()
}

/** A Markdown image's address: a `/blobs/` path is the core's. */
export const imageSrc = (src: string) => (src.startsWith("/blobs/") ? coreUrl(src) : src)

/** A file chosen for the box, before it's sent. */
export interface Chosen {
  readonly id: string
  readonly file: File
  /** An image's own address, for its chip. */
  readonly preview?: string
}

/** Files as the box holds them. */
export const choose = (files: Iterable<File>): Chosen[] =>
  [...files].map((file) => ({
    id: crypto.randomUUID(),
    file,
    ...(file.type.startsWith("image/") && { preview: URL.createObjectURL(file) }),
  }))

/** An upload the core won't take however often it's tried. */
export class RefusedError extends Error {
  override name = "RefusedError"
}

const upload = async (file: File, name = file.name): Promise<Attachment> => {
  const type = typeOf(name, file.type)
  const res = await fetch(coreUrl("/blobs"), {
    method: "PUT",
    headers: { "Content-Type": type },
    body: file,
  }).catch(() => {
    throw new Error("Can't reach the core")
  })
  const said: unknown = await res.json().catch(() => ({}))
  const hash =
    typeof said === "object" && said !== null && "hash" in said ? hashOf(String(said.hash)) : null
  if (!res.ok || hash === null) {
    const why: Readonly<Record<number, string>> = { 413: "Too big", 507: "Core's disk is full" }
    const reason = why[res.status]
    throw reason === undefined ? new Error("Didn't upload") : new RefusedError(reason)
  }
  return { blob: hash, name: name || "file", type, size: file.size }
}

/** A chosen file as the outbox keeps it, up already if its upload here is done. */
export const keptOf = (c: Chosen): KeptFile => {
  const up = queryClient.getQueryData(uploadQuery(c).queryKey)
  return {
    id: c.id,
    name: c.file.name,
    type: c.file.type,
    size: c.file.size,
    ...(up && { blob: up.blob }),
  }
}

/** A kept file as the box holds it again, its bytes read back; null when they're gone. */
export const chosenOf = async (k: KeptFile): Promise<Chosen | null> => {
  const got = await getFile(k.id).catch(() => null)
  if (got === null) {
    return null
  }
  const file = new File([got], k.name, { type: k.type })
  return {
    id: k.id,
    file,
    ...(file.type.startsWith("image/") && { preview: URL.createObjectURL(file) }),
  }
}

/** A kept file uploaded from its bytes here. */
export const uploadKept = async (k: KeptFile): Promise<Attachment> => {
  const hash = k.blob === undefined ? null : hashOf(k.blob)
  if (hash !== null) {
    return { blob: hash, name: k.name || "file", type: typeOf(k.name, k.type), size: k.size }
  }
  const got = await getFile(k.id)
  if (got === null) {
    throw new RefusedError("File's gone")
  }
  return await upload(got, k.name)
}

export const uploadQuery = (c: Chosen) =>
  queryOptions({
    queryKey: ["upload", c.id],
    queryFn: async () => await upload(c.file),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 2,
  })

export const sizeOf = (n: number) => {
  if (n < 1000) {
    return `${n} B`
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1000)} KB`
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(1)} MB`
  }
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}
