// An approved send that rsynced 320 MB before it answered was cut at the client's default 60 s and
// reported "Couldn't reach it", while it went through 44 s later (Nov 23). A tool's progress keeps
// its call open; one silent too long answers that it may still have gone through.
import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"

import { runTool } from "./gateway.ts"

const SILENCE_MS = 100

/** A tool that answers after `forMs`, saying how it's going every `everyMs` when asked to. */
const linked = async (forMs: number, everyMs: number) => {
  const mcp = new McpServer({ name: "slow", version: "1" }, { capabilities: { tools: {} } })
  mcp.server.setRequestHandler("tools/list", () => ({ tools: [] }))
  mcp.server.setRequestHandler("tools/call", async (request, ctx) => {
    const token = request.params._meta?.progressToken
    let step = 0
    const ticking = setInterval(() => {
      step += 1
      if (token !== undefined) {
        ctx.mcpReq
          .notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: step },
          })
          .catch(() => {
            /* the caller went */
          })
      }
    }, everyMs)
    await Bun.sleep(forMs)
    clearInterval(ticking)
    return { content: [{ type: "text", text: "sent" }] }
  })
  const [near, far] = InMemoryTransport.createLinkedPair()
  await mcp.connect(far)
  const client = new Client({ name: "switch", version: "1" })
  await client.connect(near)
  return client
}

test("a call that says how it's going runs past the silence to its answer", async () => {
  const client = await linked(SILENCE_MS * 3, SILENCE_MS / 2)
  const result = await runTool(client, { name: "send", arguments: {} }, SILENCE_MS)
  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ type: "text", text: "sent" }])
})

test("a silent call times out saying it may still have gone through", async () => {
  const client = await linked(SILENCE_MS * 3, SILENCE_MS * 10)
  const result = await runTool(client, { name: "send", arguments: {} }, SILENCE_MS)
  expect(result.isError).toBe(true)
  const [first] = result.content
  expect(first?.type === "text" && first.text).toContain("may still have gone through")
})
