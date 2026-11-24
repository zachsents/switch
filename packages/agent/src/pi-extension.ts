// Pi's public extension/MCP boundary, adapted from T3 Code's mcpExtensionSource.ts
// (MIT, Copyright (c) 2026 T3 Tools Inc.). Loaded by the user's own Pi installation.
export const PI_EXTENSION = String.raw`
import { Type } from "typebox";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const protocol = "2025-06-18";
const parse = (body, type) => {
  if (!type.includes("text/event-stream")) return JSON.parse(body);
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const result = JSON.parse(line.slice(5).trim());
    if (result.id !== undefined) return result;
  }
  throw new Error("MCP response missing");
};

export default async function switchMcp(pi) {
  const servers = JSON.parse(process.env.SWITCH_PI_MCP || "{}");
  const mode = process.env.SWITCH_PI_MODE;
  const readOnly = new Set(["read", "grep", "find", "ls"]);
  pi.on("tool_call", (event) => {
    if (mode !== "plan" || readOnly.has(event.toolName)) return;
    return { block: true, reason: "Plan mode" };
  });
  for (const [server, config] of Object.entries(servers)) {
    let next = 0;
    let session;
    const request = async (method, params, signal, notification = false) => {
      const headers = { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": protocol };
      if (config.token) headers.authorization = "Bearer " + config.token;
      if (session) headers["mcp-session-id"] = session;
      const response = await fetch(config.url, {
        method: "POST", headers, signal,
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++next }), method, params }),
      });
      if (!response.ok) throw new Error("MCP " + method + " failed: " + response.status);
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) session = nextSession;
      const body = await response.text();
      if (!body.trim()) return;
      const reply = parse(body, response.headers.get("content-type") || "");
      if (reply.error) throw new Error(reply.error.message || "MCP request failed");
      return reply.result;
    };
    await request("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "switch-pi", version: "1" } });
    await request("notifications/initialized", {}, undefined, true);
    let cursor;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error("MCP tool catalog missing");
      for (const tool of page.tools) {
        const name = "mcp__" + server + "__" + tool.name;
        if (mode === "plan" && tool.annotations?.readOnlyHint === true) readOnly.add(name);
        pi.registerTool({
          name, label: tool.name, description: tool.description || tool.name,
          parameters: Type.Unsafe({ ...record(tool.inputSchema), type: "object", properties: tool.inputSchema?.properties || {} }),
          async execute(_id, params, signal) {
            const result = await request("tools/call", { name: tool.name, arguments: params }, signal);
            if (result?.isError) throw new Error(JSON.stringify(result.content || "MCP tool failed"));
            const content = Array.isArray(result?.content) ? result.content.filter((part) => part.type === "text" || part.type === "image") : [];
            return { content: content.length ? content : [{ type: "text", text: JSON.stringify(result?.structuredContent ?? result) }], details: result };
          },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}
`
