// A field's value as it's kept: checked and normalized by its type (a card number's digits, an
// expiry as MM/YY, an authenticator key as its otpauth link), and new passwords made. Neither the
// value nor any part of it is ever in an error. Ported from switch-ext-browser's secrets.ts.
import { randomInt } from "node:crypto"

import type { FieldType } from "./model.ts"
import { otpauth, parseTotp } from "./otp.ts"

/** Whether a run of digits passes the Luhn check, as card numbers do. */
export const luhn = (digits: string) => {
  if (digits.length < 12) {
    return false
  }
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) {
        d -= 9
      }
    }
    sum += d
  }
  return sum % 10 === 0
}

const NAMES: Partial<Record<FieldType, string>> = {
  "card-number": "a card number",
  cvc: "a security code",
  month: "a month",
  year: "a year",
  ssn: "a social security number",
  pin: "a PIN",
  totp: "an authenticator key",
  email: "an email address",
}

/** The value as it's kept, or why it isn't one of its type. */
export const normalize = (type: FieldType, given: string): string => {
  const raw = type === "private-key" || type === "concealed" ? given : given.trim()
  const digits = raw.replaceAll(/\D/gu, "")
  const only = (allowed: string) => raw.split("").every((c) => /\d/u.test(c) || allowed.includes(c))
  const n = digits.length
  const fail = () => new Error(`That isn't ${NAMES[type] ?? "it"}`)
  if (type === "card-number") {
    if (only(" -") && n >= 13 && n <= 19 && luhn(digits)) {
      return digits
    }
    throw fail()
  }
  if (type === "cvc") {
    if (only("") && (n === 3 || n === 4)) {
      return digits
    }
    throw fail()
  }
  if (type === "month") {
    if (only("") && n >= 1 && n <= 2 && Number(digits) >= 1 && Number(digits) <= 12) {
      return digits.padStart(2, "0")
    }
    throw fail()
  }
  if (type === "year") {
    if (only("") && (n === 2 || n === 4)) {
      return n === 2 ? `20${digits}` : digits
    }
    throw fail()
  }
  if (type === "ssn") {
    if (only("- ") && n === 9) {
      return digits
    }
    throw fail()
  }
  if (type === "pin") {
    if (only("") && n >= 4 && n <= 12) {
      return digits
    }
    throw fail()
  }
  if (type === "totp") {
    return otpauth(parseTotp(raw))
  }
  if (raw.length > 65_536) {
    throw new Error("That's too long to keep")
  }
  return raw
}

/** The expiry a card's month and year make: MM/YY. */
export const expiry = (month: string, year: string): string => `${month}/${year.slice(-2)}`

const CHARS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnopqrstuvwxyz",
  digits: "23456789",
  symbols: "-_.!@#$%&*+=?",
}

const pick = (from: string) => from[randomInt(from.length)] ?? ""

export interface Generate {
  /** `random` (the default), `apple` (xxxxxx-xxxxxx-xxxxxx with a digit and a capital), `pin`. */
  readonly style?: "random" | "apple" | "pin"
  readonly length?: number
  readonly digits?: boolean
  readonly symbols?: boolean
}

/** A new strong password. */
export const generate = (g: Generate): string => {
  if (g.style === "pin") {
    const length = g.length ?? 6
    if (length < 4 || length > 12) {
      throw new Error("A PIN is 4 to 12 digits")
    }
    return Array.from({ length }, () => String(randomInt(10))).join("")
  }
  if (g.style === "apple") {
    const chars = Array.from({ length: 18 }, () => pick(CHARS.lower))
    const digitAt = randomInt(18)
    let upperAt = randomInt(18)
    while (upperAt === digitAt) {
      upperAt = randomInt(18)
    }
    chars[digitAt] = pick(CHARS.digits)
    chars[upperAt] = pick(CHARS.upper)
    const s = chars.join("")
    return `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`
  }
  const length = g.length ?? 24
  if (length < 8 || length > 128) {
    throw new Error("A generated password is 8 to 128 characters")
  }
  const sets = [
    CHARS.upper,
    CHARS.lower,
    ...(g.digits === false ? [] : [CHARS.digits]),
    ...(g.symbols === false ? [] : [CHARS.symbols]),
  ]
  const all = sets.join("")
  for (;;) {
    const password = Array.from({ length }, () => pick(all)).join("")
    if (sets.every((set) => password.split("").some((c) => set.includes(c)))) {
      return password
    }
  }
}
