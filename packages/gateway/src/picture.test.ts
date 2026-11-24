// A camera feed asks every second. Its frame went as base64 in the tool's JSON result, twice (the
// image content and the structured data): a 365 KB frame was 975 KB on the wire, every second, a
// new frame or not (Nov 23: 16 Mbps of a home's Wi-Fi to one Mac for two printer widgets).
import { expect, test } from "bun:test"
import type { CallToolResult } from "@modelcontextprotocol/server"

import { widgetCall } from "./gateway.ts"

const jpeg = new Uint8Array(365_000).map((_, i) => (i * 31) % 251)
const data = Buffer.from(jpeg).toString("base64")
const AT = 1_795_492_015_399

let calls = 0
const camera = async (): Promise<CallToolResult> => {
  calls += 1
  return await Promise.resolve({
    content: [{ type: "image", data, mimeType: "image/jpeg" }],
    structuredContent: { printer: "h2c", at: AT, source: "live", mimeType: "image/jpeg", data },
  })
}

const route = widgetCall(camera)

const ask = async (query: string) =>
  await route(
    new Request(`http://core/widgets/printers/camera${query}`, {
      method: "POST",
      body: JSON.stringify({ printer: "h2c", fresh: true }),
    }),
    "printers__camera",
  )

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())

test("a feed's frame comes as the picture itself", async () => {
  const res = await ask("?as=picture")
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("image/jpeg")
  expect(res.headers.get("x-picture-at")).toBe(String(AT))
  const body = await bytesOf(res)
  expect(body.length).toBe(jpeg.length)
  expect(body).toEqual(jpeg)
})

test("a frame the feed has already comes as nothing", async () => {
  const res = await ask(`?as=picture&have=${AT}`)
  expect(res.status).toBe(204)
  const body = await bytesOf(res)
  expect(body.length).toBe(0)
})

test("a newer frame than the one it has comes whole", async () => {
  const body = await bytesOf(await ask(`?as=picture&have=${AT - 1700}`))
  expect(body.length).toBe(jpeg.length)
})

test("a call without it answers the tool's result as before", async () => {
  const res = await ask("")
  const text = await res.text()
  expect(text).toContain(`"data":"${data}"`)
  expect(calls).toBe(4)
})
