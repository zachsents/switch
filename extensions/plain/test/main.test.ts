// The extension as Switch runs it, over fake apps in a folder of their own: Images and Recorder
// installed, and no Tasks, which plain no longer has.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isJson } from "switch-ext-kit"
import type { Json } from "switch-ext-kit"

import { lines, parse } from "../src/child.ts"

const root = path.join(import.meta.dir, "..")
const apps = mkdtempSync(path.join(tmpdir(), "plain-apps-"))
const fake = path.join(import.meta.dir, "fake-app.ts")

for (const [name, prefix] of [
  ["Images", "images"],
  ["Recorder", "recorder"],
] as const) {
  const macos = path.join(apps, `${name}.app`, "Contents", "MacOS")
  mkdirSync(macos, { recursive: true })
  const binary = path.join(macos, prefix)
  writeFileSync(binary, `#!/bin/sh\nFAKE_APP=${prefix} exec bun ${JSON.stringify(fake)}\n`)
  chmodSync(binary, 0o755)
}

const proc = Bun.spawn(["bun", path.join(root, "src", "main.ts")], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
  env: { ...process.env, PLAIN_APPS: apps },
})
const waiting = new Map<number, PromiseWithResolvers<Json>>()
/** The first heartbeat's data, once it comes. */
const heartbeat = Promise.withResolvers<Json>()
let next = 1

const field = (m: Json, key: string): Json => {
  const v = m[key]
  return isJson(v) ? v : {}
}

const send = (m: Json) => {
  void proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`)
}

const ask = async (method: string, params: Json = {}): Promise<Json> => {
  const id = next
  next += 1
  const answered = Promise.withResolvers<Json>()
  waiting.set(id, answered)
  send({ id, method, params })
  return field(await answered.promise, "result")
}

beforeAll(() => {
  void lines(proc.stdout, (line) => {
    const m = parse(line)
    if (m === null) {
      return
    }
    const asked = typeof m.id === "number" ? waiting.get(m.id) : undefined
    const params = field(m, "params")
    if (asked && m.method === undefined) {
      asked.resolve(m)
    } else if (params.name === "plain.heartbeat") {
      heartbeat.resolve(field(params, "data"))
    }
  })
})

afterAll(() => {
  proc.kill()
  rmSync(apps, { recursive: true, force: true })
})

test("its heartbeat is healthy with Images and Recorder, and names no Tasks", async () => {
  await ask("initialize", { protocolVersion: "2025-06-18" })
  send({ id: 0, method: "events/stream", params: { name: "plain.heartbeat" } })
  const data = await heartbeat.promise
  expect(data.facts).toEqual({ failing: null, apps: 2 })
  expect(data.summary).toBe("Images, Recorder")
})

test("its tools are Images' and Recorder's, and they answer", async () => {
  const listed = await ask("tools/list")
  const names = (Array.isArray(listed.tools) ? listed.tools : []).map((t) =>
    isJson(t) ? t.name : null,
  )
  expect(names.map(String).toSorted((a, b) => a.localeCompare(b))).toEqual([
    "images_ping",
    "recorder_ping",
  ])
  expect(await ask("tools/call", { name: "recorder_ping", arguments: {} })).toEqual({
    content: [{ type: "text", text: "recorder pong" }],
  })
  expect(await ask("tools/call", { name: "tasks_show_list", arguments: {} })).toMatchObject({
    isError: true,
  })
})

test("it declares no widget", async () => {
  expect(await ask("resources/list")).toEqual({ resources: [] })
  const manifest: unknown = await Bun.file(path.join(root, "package.json")).json()
  const extension = isJson(manifest) ? field(manifest, "extension") : {}
  expect(extension.name).toBe("plain")
  expect(extension.widgets).toBeUndefined()
})
