// The user's secrets for forms (card numbers and codes, identity and bank numbers), kept in the
// vault. `fill_secret` puts one straight into a field, released by the vault for that one use; the
// `secret` tool lists them, keeps a card the browser has saved (it fills it into a form of the
// browser extension's own, then seals it to the vault), and forgets them. Nothing says what a secret is: a fill is
// reported by how many characters the field then holds, and the field is sealed after it, so
// nothing reads it back and screenshots show dots. Ported from Switchboard's secrets.rs and
// secret.rs.
import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { browserFills, done, nowOn, num, str, whatAt } from "./common.ts"
import type { Done } from "./common.ts"
import { luhn, redactUrl } from "./guard.ts"
import { hostOf } from "./accounts.ts"
import * as keeper from "./keeper.ts"
import { dropSession, session } from "./session.ts"
import { FRAME_FIELD, parseKey, Tab } from "./tab.ts"
import type { Target } from "./ops.ts"

/** The vault's secrets that aren't logins, as the secret tool lists them. */
export const list = async () => {
  const all = await keeper.list({})
  return all.filter((o) => o.kind !== "login")
}

/** Moves an item to the vault's trash. */
export const forget = async (name: string) => {
  await keeper.remove(name)
  return [name]
}

/**
 * The part of a secret a field takes (`slice`, [start, end] by character) in the shape it takes it
 * (`format`, each # its next letter or digit, like ##/## or ###-##-####).
 */
const shaped = (secret: string, args: Json) => {
  const chars = secret.split("")
  let part = chars
  if (Array.isArray(args.slice)) {
    const [from, to] = args.slice.map((x) => num(x) ?? -1)
    if (from === undefined || to === undefined || from < 0 || from >= to || to > chars.length) {
      throw new Error(`slice doesn't fit in its ${chars.length} characters`)
    }
    part = chars.slice(from, to)
  }
  const format = str(args.format)
  if (format === "") {
    return part.join("")
  }
  const next = part.filter((c) => /[\p{L}\p{N}]/u.test(c))
  let at = 0
  let out = ""
  for (const f of format) {
    if (f === "#") {
      const c = next[at]
      if (c === undefined) {
        throw new Error("format has more # than it has letters and digits")
      }
      out += c
      at += 1
    } else {
      out += f
    }
  }
  if (at < next.length) {
    throw new Error("format has fewer # than it has letters and digits")
  }
  return out
}

/**
 * `fill_secret` into a text box inside another site's frame (a card form's secure boxes), at a
 * point: checked by its length after, and sealed. Null when the point isn't on such a frame.
 */
const fillInFrame = async (
  tab: Tab,
  args: Json,
  at: { x: number; y: number },
  what: string,
): Promise<Done | null> => {
  const name = str(args.secret).trim()
  const { url } = await tab.info()
  const frame = await tab.foreignFrame(at)
  if (frame === null) {
    return null
  }
  const released = await keeper.release({ ref: name }, url)
  const [part = ""] = Object.keys(released.values)
  const put = shaped(released.values[part] ?? "", args)
  const { held, world } = await tab.fillInFrame(frame, at, put)
  // A field that spaces a card's digits out holds more characters, but the same digits.
  const digits = put.replaceAll(/\D/gu, "").length
  if (held.length !== put.length && !(digits > 0 && held.digits === digits)) {
    await world(FRAME_FIELD.empty)
    throw new Error(
      `The box in ${what} held ${held.length} characters after filling ${name}, not its ${put.length}: the field cuts or changes it, so I emptied it again (format or slice shapes it)`,
    )
  }
  const now = await tab.info()
  if (hostOf(now.url) !== hostOf(url)) {
    throw new Error(
      `The tab went to ${redactUrl(now.url)} while ${name} was going in, so I stopped there`,
    )
  }
  await world(FRAME_FIELD.seal)
  return done(
    `Filled the box in ${what} with ${name} (${released.title}, ${released.labels[part] ?? part}, ${put.length} characters). Nothing reads it back.\n${await nowOn(tab)}`,
  )
}

/** `fill_secret`: one of the vault's secrets into a field, checked by its length after, and sealed. */
export const fillSecret = async (tab: Tab, args: Json, t: Target): Promise<Done> => {
  const name = str(args.secret).trim()
  if (name === "") {
    throw new Error(
      "fill_secret needs secret: a reference to one of the vault's secrets, like card/main.number (the secret tool lists them)",
    )
  }
  if (!("element" in t)) {
    const inFrame = await fillInFrame(tab, args, t, await whatAt(tab, t))
    if (inFrame === null) {
      throw new Error(
        "fill_secret at a point fills a text box inside another site's frame; name a page's own field by element or match",
      )
    }
    return inFrame
  }
  const n = t.element
  const { url } = await tab.info()
  const fp = tab.known(n)
  const field = await tab.pageJson(`field(${n}, ${fp})`)
  const fieldLine = str(field.line) || "the field"
  const dropdown = field.tag === "select"
  if (field.foreign === true) {
    const inFrame = await fillInFrame(tab, args, await tab.point(n), fieldLine)
    if (inFrame !== null) {
      return inFrame
    }
  }
  if (!dropdown && field.editable !== true) {
    throw new Error(
      `${fieldLine} isn't a field that can be filled: name the text box or dropdown itself`,
    )
  }
  const released = await keeper.release({ ref: name }, url)
  const [part = ""] = Object.keys(released.values)
  const put = shaped(released.values[part] ?? "", args)
  const wanted = put.length
  if (dropdown) {
    await tab.page(`chooseSecret(${n}, ${fp}, ${JSON.stringify(put)})`)
  } else {
    const length = await tab.fillHidden(n, put)
    // A field that spaces a card's digits out holds more characters, but the same digits.
    const digits = put.replaceAll(/\D/gu, "").length
    const held = await tab.pageJson(`held(${n}, ${fp})`)
    if (length !== wanted && !(digits > 0 && num(held.digits) === digits)) {
      await tab.press(parseKey("cmd+a"))
      await tab.press(parseKey("Backspace"))
      throw new Error(
        `${fieldLine} held ${length} characters after filling ${name}, not its ${wanted}: the field cuts or changes it, so I emptied it again (format or slice shapes it)`,
      )
    }
  }
  const now = await tab.info()
  if (hostOf(now.url) !== hostOf(url)) {
    throw new Error(
      `The tab went to ${redactUrl(now.url)} while ${name} was going in, so I stopped there`,
    )
  }
  await tab.page(`seal(${n}, ${fp})`)
  return done(
    `Filled ${fieldLine} with ${name} (${released.title}, ${released.labels[part] ?? part}, ${wanted} characters). It counts as a payment or identity field now, which nothing reads back.\n${await nowOn(tab)}`,
  )
}

/** Where a saved card is filled to be kept: a page with nothing running on it, over HTTPS. */
const BLANK = "https://example.com/"
/** How long the browser may take to fill a saved card (ms). */
const FILLING = 15_000

/** The browser fills a card it has saved into the extension's own form; what it filled, never returned. */
const filledCard = async (tab: Tab, pick: string) => {
  await tab.navigate(BLANK)
  await tab.page("cardForm()")
  const snapshot = await tab.snapshot(50, false, false)
  const numberField = snapshot.elements.find((e) => e.label.includes("Card number"))
  if (!numberField) {
    throw new Error("The card form has no number field")
  }
  const offered = await browserFills(tab, await tab.point(numberField.n), pick)
  if (offered.chose === null) {
    throw new Error("The browser filled nothing")
  }
  const since = Date.now()
  for (;;) {
    const filled = await tab.pageJson("cardFilled()")
    const has = (f: string) => (num(filled[f]) ?? 0) > 0
    // The code comes with the number, or not at all; a moment more lets it land.
    if (has("number") && (has("cvc") || Date.now() - since > FILLING / 2)) {
      break
    }
    if (Date.now() - since > FILLING) {
      throw new Error(
        `The browser chose "${offered.chose}" but left the card's number empty: it may be asking to verify it's the user (Touch ID or the Mac's password)`,
      )
    }
    await Bun.sleep(300)
  }
  return { chose: offered.chose, values: await tab.pageJson("harvest()") }
}

/** The `secret` tool's import: a card the browser has saved, kept in the vault as `name` (its number, code, expiry and name). */
export const importCard = async (pick: string, name: string, label: string | null) => {
  await chrome.reach()
  const id = `secret-import-${crypto.randomUUID().slice(0, 8)}`
  const s = session(id)
  let filled: Awaited<ReturnType<typeof filledCard>>
  try {
    filled = await s.locked(async () => {
      const tab = new Tab(s)
      await tab.ensure()
      try {
        return await filledCard(tab, pick)
      } finally {
        // Whatever happened, the page is emptied and its tab closed.
        await tab.page("wipe()").catch(() => null)
      }
    })
  } finally {
    await chrome.call("release", { session: id, keepOpen: false }, 15_000).catch(() => null)
    dropSession(id)
  }
  const { chose, values } = filled
  const called = label ?? (chose.split(" • ")[0] ?? chose).trim()
  const number = str(values.number).replaceAll(/\D/gu, "")
  if (!luhn(number)) {
    throw new Error("What the browser filled isn't a card number")
  }
  const month = str(values.month).replaceAll(/\D/gu, "").padStart(2, "0")
  const year = str(values.year).replaceAll(/\D/gu, "")
  const fields = [
    { id: "number", label: "Number", type: "card-number", value: number },
    { id: "cvc", label: "Security code", type: "cvc", value: str(values.cvc) },
    { id: "month", label: "Expiry month", type: "month", value: month === "00" ? "" : month },
    { id: "year", label: "Expiry year", type: "year", value: year },
    { id: "holder", label: "Name on card", type: "text", value: str(values.name) },
  ].filter((f) => f.value !== "")
  const saved = await keeper.deposit({ kind: "card", name, title: called, fields })
  const missing = [
    ...(fields.some((f) => f.id === "cvc") ? [] : ["its security code"]),
    ...(fields.some((f) => f.id === "month") && fields.some((f) => f.id === "year")
      ? []
      : ["its expiry"]),
    ...(fields.some((f) => f.id === "holder") ? [] : ["the name on it"]),
  ]
  return `Kept ${called} (ending ${number.slice(-4)}) from the browser's saved cards in the vault as ${saved.name}: ${saved.name}.number, .cvc, .month, .year, .expiry and .holder. fill_secret puts one in a field.${missing.length > 0 ? ` The browser didn't fill ${missing.join(" or ")}.` : ""}`
}
