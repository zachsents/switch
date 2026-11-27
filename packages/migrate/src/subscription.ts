// The models the memory write path asks, on the Claude subscription through `claude -p` rather
// than the gateway: one call per question, turn by turn across the Claude logins the accounts layer
// knows, with what it costs at list price counted against a budget. No embeddings: recall falls back
// to full-text search.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { discover, hostsOf, localMachine } from "@switch/agent"
import type { Host } from "@switch/agent"
import { CoreConfig } from "@switch/core"
import { Models, ModelError } from "@switch/models"
import type { ModelsShape } from "@switch/models"
import type { Database } from "bun:sqlite"
import { Brain, defineRead, EventId } from "@switch/brain"
import { Effect, Layer, Ref } from "effect"

import { MigrateSpent } from "./events.ts"

// Anything that would bill an API key, or tie the child to this process's own session.
const DROP =
  /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR|AI_AGENT|ANTHROPIC_|AI_GATEWAY_|VERCEL_OIDC)/u

const envFor = (host: Host, token: boolean) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !DROP.test(k)) {
      out[k] = v
    }
  }
  if (host.configDir !== undefined) {
    out.CLAUDE_CONFIG_DIR = host.configDir
  }
  if (token) {
    out.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3"
  }
  return out
}

const parseJson: (text: string) => unknown = JSON.parse

const field = (v: unknown, k: string): unknown =>
  typeof v === "object" && v !== null
    ? Object.entries(v).find(([key]) => key === k)?.[1]
    : undefined

/** The first JSON object in a reply, fenced or not. */
const objectIn = (text: string): unknown => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    return null
  }
  try {
    return parseJson(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export interface Spend {
  readonly calls: number
  readonly usd: number
  readonly errors: number
}

/** What a ledger has spent so far, across every run: the brain keeps each call. */
export const spentOn = (db: Database, ledger: string): Spend =>
  db
    .query<Spend, [string, string]>(
      `SELECT count(*) AS calls, coalesce(sum(json_extract(payload, '$.usd')), 0) AS usd,
         coalesce(sum(json_extract(payload, '$.failed')), 0) AS errors
       FROM events WHERE type = ? AND json_extract(payload, '$.ledger') = ?`,
    )
    .get(MigrateSpent.type, ledger) ?? { calls: 0, usd: 0, errors: 0 }

export const spentRead = defineRead("migrate/subscription/spent", (db, ledger: string) =>
  spentOn(db, ledger),
)

/** `budgetUsd` caps the ledger's total, this run's calls and every earlier run's together. */
export const subscriptionModels = (model: string, budgetUsd: number, ledger: string) =>
  Layer.effect(
    Models,
    Effect.gen(function* making() {
      const brain = yield* Brain
      const spend = yield* Ref.make(yield* brain.read(spentRead, ledger))
      const config = yield* CoreConfig
      const machine = localMachine(mkdtempSync(path.join(tmpdir(), "switch-distill-")))
      const logins = config.logins.length > 0 ? config.logins : discover()
      const hosts = hostsOf(logins, machine).filter((h) => h.provider === "claude")
      if (hosts.length === 0) {
        return yield* Effect.die(new Error("No Claude login"))
      }
      const turn = yield* Ref.make(0)

      const run = (system: string, prompt: string) =>
        Effect.gen(function* running() {
          const used = yield* Ref.get(spend)
          if (used.usd >= budgetUsd) {
            return yield* Effect.fail(new ModelError({ reason: `Budget of $${budgetUsd} spent` }))
          }
          const i = yield* Ref.getAndUpdate(turn, (n) => n + 1)
          const host = hosts[i % hosts.length] ?? hosts[0]
          if (host === undefined) {
            return yield* Effect.fail(new ModelError({ reason: "No Claude login" }))
          }
          const token = host.token === undefined ? null : yield* host.token
          const proc = yield* machine.spawn(
            [
              "claude",
              "-p",
              "--model",
              model,
              "--system-prompt",
              system,
              "--tools",
              "",
              "--setting-sources",
              "",
              "--strict-mcp-config",
              "--no-session-persistence",
              "--output-format",
              "json",
            ],
            {
              cwd: tmpdir(),
              env: envFor(host, token !== null),
              ...(token === null ? {} : { secret: token.secret }),
            },
          )
          proc.write(prompt)
          proc.end()
          const start = performance.now()
          const [out, err, code] = yield* Effect.all(
            [
              Effect.promise(async () => await new Response(proc.stdout).text()),
              Effect.promise(async () => await new Response(proc.stderr).text()),
              Effect.promise(async () => await proc.exited),
            ],
            { concurrency: 3 },
          )
          const reply = objectIn(out)
          const cost = Number(field(reply, "total_cost_usd") ?? 0)
          const failed = code !== 0 || field(reply, "is_error") === true
          const usd = Number.isFinite(cost) ? cost : 0
          yield* Ref.update(spend, (s) => ({
            calls: s.calls + 1,
            usd: s.usd + usd,
            errors: s.errors + (failed ? 1 : 0),
          }))
          const spent: typeof MigrateSpent.payload.Type = { ledger, usd, login: host.id, failed }
          yield* Effect.orDie(
            brain.ingest([
              {
                id: EventId.make(`spent:${crypto.randomUUID()}`),
                type: MigrateSpent.type,
                source: "migrate",
                payload: spent,
              },
            ]),
          )
          if (failed) {
            return yield* Effect.fail(
              new ModelError({
                reason: `claude -p on ${host.id}: ${(typeof field(reply, "result") === "string" ? String(field(reply, "result")) : err).slice(0, 300)}`,
              }),
            )
          }
          const text = field(reply, "result")
          return { text: typeof text === "string" ? text : "", ms: performance.now() - start, cost }
        })

      const shape: ModelsShape = {
        // Every role on `claude -p`, with the model it was given.
        routed: () => Effect.succeed({ provider: "claude-code", id: model }),
        keyed: Effect.succeed(false),
        complete: (_role, system, prompt) => run(system, prompt),
        completeOn: (_model, system, prompt) => run(system, prompt),
        // A decision model's yes/no questions, asked of the model in one call as probabilities.
        decide: (input, questions) =>
          Effect.gen(function* deciding() {
            const names = Object.keys(questions)
            const asked = names
              .map((n) => {
                const q = questions[n]
                const choices = (q?.choices ?? []).map((c) => `${c.value}: ${c.description ?? ""}`)
                return `${n}: ${q?.instructions ?? ""}\n  ${choices.join("\n  ")}`
              })
              .join("\n")
            const c = yield* run(
              `${input.stable}\n\nAnswer every question with the probability (0 to 1) that its first choice is right. Reply with only a JSON object from question name to probability.`,
              `${input.item}\n\nQuestions:\n${asked}`,
            )
            const got = objectIn(c.text)
            const answers = Object.fromEntries(
              names.map((n) => {
                const p = Math.min(1, Math.max(0, Number(field(got, n) ?? 0) || 0))
                const [first, second] = (questions[n]?.choices ?? []).map((x) => x.value)
                const probabilities = { [first ?? "yes"]: p, [second ?? "no"]: 1 - p }
                return [
                  n,
                  { choice: p >= 0.5 ? (first ?? "yes") : (second ?? "no"), probabilities },
                ]
              }),
            )
            return { answers, ms: c.ms, cost: c.cost }
          }),
        embed: () => Effect.fail(new ModelError({ reason: "No embeddings off the gateway" })),
        image: () => Effect.fail(new ModelError({ reason: "No pictures off the gateway" })),
      }
      return shape
    }),
  )
