// What the page script finds on a local fixture: elements outside the viewport, or across its edge,
// count as much as ones in it, and acting on one scrolls it into view first.
import { expect, test } from "bun:test"

import { probe } from "./browser.ts"

/** The numbered element whose line has these words, as `collect` lists it. */
const FIND = `
  const find = (words) =>
    __switch.collect({ limit: 2000, outline: false }).elements.find((e) => e.label.includes(words)) ?? null
`

test("an element across the bottom of the viewport is found", async () => {
  const got = await probe(
    "checkout.html",
    `${FIND}
    const r = document.querySelector("#place").getBoundingClientRect()
    return { scrollY, across: r.top < innerHeight && r.bottom > innerHeight, found: find("Place Order") }`,
  )
  expect(got).toMatchObject({ scrollY: 0, across: true, found: { label: "Place Order $9.99" } })
})

test("an element below the viewport is found, and one covered in view is not", async () => {
  const got = await probe(
    "checkout.html",
    `${FIND}
    const below = find("Contact Us")
    return { below: below && below.offscreen.startsWith("below"), covered: find("Hidden behind") }`,
  )
  expect(got).toEqual({ below: true, covered: null })
})

test("acting on an element scrolls it into view first", async () => {
  const got = await probe(
    "checkout.html",
    `${FIND}
    return ["Place Order", "Contact Us"].map((words) => {
      const at = __switch.point(find(words).n)
      return {
        scrolled: at.scrolled,
        inView: at.y > 0 && at.y < innerHeight,
        hits: document.elementFromPoint(at.x, at.y)?.closest("button")?.innerText,
      }
    })`,
  )
  expect(got).toMatchObject([
    { scrolled: true, inView: true, hits: "Place Order $9.99" },
    { scrolled: true, inView: true, hits: "Contact Us" },
  ])
})
