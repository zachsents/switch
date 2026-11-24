// The core, from the bun process: the secrets extension's tools as a client calls them (a POST to
// /widgets/secrets/<tool>), and the brain's sync socket, watched for `secrets.changed`.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"

const settings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      core: Schema.optionalKey(Schema.String),
      token: Schema.optionalKey(Schema.String),
    }),
  ),
)

const configured = () => {
  const file = process.env.SWITCH_CONFIG ?? path.join(homedir(), ".switch", "config.json")
  return Option.getOrUndefined(
    existsSync(file) ? settings(readFileSync(file, "utf-8")) : Option.none(),
  )
}

/** The core: $SWITCH_CORE, else the one this machine's host reports to, else this machine's. */
const coreUrl = () => {
  const given = process.env.SWITCH_CORE
  if (given !== undefined && given !== "") {
    return given
  }
  return configured()?.core ?? "http://127.0.0.1:4871"
}

export const CORE = coreUrl()

/** The core's credential, where this machine has one: $SWITCH_TOKEN, else the config's. */
const TOKEN = process.env.SWITCH_TOKEN ?? configured()?.token ?? ""

/** A socket's address with the credential, where there is one. */
export const withToken = (url: URL) => {
  if (TOKEN !== "") {
    url.searchParams.set("token", TOKEN)
  }
  return url
}

const decodeResult = Schema.decodeUnknownSync(
  Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    structuredContent: Schema.optionalKey(Schema.Unknown),
    content: Schema.optionalKey(
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
    ),
  }),
)

/** Calls one of the extension's tools: its answer, decoded by `schema`, or what went wrong, thrown. */
export const call = async <A>(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  const res = await fetch(new URL(`/widgets/secrets/${tool}`, CORE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN !== "" && { Authorization: `Bearer ${TOKEN}` }),
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {
    throw new Error("Can't reach the core")
  })
  const result = decodeResult(await res.json())
  const [first] = result.content ?? []
  if (result.isError === true) {
    const said = first?.text ?? "Didn't go through"
    throw new Error(
      said.startsWith("No app secrets") ? "The secrets extension isn't running" : said,
    )
  }
  const raw: unknown = result.structuredContent ?? JSON.parse(first?.text ?? "null")
  return Schema.decodeUnknownSync(schema)(raw)
}

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("snapshot"), seq: Schema.Finite }),
      Schema.Struct({
        type: Schema.Literal("events"),
        events: Schema.Array(Schema.Struct({ seq: Schema.Finite, type: Schema.String })),
      }),
    ]),
  ),
)

/** Calls `onChange` whenever the brain logs `secrets.changed`, and each time the socket's back. */
export const watchChanges = (onChange: () => void) => {
  let cursor: number | null = null
  let backoff = 250
  const open = () => {
    const url = new URL(CORE)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = "/"
    url.searchParams.set("source", "secrets-app")
    if (cursor !== null) {
      url.searchParams.set("since", String(cursor))
    }
    const ws = new WebSocket(withToken(url))
    ws.addEventListener("open", () => {
      backoff = 250
      ws.send(JSON.stringify({ type: "watch", types: ["secrets.changed"] }))
      onChange()
    })
    ws.addEventListener("message", (m) => {
      const message =
        typeof m.data === "string" ? Option.getOrUndefined(decodeMessage(m.data)) : undefined
      if (message?.type === "snapshot") {
        cursor = message.seq
      } else if (message?.type === "events") {
        cursor = message.events.at(-1)?.seq ?? cursor
        if (message.events.some((e) => e.type === "secrets.changed")) {
          onChange()
        }
      }
    })
    ws.addEventListener("close", () => {
      setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, 5000)
    })
  }
  open()
}
