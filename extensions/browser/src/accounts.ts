// Logins' plain parts the browser checks before the vault is asked: what a site is, whether a page
// is one of a login's sites, and an authenticator key read off a setup page (kept in the vault as
// its otpauth link). The vault (keeper.ts) keeps every secret. Ported from Switchboard's
// accounts.rs.

/** An authenticator key (RFC 6238), as an `otpauth://` link carries it. */
export interface Totp {
  /** The key, base32 as sites show it, without spaces. */
  secret: string
  digits: number
  period: number
  /** SHA1 (nearly every site), SHA256 or SHA512. */
  algorithm: string
}

/** How long a key shown as text usually is, in base32 letters. */
const KEY_LENGTHS = new Set([16, 24, 26, 32, 52, 64, 103])

/** Words a page puts around a key it shows, spelled only in base32's letters. */
const COMMON_WORDS = new Set(
  (
    "a an as at be by do go if in is it me my no of on or so to up us we the and for you key app can use add not are all any new now our get set see one " +
    "two via its has but how tap this that then than code with your here next copy type scan into from when once done save back also only just what them " +
    "they will open more page keys need make sure have time show find both same must turn box"
  ).split(" "),
)

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Base32 (RFC 4648) in any case, without padding. */
const base32 = (text: string) => {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const c of text.toUpperCase().replaceAll(/[ =-]/gu, "")) {
    const value = BASE32.indexOf(c)
    if (value === -1) {
      throw new Error("That key isn't base32 (A-Z and 2-7)")
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

const checked = (t: Totp): Totp => {
  const secret = t.secret.replaceAll(/[ =-]/gu, "").toUpperCase()
  if (base32(secret).length < 10) {
    throw new Error(
      "That key is too short to be an authenticator key: read the whole key, or the otpauth link",
    )
  }
  const sane = t.digits >= 6 && t.digits <= 8 && t.period >= 10 && t.period <= 120
  if (!sane || !["SHA1", "SHA256", "SHA512"].includes(t.algorithm)) {
    throw new Error("That key asks for codes authenticators don't make")
  }
  return { ...t, secret }
}

const isBase32 = (w: string) => w !== "" && /^[A-Za-z2-7]+$/u.test(w)

/** A word's case: 1 upper, 2 lower, 0 neither (digits alone), null both (no part of a key). */
const caseOf = (w: string) => {
  const upper = /[A-Z]/u.test(w)
  const lower = /[a-z]/u.test(w)
  if (upper && lower) {
    return null
  }
  if (upper) {
    return 1
  }
  return lower ? 2 : 0
}

/** Every run of base32 in some words that could be a key shown as text (Google shows it in groups of four). */
const runs = (text: string) => {
  const all: string[][] = []
  let run: string[] = []
  let runCase = 0
  let open = false
  const close = () => {
    all.push(run)
    run = []
  }
  for (const token of text.split(/\s+/u).filter(Boolean)) {
    const core = token.replaceAll(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")
    const led = !token.startsWith(core)
    const trailed = !token.endsWith(core)
    const word = core.replaceAll("-", "")
    const wordCase = isBase32(word) ? caseOf(word) : null
    if (wordCase === null) {
      close()
      open = false
      continue
    }
    if (word.length > 4) {
      close()
      all.push([word])
      open = false
      continue
    }
    if (!(open && !led && (runCase === 0 || wordCase === 0 || runCase === wordCase))) {
      close()
      runCase = 0
    }
    runCase = Math.max(runCase, wordCase)
    run.push(word)
    open = !trailed && word.length >= 4
    if (!open) {
      close()
    }
  }
  close()
  return all
    .filter((r) => r.length > 0)
    .map((r) => {
      let front = 0
      let back = r.length
      while (back - front > 1 && COMMON_WORDS.has((r[front] ?? "").toLowerCase())) {
        front += 1
      }
      while (back - front > 1 && COMMON_WORDS.has((r[back - 1] ?? "").toLowerCase())) {
        back -= 1
      }
      return r.slice(front, back).join("")
    })
}

/**
 * A key from what a two-factor setup page shows: an `otpauth://totp/…` link, or the key itself.
 * `needsDigit`: a key shown as text must have a digit, so no run of ordinary words is taken for one.
 */
export const parseTotp = (raw: string, needsDigit = false): Totp => {
  const text = raw.trim()
  const at = text.indexOf("otpauth://")
  if (at !== -1) {
    const link = text.slice(at).split(/[\s"']/u)[0] ?? ""
    const rest = link.slice("otpauth://".length)
    const [kind = "", query = ""] = rest.split("?")
    if (!kind.toLowerCase().startsWith("totp/")) {
      throw new Error("That's a counter-based (HOTP) key, not a time-based one")
    }
    const params = new URLSearchParams(query)
    return checked({
      secret: params.get("secret") ?? "",
      digits: Number(params.get("digits") ?? 6),
      period: Number(params.get("period") ?? 30),
      algorithm: (params.get("algorithm") ?? "SHA1").toUpperCase(),
    })
  }
  const [best] = runs(text)
    .filter((k) => k.length >= 16 && (!needsDigit || /\d/u.test(k)))
    .toSorted(
      (a, b) =>
        Number(KEY_LENGTHS.has(b.length)) - Number(KEY_LENGTHS.has(a.length)) ||
        b.length - a.length,
    )
  if (best === undefined) {
    throw new Error(
      `There's no authenticator key in that text: point at the key itself ("Can't scan it?" shows it), or the otpauth link`,
    )
  }
  return checked({ secret: best, digits: 6, period: 30, algorithm: "SHA1" })
}

/** The key as the vault keeps it: an otpauth link. */
export const otpauth = (t: Totp) =>
  `otpauth://totp/?secret=${t.secret}&digits=${t.digits}&period=${t.period}&algorithm=${t.algorithm}`

/** A name an account can have: short, lowercase, no spaces. */
export const checkName = (name: string) => {
  if (!/^[a-z0-9][a-z0-9._@-]{0,63}$/u.test(name)) {
    throw new Error(
      `An account's name is lowercase letters, digits and - _ . @ (at most 64), like shop-admin, not ${JSON.stringify(name)}`,
    )
  }
}

/** The host of a URL, lowercase, without its port. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** A site as it's kept: a host or domain, lowercase, without a scheme, path or port. */
export const site = (text: string) => {
  const host = (hostOf(text) || text.trim().replace(/^\*\./u, "").toLowerCase()).replace(
    /^www\./u,
    "",
  )
  if (host === "" || !(host.includes(".") || host === "localhost") || /[/ *]/u.test(host)) {
    throw new Error(`${JSON.stringify(text)} isn't a site: give a host or domain like example.com`)
  }
  return host
}

/** Whether something kept for `sites` may be filled on the page at `url`: one of them, over HTTPS. */
export const allows = (sites: readonly string[], url: string, what = "that login") => {
  const host = hostOf(url)
  const local = host === "localhost" || host === "127.0.0.1"
  if (!url.startsWith("https://") && !(local && url.startsWith("http://"))) {
    throw new Error(`The tab isn't on an HTTPS page: ${what} is only filled on a secure page`)
  }
  if (!sites.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error(
      `The tab is on ${host}, and ${what} is kept for ${sites.length === 0 ? "no site yet" : sites.join(", ")}: it's never filled anywhere else`,
    )
  }
}
