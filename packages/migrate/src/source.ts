// Switchboard's core, read-only, through its own client (`sb`), which holds the credential: this
// process never sees a token. Queries over the log are paged by seq, and a page the core finds too
// big to read or keep is split in two until it fits.
import { Context, Effect, Layer } from "effect"

import { SourceError } from "./errors.ts"

export { SourceError } from "./errors.ts"

export interface Ref {
  readonly id: string
  readonly rel: string
}

export type Body = Readonly<Record<string, unknown>>

/** One record of Switchboard's log. */
export interface SbRecord {
  readonly id: string
  readonly seq: number
  readonly at: number
  readonly stream: string
  readonly kind: string
  readonly source: string
  readonly about: readonly string[]
  readonly refs: readonly Ref[]
  readonly body: Body
}

export const isObject = (v: unknown): v is Body =>
  typeof v === "object" && v !== null && !Array.isArray(v)
export const obj = (v: unknown): Body => (isObject(v) ? v : {})
export const str = (v: unknown): string => (typeof v === "string" ? v : "")
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

const toRecord = (raw: unknown): SbRecord => {
  const r = obj(raw)
  const refs = Array.isArray(r.refs)
    ? r.refs.map(obj).map((x) => ({ id: str(x.id), rel: str(x.rel) }))
    : []
  return {
    id: str(r.id),
    seq: num(r.seq),
    at: num(r.at),
    stream: str(r.stream),
    kind: str(r.kind),
    source: str(r.source),
    about: strs(r.about),
    refs,
    body: obj(r.body),
  }
}

export const refOf = (r: SbRecord, rel: string): string | null =>
  r.refs.find((x) => x.rel === rel)?.id ?? null

const parseJson: (text: string) => unknown = JSON.parse

const sb = (url: string | undefined, args: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      // `sb` finds the core and its credential in its own config; a given URL overrides the core.
      const env = url === undefined ? process.env : { ...process.env, SB_URL: url }
      const proc = Bun.spawn(["sb", ...args], { stdout: "pipe", stderr: "pipe", env })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) {
        throw new Error(err.trim() === "" ? `sb exited with ${code}` : err.trim())
      }
      return parseJson(out)
    },
    catch: (e) => new SourceError({ reason: e instanceof Error ? e.message : String(e) }),
  })

/** Too much of the log for one query: the core's read or keep budget. */
const tooBig = (e: SourceError) => /reads more than|keeps more than|\b\d+ MB\b/u.test(e.reason)

export interface StreamInfo {
  readonly stream: string
  readonly records: number
  readonly firstAt: number
  readonly lastAt: number
  readonly lastSeq: number
}

export interface SwitchboardShape {
  /** Rows of a query, as objects. */
  readonly query: (q: string) => Effect.Effect<readonly Body[], SourceError>
  /** A read model of `sb view`. */
  readonly view: (name: string) => Effect.Effect<unknown, SourceError>
  /** Records matching `filter` with seq in (from, to], oldest first. */
  readonly records: (
    filter: string,
    from: number,
    to: number,
  ) => Effect.Effect<SbRecord[], SourceError>
  readonly streams: Effect.Effect<readonly StreamInfo[], SourceError>
  /** The log's last seq. */
  readonly head: Effect.Effect<number, SourceError>
  /** Records by id, in batches. */
  readonly byId: (ids: readonly string[]) => Effect.Effect<SbRecord[], SourceError>
  /** A blob's bytes, by its id (`sha256:<hex>`), checked against it. */
  readonly blob: (id: string) => Effect.Effect<Uint8Array, SourceError>
}

const quote = (s: string) => JSON.stringify(s)

export const chunks = <A>(xs: readonly A[], n: number): A[][] => {
  const out: A[][] = []
  for (let i = 0; i < xs.length; i += n) {
    out.push(xs.slice(i, i + n))
  }
  return out
}

/** The most rows the core answers a query with; more are cut off without a word. */
const MAX_ROWS = 10_000

const make = (url: string | undefined): SwitchboardShape => {
  const query = (q: string) =>
    sb(url, ["query", q]).pipe(
      Effect.map((d) => {
        const { rows } = obj(d)
        return Array.isArray(rows) ? rows.map(obj) : []
      }),
    )

  // Halves a page the core can't answer whole: over its budget, or at its row cap.
  const records = (
    filter: string,
    from: number,
    to: number,
  ): Effect.Effect<SbRecord[], SourceError> => {
    const halves = Effect.suspend(() => {
      const mid = from + Math.floor((to - from) / 2)
      return Effect.map(
        Effect.all([records(filter, from, mid), records(filter, mid, to)]),
        ([a, b]) => [...a, ...b],
      )
    })
    return query(`records | where ${filter} and seq > ${from} and seq <= ${to}`).pipe(
      Effect.catchIf(
        (e) => tooBig(e) && to - from > 1,
        () => Effect.succeed(null),
      ),
      Effect.flatMap((rows) =>
        rows === null || (rows.length >= MAX_ROWS && to - from > 1)
          ? halves
          : Effect.succeed(rows.map(toRecord).toSorted((a, b) => a.seq - b.seq)),
      ),
    )
  }

  const streams = sb(url, ["view", "streams"]).pipe(
    Effect.map((d) =>
      (Array.isArray(d) ? d : []).map(obj).map((s) => ({
        stream: str(s.stream),
        records: num(s.records),
        firstAt: num(s.first_at),
        lastAt: num(s.last_at),
        lastSeq: num(s.last_seq),
      })),
    ),
  )

  const byId = (ids: readonly string[]) =>
    Effect.map(
      Effect.forEach(
        chunks(ids, 200),
        (chunk) => query(`records | where id in (${chunk.map(quote).join(", ")})`),
        { concurrency: 4 },
      ),
      (pages) => pages.flat().map(toRecord),
    )

  const blob = (id: string) =>
    Effect.tryPromise({
      try: async () => {
        const env = url === undefined ? process.env : { ...process.env, SB_URL: url }
        const proc = Bun.spawn(["sb", "blob", "get", id], { stdout: "pipe", stderr: "pipe", env })
        const [bytes, err, code] = await Promise.all([
          new Response(proc.stdout).bytes(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (code !== 0) {
          throw new Error(err.trim() === "" ? `sb exited with ${code}` : err.trim())
        }
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        if (`sha256:${hash}` !== id) {
          throw new Error(`${id} came back as ${hash}`)
        }
        return bytes
      },
      catch: (e) => new SourceError({ reason: e instanceof Error ? e.message : String(e) }),
    })

  return {
    query,
    blob,
    view: (name) => sb(url, ["view", name]),
    records,
    streams,
    head: streams.pipe(Effect.map((all) => Math.max(0, ...all.map((s) => s.lastSeq)))),
    byId,
  }
}

export class Switchboard extends Context.Service<Switchboard, SwitchboardShape>()(
  "switch/migrate/Switchboard",
) {
  /** `url` is the core's; without it, the one `sb` is set up for. */
  static readonly layer = (url?: string) => Layer.sync(Switchboard, () => make(url))
}

export { quote }
