// A fresh authentication challenge stays bound to one tab and field. Inbox/text adapters return
// codes only over authenticated internal HTTP; the public tool returns status, never their bodies.
import { Asks, openSealed, sealedKey, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"

import { isJson, reach } from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { signIn } from "./signin.ts"
import { withTab } from "./tab.ts"
import type { Tab } from "./tab.ts"

const source = Schema.Struct({
  app: Schema.String,
  tool: Schema.Literal("authentication_code"),
  input: Schema.Record(Schema.String, Schema.Unknown),
})
const input = Schema.Struct({
  session: Schema.String,
  site: Schema.String,
  account: Schema.String,
  sources: Schema.Array(source),
  verified: Schema.Struct({ urlPrefix: Schema.String, selector: Schema.String }),
})
type Input = typeof input.Type
interface Pending {
  readonly input: Input
  readonly since: number
  readonly field: number
  readonly fingerprint: string
  readonly secretKey: string
  readonly use: string
}
const pending = new Map<string, Pending>()

/** Authenticated local transport; errors never include another service's response body. */
const call = async (app: string, name: string, args: Json): Promise<Json> => {
  if (!/^[a-z0-9-]+$/u.test(app) || !/^[a-z0-9_]+$/u.test(name)) {
    throw new Error("Invalid authentication source")
  }
  const response = await fetch(
    `${process.env.SWITCH_URL ?? "http://127.0.0.1:4871"}/widgets/${app}/${name}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.SWITCH_TOKEN !== undefined && {
          authorization: `Bearer ${process.env.SWITCH_TOKEN}`,
        }),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    },
  )
  const result: unknown = await response.json()
  if (!response.ok || !isJson(result) || result.isError === true) {
    throw new Error("Authentication source unavailable")
  }
  if (isJson(result.structuredContent)) {
    return result.structuredContent
  }
  const content = Array.isArray(result.content) ? result.content : []
  const first: unknown = content[0]
  if (!isJson(first) || typeof first.text !== "string") {
    throw new Error("Invalid authentication response")
  }
  const value: unknown = JSON.parse(first.text)
  if (!isJson(value)) {
    throw new Error("Invalid authentication response")
  }
  return value
}

/** Actual authenticated page evidence, independent of whether a code field disappeared. */
const verified = async (tab: Tab, expected: Input["verified"]): Promise<boolean> => {
  const prefix = new URL(expected.urlPrefix)
  if (
    prefix.protocol !== "https:" ||
    prefix.search ||
    prefix.hash ||
    prefix.username ||
    prefix.password ||
    !expected.selector
  ) {
    throw new Error("An authenticated page check is required")
  }
  return (
    (await tab.script(
      `(() => {
    const prefix = new URL(${JSON.stringify(prefix.href)});
    const matches = location.origin === prefix.origin && location.pathname.startsWith(prefix.pathname);
    const element = document.querySelector(${JSON.stringify(expected.selector)});
    return matches && !!element && element.getClientRects().length > 0;
  })()`,
      10_000,
    )) === true
  )
}

/** A challenge is usable only on its original HTTPS host, original code field and time window. */
const bound = async (tab: Tab, held: Pending): Promise<void> => {
  if (Date.now() - held.since > 10 * 60_000) {
    throw new Error("Code expired. Retry sign-in.")
  }
  const info = await tab.info()
  const page = new URL(info.url)
  if (page.protocol !== "https:" || page.hostname !== held.input.site) {
    throw new Error("Sign-in page changed. Retry sign-in.")
  }
  const fields = await tab.page("signin()")
  if (
    !Array.isArray(fields) ||
    !fields.some(
      (field) =>
        isJson(field) &&
        field.kind === "code" &&
        field.n === held.field &&
        field.fp === held.fingerprint,
    )
  ) {
    throw new Error("Code field changed. Retry sign-in.")
  }
}

/** Applies a code once; no result of filling it escapes the browser service. */
const apply = async (tab: Tab, held: Pending, code: string): Promise<boolean> => {
  await bound(tab, held)
  if (!/^[a-z0-9]{4,10}$/iu.test(code)) {
    throw new Error("Invalid verification code")
  }
  await signIn(tab, { otp: code })
  return await verified(tab, held.input.verified)
}

const challenge = tool(
  "challenge",
  {
    description:
      "Complete an authorized current sign-in code privately. Bind the exact HTTPS site/account and an authenticated-page URL+selector. sources name installed private inbox/text code adapters with exact sender/service/account input; their since is bound here, not supplied by the model. Tries fresh matching codes before opening a sealed private input. Never read or paste an OTP in chat. No documents, orders or messages are sent.",
    input,
  },
  (args) =>
    Effect.gen(function* challenging() {
      const asks = yield* Asks
      return yield* Effect.tryPromise(
        async () =>
          await withTab(args.session, null, async (tab) => {
            await reach()
            await tab.ensure()
            if (await verified(tab, args.verified)) {
              return { connected: true }
            }
            const info = await tab.info()
            const page = new URL(info.url)
            if (page.protocol !== "https:" || page.hostname !== args.site || !args.account) {
              throw new Error("Sign-in account and HTTPS site are required")
            }
            if (
              args.sources.some(
                (adapter) =>
                  adapter.input.account !== undefined && adapter.input.account !== args.account,
              )
            ) {
              throw new Error("Authentication source account does not match")
            }
            const fields = await tab.page("signin()")
            const field: unknown = Array.isArray(fields)
              ? fields.find((value) => isJson(value) && value.kind === "code")
              : undefined
            if (!isJson(field) || typeof field.n !== "number" || typeof field.fp !== "string") {
              throw new Error("No current verification code challenge")
            }
            const pair = await sealedKey()
            const held: Pending = {
              input: args,
              since: Date.now() - 30_000,
              field: field.n,
              fingerprint: field.fp,
              secretKey: pair.secretKey,
              use: `${args.site} sign-in`,
            }
            for (let attempt = 0; attempt < 3; attempt += 1) {
              for (const adapter of args.sources) {
                // Adapter failure means try the next authorized channel, never publish its body/error.
                const answer = await call(adapter.app, adapter.tool, {
                  ...adapter.input,
                  since: held.since,
                }).catch(() => null)
                if (answer?.found === true && typeof answer.code === "string") {
                  if (await apply(tab, held, answer.code)) {
                    return { connected: true }
                  }
                  throw new Error(
                    "Code was submitted but sign-in is not verified. Check the sign-in page.",
                  )
                }
              }
              if (attempt < 2) {
                await Bun.sleep(1500)
              }
            }
            const ask = {
              title: `${args.site} code`,
              body: `${args.site} code`,
              kind: "sealed" as const,
              completion: "owner" as const,
              answerTo: "challenge_answer",
              sealed: { key: pair.key, use: held.use },
              action: { label: "Retry", app: "browser", tool: "challenge", args },
            }
            const opened = await Effect.runPromise(asks.open(ask))
            pending.set(opened.id, held)
            const expiry = setTimeout(() => {
              pending.delete(opened.id)
              void Effect.runPromise(asks.close(opened.id, "dismissed"))
            }, 10 * 60_000)
            expiry.unref()
            return {
              connected: false,
              item: opened.id,
              view: { app: "browser", name: "tab", input: { session: args.session } },
            }
          }),
      )
    }),
)

const answer = tool(
  "challenge_answer",
  {
    description: "Private sealed challenge input, verified before its owner closes it.",
    appOnly: true,
    input: Schema.Struct({
      item: Schema.String,
      status: Schema.optionalKey(Schema.String),
      enc: Schema.optionalKey(Schema.String),
      ct: Schema.optionalKey(Schema.String),
    }),
  },
  (args) =>
    Effect.gen(function* answering() {
      const asks = yield* Asks
      const held = pending.get(args.item)
      if (args.status !== undefined) {
        pending.delete(args.item)
        return { connected: false }
      }
      if (held === undefined || args.enc === undefined || args.ct === undefined) {
        return yield* Effect.fail(new Error("Code expired. Retry sign-in."))
      }
      pending.delete(args.item)
      const code = yield* Effect.tryPromise(
        async () =>
          await openSealed(held.secretKey, args.item, held.use, {
            enc: args.enc ?? "",
            ct: args.ct ?? "",
          }),
      )
      const connected = yield* Effect.tryPromise(
        async () =>
          await withTab(held.input.session, null, async (tab) => {
            await reach()
            await tab.ensure()
            return await apply(tab, held, code.trim())
          }),
      )
      if (!connected) {
        return yield* Effect.fail(new Error("Sign-in is not verified. Retry sign-in."))
      }
      yield* asks.close(args.item, "done")
      return { connected: true }
    }),
)

export const challengeTools = [challenge, answer]
