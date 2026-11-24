// A stand-in for one of plain's apps' `<app> mcp`: one tool, `ping`, that answers with its app.
import { lines, parse } from "../src/child.ts"

const app = process.env.FAKE_APP ?? "app"
const results: Record<string, unknown> = {
  initialize: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: app } },
  "tools/list": { tools: [{ name: "ping", title: "Ping", inputSchema: { type: "object" } }] },
  "tools/call": { content: [{ type: "text", text: `${app} pong` }] },
  "events/list": { events: [] },
}

await lines(Bun.stdin.stream(), (line) => {
  const m = parse(line)
  if (m?.id !== undefined) {
    const method = typeof m.method === "string" ? m.method : ""
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: results[method] ?? {} })}\n`,
    )
  }
})
