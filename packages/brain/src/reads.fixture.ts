// Reads the readers test asks for: loaded by the test and by its reader thread alike.
import { defineRead } from "./reads.ts"

export const countRead = defineRead(
  "test/count",
  (db) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM t").get()?.n ?? 0,
)

export const echoRead = defineRead(
  "test/echo",
  (_db, value: { readonly words: readonly string[]; readonly at: Date }) => ({
    words: new Set(value.words),
    at: value.at,
  }),
)

export const failRead = defineRead("test/fail", () => {
  throw new Error("no such thing")
})

/** About `ms` of a busy reader: a recursive count it can't answer from an index. */
export const slowRead = defineRead("test/slow", (db, ms: number) => {
  const until = performance.now() + ms
  let rounds = 0
  while (performance.now() < until) {
    db.query(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000) SELECT count(*) FROM c",
    ).get()
    rounds += 1
  }
  return rounds
})

/** A read that tries to write: a reader's connection refuses it. */
export const writeRead = defineRead("test/write", (db) => {
  db.run("INSERT INTO t VALUES (5)")
  return 0
})
