import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import nodePath from "node:path"
import { Config, Context, Duration, Effect, Exit, Layer, Redacted } from "effect"

import { SUBSCRIPTIONS } from "./tiers.ts"
import { ClaudeCode } from "./claude-code.ts"
import type { Model, Profile, Role } from "./profiles.ts"
import { ModelError } from "./types.ts"
import type { Answer, Completion, Decision, Embedding, Input, Question } from "./types.ts"

const GATEWAY = "https://ai-gateway.vercel.sh/v1/"
const EMBEDDING = "openai/text-embedding-3-small"
// Without the key in the environment, it's read over ssh from the login profile of the machine
// that has it: `keyHost` in ~/.switch/config.json, or $SWITCH_KEY_HOST. It stays Redacted and is
// never logged.
const parseJson: (text: string) => unknown = JSON.parse

const keyHost = () => {
  const env = process.env.SWITCH_KEY_HOST ?? ""
  if (env !== "") {
    return env
  }
  const dir = process.env.SWITCH_DIR ?? nodePath.join(homedir(), ".switch")
  const at = process.env.SWITCH_CONFIG ?? nodePath.join(dir, "config.json")
  try {
    const parsed = parseJson(readFileSync(at, "utf-8"))
    const v: unknown =
      typeof parsed === "object" && parsed !== null && "keyHost" in parsed ? parsed.keyHost : ""
    return typeof v === "string" ? v : ""
  } catch {
    return ""
  }
}

const keyFromHost = Effect.tryPromise({
  try: async () => {
    const host = keyHost()
    if (host === "") {
      return ""
    }
    const ssh = Bun.spawn(
      ["ssh", "-o", "BatchMode=yes", host, 'zsh -lc "printf %s \\"\\$AI_GATEWAY_API_KEY\\""'],
      { stdout: "pipe", stderr: "ignore" },
    )
    const out = await new Response(ssh.stdout).text()
    return out.trim()
  },
  catch: () => new ModelError({ reason: "No gateway key" }),
}).pipe(
  Effect.flatMap((key) =>
    key === ""
      ? Effect.fail(new ModelError({ reason: "No gateway key" }))
      : Effect.succeed(Redacted.make(key)),
  ),
)

const gatewayKey = Effect.catchTag(
  Config.Redacted("AI_GATEWAY_API_KEY"),
  "ConfigError",
  () => keyFromHost,
)

type Json = Record<string, unknown>

const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const field = (v: unknown, key: string): unknown => (isJson(v) ? v[key] : undefined)
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0)

// Decisions report it in provider metadata; chat completions in usage.
const costOf = (reply: unknown) =>
  num(
    field(
      field(field(reply, "providerMetadata") ?? field(reply, "provider_metadata"), "gateway"),
      "cost",
    ) ?? field(field(reply, "usage"), "cost"),
  )

const requests = {
  // TypeSafe's Jev: a state and named choice questions.
  evaluate: (model: Model, input: Input, questions: Readonly<Record<string, Question>>) => ({
    model: model.id,
    state: { context: input.stable, item: input.item },
    questions: Object.fromEntries(
      Object.entries(questions).map(([name, q]) => [
        name,
        {
          type: "choice",
          instructions: q.instructions,
          criteria:
            q.predicate === true
              ? { yes: null, no: null }
              : Object.fromEntries(q.choices.map((c) => [c.value, c.description ?? null])),
        },
      ]),
    ),
  }),
  // OpenAI's Luna Decisions: input content with a cache breakpoint after the stable part.
  decisions: (model: Model, input: Input, questions: Readonly<Record<string, Question>>) => ({
    model: model.id,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: input.stable, prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_text", text: input.item },
        ],
      },
    ],
    prompt_cache_options: { mode: "explicit" },
    questions: Object.entries(questions).map(([name, q]) =>
      q.predicate === true
        ? { type: "predicate", name, instructions: q.instructions }
        : { type: "choice", name, instructions: q.instructions, choices: q.choices },
    ),
  }),
}

const answersOf = (endpoint: keyof typeof requests, reply: unknown): Record<string, Answer> => {
  const out: Record<string, Answer> = {}
  const raw = field(reply, "answers")
  if (endpoint === "evaluate" && isJson(raw)) {
    for (const [name, a] of Object.entries(raw)) {
      const choice = field(a, "choice")
      const probabilities = field(a, "probabilities")
      if (typeof choice === "string") {
        out[name] = {
          choice,
          probabilities: isJson(probabilities)
            ? Object.fromEntries(Object.entries(probabilities).map(([k, p]) => [k, num(p)]))
            : { [choice]: 1 },
        }
      }
    }
  }
  if (endpoint === "decisions" && Array.isArray(raw)) {
    for (const a of raw) {
      const name = field(a, "name")
      // A predicate's calibrated probability, as yes and no (decide/src/lib.rs:304-308).
      if (typeof name === "string" && field(a, "type") === "predicate") {
        const p = num(field(a, "probability"))
        out[name] = { choice: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } }
        continue
      }
      const choice = field(a, "choice")
      const probabilities = field(a, "probabilities")
      if (typeof name === "string" && typeof choice === "string") {
        out[name] = {
          choice,
          probabilities: Array.isArray(probabilities)
            ? Object.fromEntries(
                probabilities.map((p) => [String(field(p, "value")), num(field(p, "probability"))]),
              )
            : { [choice]: 1 },
        }
      }
    }
  }
  return out
}

export interface ModelsShape {
  /** Asks the role's decision model every question about one input, in one call. */
  readonly decide: (
    input: Input,
    questions: Readonly<Record<string, Question>>,
    role?: Role,
  ) => Effect.Effect<Decision, ModelError>
  /** On a model named outright rather than by its role in the profile. */
  readonly completeOn: (
    model: Model,
    system: string,
    prompt: string,
    images?: readonly Uint8Array[],
  ) => Effect.Effect<Completion, ModelError>
  /** `images` (JPEG or PNG) go with the prompt, to a gateway model only. */
  readonly complete: (
    role: Role,
    system: string,
    prompt: string,
    images?: readonly Uint8Array[],
  ) => Effect.Effect<Completion, ModelError>
  /** Pictures from a gateway image model: from words alone, or from reference pictures too. */
  readonly image: (request: ImageRequest) => Effect.Effect<Pictures, ModelError>
  /** Unit vectors, one per text, from the gateway's embedding model. */
  readonly embed: (texts: readonly string[]) => Effect.Effect<Embedding, ModelError>
}

export interface ImageRequest {
  /** A gateway image model; the profile's image model when unset. */
  readonly model?: string
  readonly prompt: string
  /** Pictures to work from or edit (JPEG, PNG or WebP). */
  readonly images: readonly Uint8Array[]
  /** Its transparent part is what changes in the first of `images`. */
  readonly mask?: Uint8Array
  /** Like "1024x1024", or "auto"; Gemini's "512", "1K", "2K", "4K". */
  readonly size?: string
  /** Width to height, like "16:9", when `size` isn't given. */
  readonly aspect?: string
  /** The model's word, like "low" or "high". */
  readonly quality?: string
  readonly n: number
  /** "transparent", "opaque" or "auto". */
  readonly background?: string
  /** "png", "jpeg" or "webp". */
  readonly format?: string
}

export interface Pictures {
  readonly model: string
  readonly images: readonly Uint8Array[]
  readonly ms: number
  /** Dollars, as the gateway reports it. */
  readonly cost: number
  readonly usage: { readonly input: number; readonly output: number }
}

const typeOf = (bytes: Uint8Array) => {
  if (bytes[0] === 0x89) {
    return "image/png"
  }
  return bytes[0] === 0x52 && bytes[8] === 0x57 ? "image/webp" : "image/jpeg"
}
const dataUrl = (bytes: Uint8Array) =>
  `data:${typeOf(bytes)};base64,${Buffer.from(bytes).toString("base64")}`

const choicesOf = (q: Question) =>
  q.predicate === true ? ["yes", "no"] : q.choices.map((c) => c.value)

const notWired = (model: Model) =>
  Effect.fail(new ModelError({ reason: `${model.provider} not wired for ${model.id}` }))

const tokens = (reply: unknown) => {
  const usage = field(reply, "usage")
  return {
    input: num(field(usage, "input_tokens") ?? field(usage, "prompt_tokens")),
    output: num(field(usage, "output_tokens") ?? field(usage, "completion_tokens")),
  }
}

// Image models take pixels: a square is 1024 across, others 1536 on the long side, in 16s.
const sizeOf = (aspect: string) => {
  const [w = 1, h = 1] = aspect.split(":").map(Number)
  if (w === h) {
    return "1024x1024"
  }
  const short = (n: number) => Math.round((1536 * n) / Math.max(w, h) / 16) * 16
  return w > h ? `1536x${short(h)}` : `${short(w)}x1536`
}

const scaleOf = (long: number) => {
  if (long <= 512) {
    return "512"
  }
  if (long <= 1024) {
    return "1K"
  }
  return long <= 2048 ? "2K" : "4K"
}

// Gemini takes a shape and a scale: "WxH" becomes both.
const geminiShape = (r: ImageRequest) => {
  const pixels = /^(?<w>\d+)x(?<h>\d+)$/u.exec(r.size ?? "")?.groups
  if (pixels === undefined) {
    return {
      ...(r.aspect !== undefined && { aspectRatio: r.aspect }),
      ...(r.size !== undefined && { imageSize: r.size }),
    }
  }
  const w = Number(pixels.w)
  const h = Number(pixels.h)
  let a = w
  let b = h
  while (b > 0) {
    const rest = a % b
    a = b
    b = rest
  }
  return { aspectRatio: `${w / a}:${h / a}`, imageSize: scaleOf(Math.max(w, h)) }
}

const make = Effect.fnUntraced(function* making(profile: Profile | Effect.Effect<Profile>) {
  // A found key is kept; a failure isn't (a key host away, a login profile not read yet), so the
  // next call looks again.
  const key = yield* Effect.cachedWithTTL(gatewayKey, (exit) =>
    Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  )
  const claudeCode = yield* ClaudeCode
  // Without a gateway key (an install on a Claude subscription alone), a gateway model's work goes
  // to Claude Code: Haiku for a Haiku, Sonnet for the rest.
  const routed = (model: Model): Effect.Effect<Model> =>
    model.provider === "gateway"
      ? Effect.map(Effect.exit(key), (exit) =>
          Exit.isSuccess(exit)
            ? model
            : { provider: "claude-code", id: model.id.includes("haiku") ? "haiku" : "sonnet" },
        )
      : Effect.succeed(model)

  // A picture takes up to a few minutes, and is never asked for twice: each one costs.
  const post = (path: string, body: unknown, slow = false) =>
    Effect.gen(function* posting() {
      const k = yield* key
      const start = performance.now()
      const reply = yield* Effect.tryPromise({
        try: async (signal) => {
          const res = await fetch(GATEWAY + path, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Redacted.value(k)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
          })
          const text = await res.text()
          if (!res.ok) {
            throw new Error(`${res.status} ${text.slice(0, 300)}`)
          }
          return JSON.parse(text) as unknown
        },
        catch: (e) => new ModelError({ reason: `Gateway ${path}: ${String(e)}` }),
      }).pipe(
        Effect.timeout(slow ? "5 minutes" : "30 seconds"),
        Effect.mapError((e) =>
          e instanceof ModelError ? e : new ModelError({ reason: `Gateway ${path}: timed out` }),
        ),
        Effect.retry({ times: slow ? 0 : 2 }),
      )
      return { reply, ms: performance.now() - start }
    })

  const decideOn = (
    model: Model,
    input: Input,
    questions: Readonly<Record<string, Question>>,
  ): Effect.Effect<Decision, ModelError> =>
    Effect.gen(function* decidingOn() {
      const names = Object.keys(questions)
      const asked = names
        .map((n) => {
          const q = questions[n]
          if (q === undefined) {
            return ""
          }
          const listed =
            q.predicate === true
              ? "  yes\n  no"
              : q.choices
                  .map(
                    (c) => `  ${c.value}${c.description === undefined ? "" : `: ${c.description}`}`,
                  )
                  .join("\n")
          return `${n}: ${q.instructions}\n${listed}`
        })
        .join("\n\n")
      const c = yield* claudeCode.run({
        model: `${model.provider === "claude-code" ? "claude" : model.provider}:${model.id}`,
        system: `${input.stable}\n\nAnswer every question below. Reply with only a JSON object from each question's name to an object from each of its choices to the probability (0 to 1) that it's the right one.`,
        prompt: `${input.item}\n\nQuestions:\n${asked}`,
        ...(model.account === undefined ? {} : { account: model.account }),
      })
      const start = c.text.indexOf("{")
      const end = c.text.lastIndexOf("}")
      let got: unknown = null
      try {
        got = start === -1 ? null : parseJson(c.text.slice(start, end + 1))
      } catch {
        got = null
      }
      if (!isJson(got)) {
        return yield* new ModelError({ reason: `${model.id}: no decision in its reply` })
      }
      const answers: Record<string, Answer> = {}
      for (const n of names) {
        const q = questions[n]
        const given = field(got, n)
        if (q === undefined || !isJson(given)) {
          continue
        }
        const values = choicesOf(q)
        if (values.length === 0) {
          continue
        }
        const raw = values.map((v) => Math.min(1, Math.max(0, num(field(given, v)))))
        const total = raw.reduce((x, y) => x + y, 0)
        const probabilities = Object.fromEntries(
          values.map((v, i) => [v, total > 0 ? (raw[i] ?? 0) / total : 1 / values.length]),
        )
        let choice = values[0] ?? ""
        for (const v of values) {
          if ((probabilities[v] ?? 0) > (probabilities[choice] ?? 0)) {
            choice = v
          }
        }
        answers[n] = { choice, probabilities }
      }
      return { answers, ms: c.ms, cost: c.cost }
    })

  const decide: ModelsShape["decide"] = (input, questions, role = "decision") =>
    Effect.gen(function* deciding() {
      const model = yield* routed(
        (yield* Effect.isEffect(profile) ? profile : Effect.succeed(profile)).roles[role],
      )
      // On a subscription (a profile that runs everything on Codex, say), the questions go to the
      // model in one completion, and each choice comes back with the probability it gives it.
      if (model.provider === "claude-code" || SUBSCRIPTIONS.some((p) => p === model.provider)) {
        return yield* decideOn(model, input, questions)
      }
      if (model.provider !== "gateway") {
        return yield* notWired(model)
      }
      const endpoint = model.id.includes("jev") ? "evaluate" : "decisions"
      return yield* Effect.map(
        post(endpoint, requests[endpoint](model, input, questions)),
        ({ reply, ms }) => ({ answers: answersOf(endpoint, reply), ms, cost: costOf(reply) }),
      )
    })

  const complete: ModelsShape["complete"] = (role, system, prompt, images = []) =>
    Effect.gen(function* completingRole() {
      const p = yield* Effect.isEffect(profile) ? profile : Effect.succeed(profile)
      return yield* completeOn(p.roles[role], system, prompt, images)
    })

  const completeOn: ModelsShape["completeOn"] = (given, system, prompt, images = []) =>
    Effect.gen(function* completing() {
      const model = yield* routed(given)
      // Subscriptions run through the session runner, whichever provider.
      if (model.provider === "claude-code" || SUBSCRIPTIONS.some((p) => p === model.provider)) {
        return yield* claudeCode.run({
          model: `${model.provider === "claude-code" ? "claude" : model.provider}:${model.id}`,
          system,
          prompt,
          ...(model.account === undefined ? {} : { account: model.account }),
        })
      }
      if (model.provider !== "gateway") {
        return yield* notWired(model)
      }
      const body = {
        model: model.id,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              images.length === 0
                ? prompt
                : [
                    { type: "text", text: prompt },
                    ...images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } })),
                  ],
          },
        ],
      }
      return yield* Effect.map(post("chat/completions", body), ({ reply, ms }) => {
        const choices = field(reply, "choices")
        const first: unknown = Array.isArray(choices) ? choices[0] : undefined
        const text = field(field(first, "message"), "content")
        return { text: typeof text === "string" ? text : "", ms, cost: costOf(reply) }
      })
    })

  const embed: ModelsShape["embed"] = (texts) =>
    Effect.map(
      post("embeddings", { model: EMBEDDING, input: texts.map((t) => t.slice(0, 8000)) }),
      ({ reply, ms }) => {
        const data = field(reply, "data")
        const rows = Array.isArray(data) ? data : []
        const vectors = texts.map((_, i) => {
          const row: unknown = rows.find((r) => field(r, "index") === i) ?? rows[i]
          const raw = field(row, "embedding")
          const v = Float32Array.from(Array.isArray(raw) ? raw.map(num) : [])
          let norm = 0
          for (const x of v) {
            norm += x * x
          }
          const n = Math.sqrt(norm) || 1
          return v.map((x) => x / n)
        })
        return { vectors, ms, cost: costOf(reply) }
      },
    )

  // Which models draw, and how: image models on the images endpoints, language models that draw
  // (Gemini's) on chat completions. The catalog needs no key.
  const catalog = yield* Effect.cachedWithTTL(
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${GATEWAY}models`)
        const data: unknown = field(await res.json(), "data")
        const entries: readonly unknown[] = Array.isArray(data) ? data : []
        return entries
      },
      catch: () => new ModelError({ reason: "Gateway models: unreachable" }),
    }),
    "1 hour",
  )

  const viaImages = (model: string, r: ImageRequest) => {
    const size = r.size ?? (r.aspect === undefined ? undefined : sizeOf(r.aspect))
    // Low looks the same as high on OpenAI's, at about 2¢ a picture.
    const quality = r.quality ?? (model.startsWith("openai/") ? "low" : undefined)
    const body = {
      model,
      prompt: r.prompt,
      n: r.n,
      ...(size !== undefined && { size }),
      ...(quality !== undefined && { quality }),
      ...(r.background !== undefined && { background: r.background }),
      ...(r.images.length > 0 && { images: r.images.map((i) => ({ image_url: dataUrl(i) })) }),
      ...(r.mask && { mask: { image_url: dataUrl(r.mask) } }),
      ...(r.format !== undefined && {
        providerOptions: {
          openai: { outputFormat: r.format },
          blackForestLabs: { outputFormat: r.format },
        },
      }),
    }
    const path = r.images.length > 0 ? "images/edits" : "images/generations"
    return Effect.flatMap(post(path, body, true), ({ reply, ms }) => {
      const data = field(reply, "data")
      const images = (Array.isArray(data) ? data : []).flatMap((d) => {
        const b64 = field(d, "b64_json")
        return typeof b64 === "string" ? [Buffer.from(b64, "base64")] : []
      })
      return images.length > 0
        ? Effect.succeed({ model, images, ms, cost: costOf(reply), usage: tokens(reply) })
        : Effect.fail(new ModelError({ reason: `Gateway ${path}: no picture` }))
    })
  }

  // One picture a call, so `n` calls side by side.
  const viaChat = (model: string, r: ImageRequest) =>
    Effect.gen(function* drawing() {
      if (r.mask) {
        return yield* new ModelError({ reason: `${model} takes no mask` })
      }
      if (r.background === "transparent") {
        return yield* new ModelError({ reason: `${model} draws no transparent background` })
      }
      const imageConfig = geminiShape(r)
      const body = {
        model,
        messages: [
          {
            role: "user",
            content:
              r.images.length === 0
                ? r.prompt
                : [
                    { type: "text", text: r.prompt },
                    ...r.images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } })),
                  ],
          },
        ],
        modalities: ["text", "image"],
        ...(Object.keys(imageConfig).length > 0 && {
          providerOptions: { google: { imageConfig } },
        }),
      }
      const replies = yield* Effect.all(
        Array.from({ length: r.n }, () => post("chat/completions", body, true)),
        { concurrency: "unbounded" },
      )
      const images = replies.flatMap(({ reply }) => {
        const choices = field(reply, "choices")
        const message = field(Array.isArray(choices) ? choices[0] : undefined, "message")
        const drawn = field(message, "images")
        return (Array.isArray(drawn) ? drawn : []).flatMap((d) => {
          const url = field(field(d, "image_url"), "url")
          return typeof url === "string" ? [Buffer.from(url.split(",")[1] ?? "", "base64")] : []
        })
      })
      if (images.length === 0) {
        return yield* new ModelError({ reason: `${model}: no picture` })
      }
      let cost = 0
      const usage = { input: 0, output: 0 }
      for (const { reply } of replies) {
        cost += costOf(reply)
        usage.input += tokens(reply).input
        usage.output += tokens(reply).output
      }
      return { model, images, ms: Math.max(...replies.map((x) => x.ms)), cost, usage }
    })

  const image: ModelsShape["image"] = (r) =>
    Effect.gen(function* drawing() {
      const model =
        r.model ??
        (yield* Effect.isEffect(profile) ? profile : Effect.succeed(profile)).roles.image.id
      const entry: unknown = (yield* catalog).find((m) => field(m, "id") === model)
      const tags = field(entry, "tags")
      if (field(entry, "type") === "image") {
        return yield* viaImages(model, r)
      }
      if (Array.isArray(tags) && tags.includes("image-generation")) {
        return yield* viaChat(model, r)
      }
      return yield* new ModelError({ reason: `No gateway image model ${model}` })
    })

  return { decide, complete, completeOn, embed, image } satisfies ModelsShape
})

export class Models extends Context.Service<Models, ModelsShape>()("switch/Models") {
  static readonly layer = (profile: Profile | Effect.Effect<Profile>) =>
    Layer.effect(Models, make(profile))
}
