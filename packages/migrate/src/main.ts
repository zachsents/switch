// `bun run migrate <command>`:
//   export-memories --brain <file> --out <jsonl>   a brain's distilled memories and cores
//   import-memories --brain <file> --file <jsonl>  into a brain that staged the same, marked consumed
//   --source <url> picks the Switchboard core; else the one `sb` is set up for.
//   inventory               every kind of Switchboard record, counted, and what it becomes
//   run --brain <file> [--from seq]   import what's new since the last run (all of it, the first
//                           time), or everything after seq
//   verify --brain <file>   what the brain holds of it, and conversations read back in order
//   distill --brain <file> [--limit n] [--budget usd] [--ledger name] [--per-day] [--concurrency n]
//           [--no-cores]   --per-day gives each day its own ledger, so --budget is a daily cap
//                           staged memories through the memory write path, on the subscription
//   serve --brain <file> [--port n]      the file to clients, read-only in spirit: no agent runs
//   wake-rules --brain <file>   Switchboard's live wake kernels and triggers, as rules triage reads
//   resolve-when --brain <file> open imported asks get their original's resolve_when back
import path from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { Blobs, Brain } from "@switch/brain"
import { CoreConfig } from "@switch/core"
import type { Models } from "@switch/models"
import { Effect, Layer } from "effect"

import { serveLayer } from "./serve.ts"
import { exportMemories, importMemories } from "./transfer.ts"
import { spentRead, subscriptionModels } from "./subscription.ts"

import { distill } from "./distill.ts"
import { inventory, table } from "./inventory.ts"
import { brainConfig, run } from "./run.ts"
import { Switchboard } from "./source.ts"
import { size, spotChecks, typesOut } from "./verify.ts"
import { resolveWhens } from "./resolve-when.ts"
import { wakeRules } from "./wake-rules.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const [command] = args
const brainPath = flag("brain")

const print = (s: string) =>
  Effect.sync(() => {
    console.log(s)
  })

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MB`

type Program = Effect.Effect<void, unknown, Brain | Blobs | Switchboard | Models>

type Command =
  | "inventory"
  | "run"
  | "verify"
  | "distill"
  | "serve"
  | "export-memories"
  | "import-memories"
  | "wake-rules"
  | "resolve-when"

const programs: Record<Command, () => Program> = {
  inventory: () => inventory.pipe(Effect.flatMap((lines) => print(table(lines)))),
  run: () =>
    Effect.gen(function* running() {
      const from = flag("from")
      const r = yield* run(brainPath ?? "", from === undefined ? undefined : Number(from))
      const rows = [...r.counts.in.entries()].toSorted((a, b) => b[1] - a[1])
      yield* print("| Switchboard | In | Switch | Out |\n| --- | ---: | --- | ---: |")
      for (const [key, n] of rows) {
        const out = [...(r.counts.out.get(key) ?? new Map<string, number>()).entries()]
        yield* print(
          `| ${key} | ${n} | ${out.map(([t]) => t).join(", ") || "none"} | ${out.map(([, m]) => m).join(" + ") || 0} |`,
        )
      }
      const secs = r.ms / 1000
      yield* print(
        `\nseq ${r.from} → ${r.through}: ${r.records} records, ${r.events} events in ${secs.toFixed(0)} s (${Math.round(r.records / Math.max(secs, 0.001))} records/s); brain ${mb(size(brainPath ?? ""))}`,
      )
    }),
  verify: () =>
    Effect.gen(function* verifying() {
      for (const t of yield* typesOut) {
        yield* print(`${t.type}\t${t.n}`)
      }
      yield* print(`brain ${mb(size(brainPath ?? ""))}\n`)
      for (const c of yield* spotChecks(Number(flag("checks") ?? "4"))) {
        yield* print(
          `${c.space} · ${c.title} (${c.work}): ${c.found}/${c.expected} lines, ${c.inOrder ? "in order" : "OUT OF ORDER"}\n  ${c.sample.join("\n  ")}`,
        )
      }
    }),
  serve: () => Layer.launch(serveLayer(Number(flag("port") ?? "4899"))),
  "export-memories": () =>
    exportMemories(flag("out") ?? "memories.jsonl").pipe(
      Effect.flatMap((n) => print(`${n} lines`)),
    ),
  "import-memories": () =>
    importMemories(flag("file") ?? "memories.jsonl").pipe(
      Effect.flatMap((r) =>
        print(
          `${r.lines} lines: ${r.written} events written, ${r.matched} of ${r.outcomes} staged memories marked`,
        ),
      ),
    ),
  "wake-rules": () =>
    wakeRules.pipe(Effect.flatMap((names) => print(`${names.length} rules: ${names.join(", ")}`))),
  "resolve-when": () => resolveWhens.pipe(Effect.flatMap((said) => print(said.join("\n")))),
  distill: () =>
    Effect.gen(function* distilling() {
      const r = yield* distill(
        Number(flag("limit") ?? "100000"),
        Number(flag("concurrency") ?? "8"),
        !args.includes("--no-cores"),
      )
      const brainNow = yield* Brain
      const spent = yield* brainNow.read(spentRead, ledger)
      yield* print(
        `${r.taken} taken: ${r.kept} kept, ${r.merged} merged, ${r.skipped} skipped; ${spent.calls} calls on ledger ${ledger}, $${spent.usd.toFixed(2)} of $${budget}, ${r.errors.length} errors`,
      )
      for (const c of r.cores) {
        yield* print(`core ${c.scope}: ${c.tokens} tokens`)
      }
      for (const e of new Set(r.errors)) {
        yield* print(`error: ${e.slice(0, 300)}`)
      }
    }),
}

const isCommand = (c: string | undefined): c is Command =>
  c !== undefined && Object.keys(programs).includes(c)

if (!isCommand(command)) {
  console.error(`bun run migrate ${Object.keys(programs).join(" | ")}  [--brain <file>]`)
  process.exit(1)
}

if (command !== "inventory" && brainPath === undefined) {
  console.error("--brain <file> is required")
  process.exit(1)
}

// The inventory reads no brain; the rest open the file with everything the core knows.
const brain = Brain.layer(brainConfig(brainPath ?? ":memory:"))
// The memory write path's gate and writer, on the subscription, never the gateway.
const ledger = args.includes("--per-day")
  ? `${flag("ledger") ?? "distill"}:${Temporal.Now.plainDateISO().toString()}`
  : (flag("ledger") ?? "distill")
const budget = Number(flag("budget") ?? "80")
// One brain for the program and the models' ledger.
const brainAndModels = subscriptionModels(flag("model") ?? "sonnet", budget, ledger).pipe(
  Layer.provide(CoreConfig.layer),
  Layer.orDie,
  Layer.provideMerge(brain),
)

// Files beside the brain file, as the core keeps them.
const blobs = Blobs.layer({
  dir: path.join(path.dirname(path.resolve(brainPath ?? ".")), "blobs"),
}).pipe(Layer.provideMerge(brainAndModels))

BunRuntime.runMain(
  programs[command]().pipe(Effect.provide(Layer.merge(Switchboard.layer(flag("source")), blobs))),
)
