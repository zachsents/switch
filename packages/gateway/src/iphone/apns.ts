// Apple's push service: a provider token signed with the account's .p8 (ES256), then one HTTP/2
// request per push. APNs speaks only HTTP/2, so this is node:http2 rather than fetch.
import { createPrivateKey, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import http2 from "node:http2"
import { Schema } from "effect"

/** The push key file: the .p8 as PEM, its id and its team. */
const decodeKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ key: Schema.String, key_id: Schema.String, team_id: Schema.String }),
  ),
)

export interface Target {
  readonly token: string
  /** "development" (the sandbox) or "production". */
  readonly environment: string
  /** The app's bundle id; a Live Activity's push adds `.push-type.liveactivity`. */
  readonly topic: string
}

export interface Push {
  readonly type: "alert" | "background" | "liveactivity"
  readonly payload: Record<string, unknown>
  /** 10 sends now; 5 lets iOS pick its moment (a quiet push must be 5). */
  readonly priority?: 5 | 10
  /** Replaces an earlier notification with the same id on the lock screen. */
  readonly collapse?: string
}

export interface Sent {
  readonly status: number
  readonly reason: string
}

const TOKEN_FOR = 50 * 60_000

const hostOf = (environment: string) =>
  environment === "development"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com"

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url")

export const makeApns = (file: string) => {
  const raw = decodeKey(readFileSync(file, "utf-8"))
  const { key_id: keyId, team_id: teamId } = raw
  const key = createPrivateKey(raw.key)
  let token: { readonly value: string; readonly at: number } | null = null
  const sessions = new Map<string, http2.ClientHttp2Session>()

  const bearer = () => {
    const now = Temporal.Now.instant().epochMilliseconds
    if (token !== null && now - token.at < TOKEN_FOR) {
      return token.value
    }
    const head = b64(JSON.stringify({ alg: "ES256", kid: keyId }))
    const claims = b64(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))
    const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
      key,
      dsaEncoding: "ieee-p1363",
    })
    token = { value: `${head}.${claims}.${b64(signature)}`, at: now }
    return token.value
  }

  /** The open connection to `host`, if there's one still up. */
  const reused = (host: string) => {
    const open = sessions.get(host)
    return open !== undefined && !open.closed && !open.destroyed ? open : null
  }

  const connect = (host: string) => {
    const made = http2.connect(host)
    const drop = () => {
      if (sessions.get(host) === made) {
        sessions.delete(host)
      }
    }
    made.on("error", drop)
    made.on("close", drop)
    sessions.set(host, made)
    return made
  }

  /** One request on `over`: its status and APNs' reason, or status 0 and why none came back. */
  const request = async (over: http2.ClientHttp2Session, to: Target, push: Push): Promise<Sent> => {
    const { promise, resolve } = Promise.withResolvers<Sent>()
    const topic = push.type === "liveactivity" ? `${to.topic}.push-type.liveactivity` : to.topic
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${to.token}`,
      authorization: `bearer ${bearer()}`,
      "apns-topic": topic,
      "apns-push-type": push.type,
      "apns-priority": String(push.priority ?? (push.type === "background" ? 5 : 10)),
    }
    if (push.collapse !== undefined) {
      headers["apns-collapse-id"] = push.collapse.slice(0, 64)
    }
    try {
      const stream = over.request(headers)
      let status = 0
      let body = ""
      stream.setEncoding("utf-8")
      stream.on("response", (h) => {
        status = h[":status"] ?? 0
      })
      stream.on("data", (chunk: string) => {
        body += chunk
      })
      stream.on("end", () => {
        let reason = ""
        if (body !== "") {
          const parsed: unknown = JSON.parse(body)
          if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
            reason = String(parsed.reason)
          }
        }
        resolve({ status, reason })
      })
      stream.on("error", (error: Error) => {
        resolve({ status: 0, reason: error.message })
      })
      stream.end(JSON.stringify(push.payload))
    } catch (error) {
      resolve({ status: 0, reason: error instanceof Error ? error.message : String(error) })
    }
    return await promise
  }

  // A connection kept open between pushes can be cut while idle (a reset, a GOAWAY); nothing shows
  // it until the next push on it fails without an answer. That push goes again, once, on a new one;
  // a new connection that fails too is a real outage.
  const send = async (to: Target, push: Push): Promise<Sent> => {
    const host = hostOf(to.environment)
    const open = reused(host)
    if (open === null) {
      return await request(connect(host), to, push)
    }
    const sent = await request(open, to, push)
    if (sent.status !== 0) {
      return sent
    }
    open.destroy()
    if (sessions.get(host) === open) {
      sessions.delete(host)
    }
    return await request(connect(host), to, push)
  }

  return { send, teamId }
}

export type Apns = ReturnType<typeof makeApns>
