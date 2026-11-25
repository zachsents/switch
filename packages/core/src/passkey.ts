// An item that's approved only with the user's passkey (`passkey`, an extension's tool by name).
// Its link, `/p/passkey/<token>`, is on the pages listener, which a public proxy serves, so it
// opens on the user's phone anywhere. The core only relays: GET asks the extension's tool for the
// WebAuthn options (`step: "options"`) and draws a page with them in; the page signs them with Face
// ID or Touch ID and POSTs what the authenticator answered, which the core hands to the same tool
// (`step: "verify"`). The extension checks the signature against the passkey it keeps and closes
// the item itself; nothing here can approve one. `origin` and `rp` (its host, the passkey's
// relying party) come from the pages' base.
import { getItem } from "@switch/autonomy"
import { Brain, defineRead } from "@switch/brain"
import { Gateway, Pages, passkeyToken } from "@switch/gateway"
import { Effect, Schema } from "effect"
import type { CallToolResult } from "@modelcontextprotocol/server"

const PRIVATE = {
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
}

/** The most a page sends back: an authenticator's answer is a few KB. */
const MAX_BODY = 64 * 1024

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

// The page's script: the options are in the page already, so Approve calls WebAuthn straight from
// the tap (Safari refuses one that comes after a fetch).
const SCRIPT = `
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const o = JSON.parse(document.getElementById("options").textContent);
const said = document.getElementById("said");
const keys = [...document.querySelectorAll("button")];
const show = (text) => { said.textContent = text; };
const go = async (window) => {
  keys.forEach((k) => { k.disabled = true; });
  try {
    let credential;
    if (o.mode === "create") {
      const c = await navigator.credentials.create({ publicKey: {
        rp: { id: o.rp, name: o.rpName }, user: { id: unb(o.user.id), name: o.user.name, displayName: o.user.name },
        challenge: unb(o.challenge), pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none", timeout: 120000 } });
      credential = { type: "create", id: c.id, clientData: b64u(c.response.clientDataJSON),
        authData: b64u(c.response.getAuthenticatorData()), key: b64u(c.response.getPublicKey()), alg: c.response.getPublicKeyAlgorithm() };
    } else {
      const c = await navigator.credentials.get({ publicKey: { rpId: o.rp, challenge: unb(o.challenge),
        allowCredentials: o.allow.map((id) => ({ type: "public-key", id: unb(id) })), userVerification: "required", timeout: 120000 } });
      credential = { type: "get", id: c.id, clientData: b64u(c.response.clientDataJSON),
        authData: b64u(c.response.authenticatorData), signature: b64u(c.response.signature) };
    }
    const r = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, window }) });
    const a = await r.json();
    show(a.ok ? "Approved" : a.said || "Not approved");
    if (a.ok) { return; }
  } catch (e) {
    show(e && e.name === "NotAllowedError" ? "Cancelled" : String(e && e.message || e));
  }
  keys.forEach((k) => { k.disabled = false; });
};
document.getElementById("once").addEventListener("click", () => go(false));
const w = document.getElementById("window");
if (w) { w.addEventListener("click", () => go(true)); }
`
const SCRIPT_HASH = `sha256-${new Bun.CryptoHasher("sha256").update(SCRIPT).digest("base64")}`
const POLICY = `default-src 'none'; script-src '${SCRIPT_HASH}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 17px/1.4 -apple-system, system-ui, sans-serif; }
main { max-width: 520px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0; padding: 20px 16px 8px; }
p { margin: 0; padding: 0 16px 16px; white-space: pre-wrap; opacity: .75; }
.keys { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #8884; }
button { font: inherit; font-weight: 600; padding: 18px; border: 0; background: none; color: inherit; }
button + button { border-left: 1px solid #8884; }
button:only-child { grid-column: span 2; }
#said { padding: 16px; min-height: 1.4em; border-top: 1px solid #8884; }
`

const page = (title: string, body: string, options: unknown, window: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escape(title)}</h1>${body === "" ? "" : `<p>${escape(body)}</p>`}
<div class="keys"><button id="once">Approve</button>${window ? '<button id="window">Approve 15 min</button>' : ""}</div>
<div id="said" role="status"></div></main>
<script type="application/json" id="options">${JSON.stringify(options).replaceAll("<", "\\u003c")}</script>
<script>${SCRIPT}</script></body></html>`

const plain = (text: string, status: number) =>
  new Response(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLE}</style><main><h1>${escape(text)}</h1></main>`,
    {
      status,
      headers: {
        ...PRIVATE,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": POLICY,
      },
    },
  )

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE })

const Options = Schema.Struct({
  mode: Schema.Literals(["create", "get"]),
  challenge: Schema.String,
  /** It offers a window as well as one use. */
  window: Schema.optionalKey(Schema.Boolean),
})
const decodeOptions = Schema.decodeUnknownOption(Options)
const Verified = Schema.Struct({ ok: Schema.Boolean, said: Schema.optionalKey(Schema.String) })
const decodeVerified = Schema.decodeUnknownOption(Verified)
const Posted = Schema.Struct({
  credential: Schema.Unknown,
  window: Schema.optionalKey(Schema.Boolean),
})
const decodePosted = Schema.decodeUnknownOption(Schema.fromJsonString(Posted))

const errorText = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")

/** Whether a request is one for a passkey ceremony. */
export const isPasskey = (request: Request): boolean =>
  new URL(request.url).pathname.startsWith("/p/passkey/")

/** The open items' ids. */
const openIdsRead = defineRead("core/passkey/open-ids", (db) =>
  db
    .query<{ id: string }, []>("SELECT id FROM action_items WHERE status = 'open'")
    .all()
    .map((r) => r.id),
)
/** An item, if it asks for a passkey from an app. */
const passkeyItemRead = defineRead("core/passkey/item", (db, id: string) => {
  const item = getItem(db, id)
  return item?.passkey !== undefined && item.app !== undefined ? item : null
})

export const passkeyRoute = Effect.gen(function* routing() {
  const brain = yield* Brain
  const gateway = yield* Gateway
  const pages = yield* Pages
  const origin = pages.base
  const rp = new URL(origin).hostname

  /** The open passkey item a token names. */
  const find = async (token: string) => {
    if (!/^[0-9a-f]{32}$/u.test(token)) {
      return null
    }
    // A token is the pages key's: matched here, where the key is, against what's open.
    const ids = await Effect.runPromise(brain.read(openIdsRead))
    const id = ids.find((open) => passkeyToken(pages, open) === token)
    return id === undefined ? null : await Effect.runPromise(brain.read(passkeyItemRead, id))
  }

  const ask = async (app: string, tool: string, args: Record<string, unknown>) => {
    try {
      return await gateway.call(`${app}_${tool}`, { ...args, origin, rp })
    } catch {
      return null
    }
  }

  interface Waiting {
    readonly id: string
    readonly app: string
    readonly tool: string
    readonly title: string
    readonly body: string
  }

  /** The page, with the options its extension issued in it. */
  const show = async (w: Waiting) => {
    const result = await ask(w.app, w.tool, { item: w.id, step: "options" })
    if (result === null) {
      return plain(`Can't reach ${w.app}`, 503)
    }
    const options = result.isError === true ? null : decodeOptions(result.structuredContent)
    if (options === null || options._tag === "None") {
      return plain(errorText(result) || "Can't approve it now", 503)
    }
    return new Response(
      page(w.title, w.body, result.structuredContent, options.value.window === true),
      {
        headers: {
          ...PRIVATE,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": POLICY,
        },
      },
    )
  }

  /** What the authenticator answered, for its extension to check. */
  const answer = async (w: Waiting, request: Request) => {
    const text = await request.text()
    const posted = text.length > MAX_BODY ? null : decodePosted(text)
    if (posted === null || posted._tag === "None") {
      return json({ ok: false, said: "Not a passkey's answer" }, 400)
    }
    const result = await ask(w.app, w.tool, {
      item: w.id,
      step: "verify",
      credential: posted.value.credential,
      window: posted.value.window === true,
    })
    if (result === null) {
      return json({ ok: false, said: `Can't reach ${w.app}` }, 503)
    }
    const verified = result.isError === true ? null : decodeVerified(result.structuredContent)
    if (verified === null || verified._tag === "None") {
      return json({ ok: false, said: errorText(result) || "Not approved" }, 422)
    }
    return json(verified.value, verified.value.ok ? 200 : 422)
  }

  return async (request: Request): Promise<Response> => {
    const token = new URL(request.url).pathname.split("/")[3] ?? ""
    const item = await find(token)
    const post = request.method === "POST"
    if (item?.passkey === undefined || item.app === undefined) {
      return post
        ? json({ ok: false, said: "It's no longer waiting" }, 410)
        : plain("Nothing to approve", 410)
    }
    const w = { id: item.id, app: item.app, tool: item.passkey, title: item.title, body: item.body }
    if (post) {
      return await answer(w, request)
    }
    return request.method === "GET" ? await show(w) : json({ ok: false, said: "Not found" }, 404)
  }
})
