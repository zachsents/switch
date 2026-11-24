// The brain's widget routes: where a widget's messages come from, and how it calls its extension's
// tools.
import { Schema } from "effect"

import { coreUrl } from "../brain/auth.ts"

/** A widget route: `/widgets`, or `/widgets/<app>/<name>`. */
export const widgetsUrl = (rest = "", params: Readonly<Record<string, string>> = {}) =>
  coreUrl(`/widgets${rest}`, params)

/** Calls one of an extension's tools for its widget: a swap, a camera frame. Answers its MCP result. */
export const callTool = async (app: string, tool: string, args: unknown): Promise<unknown> => {
  const res = await fetch(widgetsUrl(`/${app}/${tool}`), {
    method: "POST",
    // Plain text, so the browser sends it without asking first (no CORS preflight).
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(args ?? {}),
  })
  const answer: unknown = await res.json()
  return answer
}

const failed = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.Literal(true),
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
)

/** Calls an app's tool for a mutation: its answer, or what it said went wrong, thrown. */
export const callChecked = async (app: string, tool: string, args: unknown) => {
  const answer = await callTool(app, tool, args).catch(() => {
    throw new Error("Can't reach the core")
  })
  const bad = failed(answer)
  if (bad._tag === "Some") {
    throw new Error(bad.value.content[0]?.text ?? "Didn't go through")
  }
  return answer
}
