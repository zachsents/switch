import { Database } from "bun:sqlite"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { makeReaders } from "./readers.ts"
import type { Readers } from "./readers.ts"
import { defineRead } from "./reads.ts"
import { countRead, echoRead, failRead, slowRead, writeRead } from "./reads.fixture.ts"

const dir = mkdtempSync(path.join(tmpdir(), "readers-"))
const file = path.join(dir, "brain.db")
/** A reader for this test, from its own entry beside it. */
const startReader = () => new Worker(new URL("reader.fixture.js", import.meta.url))
let writer: Database
let readers: Readers

beforeAll(async () => {
  writer = new Database(file, { create: true, strict: true })
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("CREATE TABLE t (x INTEGER)")
  writer.run("INSERT INTO t VALUES (1), (2), (3)")
  readers = makeReaders(file, startReader, 2)
  await readers.ready
})

afterAll(() => {
  readers.close()
  writer.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a read runs in a reader and answers", async () => {
  expect(await readers.run(countRead, [])).toBe(3)
})

test("a reader sees every commit made before the read was asked", async () => {
  writer.run("INSERT INTO t VALUES (4)")
  expect(await readers.run(countRead, [])).toBe(4)
})

test("arguments and answers cross as structured clones", async () => {
  const at = new Date(1_795_000_000_000)
  const out = await readers.run(echoRead, [{ words: ["a", "b", "a"], at }])
  expect(out.words).toEqual(new Set(["a", "b"]))
  expect(out.at.getTime()).toBe(at.getTime())
})

/** Why `p` failed, or null when it didn't. */
const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

test("a read's error fails its caller, named", async () => {
  expect(await failure(readers.run(failRead, []))).toBe("test/fail: no such thing")
})

test("a slow read holds its reader, not this thread", async () => {
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 50)
  const t0 = performance.now()
  const [rounds, count] = await Promise.all([
    readers.run(slowRead, [800]),
    readers.run(countRead, []),
  ])
  clearInterval(timer)
  expect(rounds).toBeGreaterThan(0)
  expect(count).toBe(4)
  expect(performance.now() - t0).toBeGreaterThanOrEqual(800)
  // This thread kept turning through the read: about 16 ticks in 800 ms, never one.
  expect(ticks).toBeGreaterThan(8)
})

test("the reader's connection can't write", async () => {
  expect(await failure(readers.run(writeRead, []))).toBe(
    "test/write: attempt to write a readonly database",
  )
  expect(await readers.run(countRead, [])).toBe(4)
})

test("readers that know other reads than this thread are refused at start", async () => {
  defineRead("test/only-here", () => 0)
  const other = makeReaders(file, startReader, 1)
  try {
    expect(await failure(other.ready)).toContain("missing test/only-here")
  } finally {
    other.close()
  }
})
