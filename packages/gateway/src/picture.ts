// A widget's live picture (a camera's frame) as a client paints it: the image itself, not its base64
// in JSON beside a second copy of it, and nothing at all when the client has that frame already. A
// feed asks every second; a printer's camera sends a new frame about every two, of 300 KB or more.
import type { CallToolResult } from "@modelcontextprotocol/server"

/** When the frame was taken, as the client says which one it has. */
export const PICTURE_AT = "X-Picture-At"

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

/**
 * A tool's result as its picture: 200 with the image (empty when there's none), 204 when it's the
 * frame `have` names, 502 with what went wrong.
 */
export const pictureOf = (
  result: CallToolResult,
  have: string | null,
  headers: Readonly<Record<string, string>>,
) => {
  const base = {
    ...headers,
    "Access-Control-Expose-Headers": PICTURE_AT,
    "Cache-Control": "no-store",
  }
  if (result.isError === true) {
    const said = result.content.find((c) => c.type === "text")
    return new Response(said?.type === "text" ? said.text : "Didn't go through", {
      status: 502,
      headers: base,
    })
  }
  const r = record(result.structuredContent)
  const data = typeof r.data === "string" ? r.data : ""
  if (data === "") {
    return new Response(null, { status: 200, headers: base })
  }
  const at = typeof r.at === "number" ? String(r.at) : Bun.hash(data).toString(36)
  if (have === at) {
    return new Response(null, { status: 204, headers: { ...base, [PICTURE_AT]: at } })
  }
  const type = typeof r.mimeType === "string" ? r.mimeType : "image/jpeg"
  return new Response(Buffer.from(data, "base64"), {
    headers: { ...base, "Content-Type": type, [PICTURE_AT]: at },
  })
}
