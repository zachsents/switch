// Files over HTTP: PUT /blobs stores the body and says its hash, GET /blobs/:hash serves it, by range
// for video, and GET /blobs/:hash/light a model as a viewer draws it (light-mesh.ts). Any page may
// read and write them, as the tailnet guards the port. `PUT /blobs?replaceable=1` stores one its
// storer drops with DELETE /blobs/:hash once a newer one replaces it (a web page's picture); DELETE
// leaves any other, and one anything else has (brain's blobs.ts).
import { existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import path from "node:path"
import { yielding } from "@switch/agent"
import { Blobs, BLOB_MAX, hashOf, safeName } from "@switch/brain"
import type { BlobsShape } from "@switch/brain"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { web } from "./web.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
}

const preflight = async () =>
  await Promise.resolve(new Response(null, { status: 204, headers: CORS }))

const put = (blobs: BlobsShape) => async (request: Request) => {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > BLOB_MAX || request.body === null) {
    return Response.json({ error: "Too big" }, { status: 413, headers: CORS })
  }
  const replaceable = new URL(request.url).searchParams.get("replaceable") === "1"
  const stored = await Effect.runPromise(Effect.result(blobs.put(request.body, { replaceable })))
  if (stored._tag === "Failure") {
    const status = stored.failure === "Disk full" ? 507 : 400
    return Response.json({ error: stored.failure }, { status, headers: CORS })
  }
  return Response.json({ hash: stored.success.hash, bytes: stored.success.size }, { headers: CORS })
}

/** Drops a replaceable one nothing else has; says whether it went. */
const drop = (blobs: BlobsShape) => async (request: Request) => {
  const hash = hashOf(new URL(request.url).pathname.split("/").at(-1) ?? "")
  if (hash === null) {
    return Response.json({ error: "No such blob" }, { status: 400, headers: CORS })
  }
  const dropped = await Effect.runPromise(blobs.drop(hash))
  return Response.json({ dropped }, { headers: CORS })
}

const RANGE = /^bytes=(?<from>\d*)-(?<to>\d*)$/u

const get = (blobs: BlobsShape) => async (request: Request) => {
  const url = new URL(request.url)
  const hash = hashOf(url.pathname.split("/").at(-1) ?? "")
  const name = url.searchParams.get("name")
  const at = hash === null ? null : await Effect.runPromise(blobs.path(hash))
  if (at === null) {
    return new Response("Gone", { status: 404, headers: CORS })
  }
  const file = Bun.file(at)
  const headers: Record<string, string> = {
    ...CORS,
    "Content-Type": url.searchParams.get("type") ?? "application/octet-stream",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    ETag: `"${hash}"`,
  }
  if (name !== null) {
    const disposition = url.searchParams.get("download") === null ? "inline" : "attachment"
    headers["Content-Disposition"] =
      `${disposition}; filename*=UTF-8''${encodeURIComponent(safeName(name))}`
  }
  const range = RANGE.exec(request.headers.get("range") ?? "")
  if (range === null) {
    return new Response(file, { headers: { ...headers, "Content-Length": String(file.size) } })
  }
  const { size } = file
  const from = range.groups?.from ?? ""
  const to = range.groups?.to ?? ""
  const start = from === "" ? Math.max(0, size - Number(to)) : Number(from)
  const end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1)
  if (start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    })
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  })
}

/** Models past this aren't read to be drawn: their corners alone would take several GB. */
const LIGHT_MAX = 1024 ** 3

const lightening = new Map<string, Promise<string | null>>()

/** This build run again: the compiled `switch`, else bun on its main.ts. */
const self = Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]

/**
 * A model's light copy, kept gzipped beside its data (a dot file, so no name it's given meets it),
 * made once however many ask at a time; null when the model is light already or isn't an STL.
 */
const lightOf = async (data: string) => {
  const kept = path.join(path.dirname(data), ".light.stl.gz")
  if (existsSync(kept)) {
    return kept
  }
  const making = lightening.get(kept)
  if (making !== undefined) {
    return await making
  }
  const made = (async () => {
    const part = `${kept}.${crypto.randomUUID()}`
    // Made by a child that gives way to the core (light-mesh.ts): seconds of work, never on its thread.
    const child = Bun.spawn(yielding([...self, "light", data, part]), {
      stdout: "ignore",
      stderr: "pipe",
    })
    const said = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) {
      throw new Error(`Light copy failed: ${said.trim().split("\n").at(-1) ?? ""}`)
    }
    if (!existsSync(part)) {
      return null
    }
    await rename(part, kept)
    return kept
  })().finally(() => {
    lightening.delete(kept)
  })
  lightening.set(kept, made)
  return await made
}

/** A model as a viewer draws it: its light copy, else the model itself. */
const light = (blobs: BlobsShape) => async (request: Request) => {
  const url = new URL(request.url)
  const hash = hashOf(url.pathname.split("/").at(-2) ?? "")
  const at = hash === null ? null : await Effect.runPromise(blobs.path(hash))
  if (at === null) {
    return new Response("Gone", { status: 404, headers: CORS })
  }
  const kept = Bun.file(at).size > LIGHT_MAX ? null : await lightOf(at)
  if (kept === null) {
    return await get(blobs)(new Request(new URL(`/blobs/${hash}${url.search}`, url).toString()))
  }
  const headers: Record<string, string> = {
    ...CORS,
    "Content-Type": "model/stl",
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: `"${hash}-light"`,
  }
  const gz = Bun.file(kept)
  if ((request.headers.get("accept-encoding") ?? "").includes("gzip")) {
    return new Response(gz, {
      headers: { ...headers, "Content-Encoding": "gzip", "Content-Length": String(gz.size) },
    })
  }
  return new Response(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())), { headers })
}

export const blobsRoute = Layer.unwrap(
  Blobs.pipe(
    Effect.map((blobs) =>
      Layer.mergeAll(
        HttpRouter.add("PUT", "/blobs", web(put(blobs))),
        HttpRouter.add("POST", "/blobs", web(put(blobs))),
        HttpRouter.add("OPTIONS", "/blobs", web(preflight)),
        HttpRouter.add("GET", "/blobs/:hash", web(get(blobs))),
        HttpRouter.add("DELETE", "/blobs/:hash", web(drop(blobs))),
        HttpRouter.add("GET", "/blobs/:hash/light", web(light(blobs))),
        HttpRouter.add("OPTIONS", "/blobs/:hash/light", web(preflight)),
        HttpRouter.add("OPTIONS", "/blobs/:hash", web(preflight)),
      ),
    ),
  ),
)
