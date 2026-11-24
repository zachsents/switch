// The contacts extension's tools, called through the core the way Switch's clients call an
// extension's: a POST to /widgets/contacts/<tool>. Every answer is checked against its schema
// before it's used.
import { Schema } from "effect"

/** The core: ?core= from the bun process, else this machine's. */
export const coreUrl = (): string =>
  new URLSearchParams(location.search).get("core") ?? "http://127.0.0.1:4871"

const mcpResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
})
const decodeResult = Schema.decodeUnknownSync(mcpResult)

/** Calls one of the extension's tools: its answer, decoded by `schema`, or what went wrong, thrown. */
export const call = async <A>(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  const res = await fetch(`${coreUrl()}/widgets/contacts/${tool}`, {
    method: "POST",
    // Plain text, so the browser sends it without asking first (no CORS preflight).
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(args),
  }).catch(() => {
    throw new Error("Can't reach the core")
  })
  const result = decodeResult(await res.json())
  const [first] = result.content ?? []
  if (result.isError === true) {
    const said = first?.text ?? "Didn't go through"
    throw new Error(said.startsWith("No app contacts") ? "Contacts isn't running" : said)
  }
  const raw: unknown = result.structuredContent ?? JSON.parse(first?.text ?? "null")
  return Schema.decodeUnknownSync(schema)(raw)
}
