// A file asked for again while it's still coming is the same fetch: a 90 MB model clicked two dozen
// times went over the network two dozen times at once (Nov 23), filling the Wi-Fi for minutes.
import { afterAll, expect, mock, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import { tmpdir } from "node:os"
import path from "node:path"

const home = mkdtempSync(path.join(tmpdir(), "files-test-"))
// Its Downloads is a folder of the test's own, never this Mac's.
void mock.module("node:os", () => ({ ...os, homedir: () => home }))

void mock.module("electrobun/main", () => ({
  ContextMenu: { showContextMenu: () => {}, on: () => {} },
  Utils: { showItemInFolder: () => {} },
}))
void mock.module("./native.ts", () => ({ nativeHelper: () => {} }))

const { onFile } = await import("./files.ts")

let asked = 0
const body = new Uint8Array(1024 * 1024).fill(7)
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async () => {
    asked += 1
    await Bun.sleep(150)
    return new Response(body)
  },
})

afterAll(async () => {
  await server.stop(true)
  rmSync(home, { recursive: true, force: true })
})

test("clicks on a file still coming join its one fetch", async () => {
  const url = `http://127.0.0.1:${server.port}/blobs/abc`
  const done = await Promise.all(
    Array.from({ length: 24 }, async () => await onFile({ url, name: "big.stl", do: "download" })),
  )
  expect(asked).toBe(1)
  expect(done.every(Boolean)).toBe(true)
  expect(readdirSync(path.join(home, "Downloads"))).toEqual(["big.stl"])
})
