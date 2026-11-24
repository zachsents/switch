// How autofill picks one of the browser's suggestions: the helper's own Swift, built once into a
// temporary folder and asked with its match op, so no browser and no saved card is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { source } from "../src/autofill-source.ts"

const dir = mkdtempSync(path.join(tmpdir(), "autofill-test-"))
const helper = path.join(dir, "autofill")

beforeAll(async () => {
  const src = path.join(dir, "autofill.swift")
  writeFileSync(src, source)
  const proc = Bun.spawn(["swiftc", src, "-o", helper], { stdout: "ignore", stderr: "pipe" })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    throw new Error(err)
  }
}, 120_000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const match = async (pick: string, labels: readonly string[]) => {
  const proc = Bun.spawn([helper, "match", JSON.stringify({ pick, labels })], { stdout: "pipe" })
  const [code, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  const value: unknown = JSON.parse(text)
  const said = typeof value === "object" && value !== null ? value : {}
  return {
    ok: code === 0,
    chose: "chose" in said ? String(said.chose) : null,
    error: "error" in said ? String(said.error) : null,
  }
}

const CARDS = [
  "Visa Chase Sapphire Preferred Visa ••1234",
  "Mastercard Freedom Unlimited Mastercard ••••9876",
  "Amex Gold Card · 3005",
] as const

describe("autofill pick", () => {
  test("words of a card's name and its last four, in any order or case", async () => {
    for (const pick of ["Sapphire 1234", "sapphire 1234", "1234 SAPPHIRE", "Chase 1234 Sapphire"]) {
      expect(await match(pick, CARDS)).toMatchObject({ ok: true, chose: CARDS[0] })
    }
  })

  test("bullets, dots and repeated words in the pick or the label", async () => {
    expect(await match("Preferred Visa Visa ••1234", CARDS)).toMatchObject({ chose: CARDS[0] })
    expect(await match("Freedom … 9876.", CARDS)).toMatchObject({ chose: CARDS[1] })
    expect(await match("gold·3005", CARDS)).toMatchObject({ chose: CARDS[2] })
  })

  test("last four anywhere in the label", async () => {
    expect(await match("9876", CARDS)).toMatchObject({ ok: true, chose: CARDS[1] })
    expect(await match("Visa 4321", ["Visa x4321", "Visa ••8765"])).toMatchObject({
      chose: "Visa x4321",
    })
  })

  test("still a saved sign-in's username by part of it", async () => {
    expect(await match("someone", ["someone@example.com", "other@example.com"])).toMatchObject({
      chose: "someone@example.com",
    })
  })

  test("more than one match fails, listing the labels", async () => {
    const got = await match("Visa", [...CARDS, "Visa Debit ••5555"])
    expect(got.ok).toBe(false)
    expect(got.error).toContain("More than one")
    expect(got.error).toContain(CARDS[0])
    expect(got.error).toContain("Visa Debit ••5555")
  })

  test("no match fails, listing labels and last fours, never a whole number", async () => {
    const got = await match("Discover 1234", ["Visa 4111111111111111", ...CARDS])
    expect(got.ok).toBe(false)
    expect(got.error).toContain("None")
    expect(got.error).toContain(CARDS[1])
    expect(got.error).toContain("1111")
    expect(got.error).not.toContain("4111111111111111")
  })
})
