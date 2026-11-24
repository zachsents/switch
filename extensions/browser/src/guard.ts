// What the browser never does with secrets. It never types a password, a payment number or an
// identity number: fields for them are refused (the page script knows them by type, autocomplete and
// name), and so is text that is one, wherever it's headed. What pages show of credentials is masked
// before anything comes back: tokens and keys in known formats, private keys, whole card numbers and
// social security numbers. Ported from Switchboard's guard.rs.

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

const SSN = /\b\d{3}-\d{2}-\d{4}\b/gu

/** Card numbers as pages print them whole: a network's prefix, grouped or not. */
const WHOLE_CARD =
  /\b(?:3[47]\d{2}|4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d{4}){2}[ -]?\d{3,4}\b/gu

/** Secrets in formats with a recognizable shape: API keys, tokens, private keys. */
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /\bwhsec_[A-Za-z0-9]{20,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
  /\bya29\.[0-9A-Za-z_-]{20,}/gu,
  /\bEAA[A-Za-z0-9]{60,}/gu,
  /\bvck_[A-Za-z0-9]{20,}/gu,
  /\bnpm_[A-Za-z0-9]{30,}/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/giu,
]

const digitsOf = (s: string) => s.replaceAll(/\D/gu, "")

/** Why `text` must not be typed anywhere, or null. */
export const secretText = (text: string) => {
  for (const m of text.matchAll(WHOLE_CARD)) {
    if (luhn(digitsOf(m[0]))) {
      return "a payment card number"
    }
  }
  if (new RegExp(SSN.source, "u").test(text)) {
    return "a social security number"
  }
  return null
}

/** Why a field of this kind (the page script's `sensitive`) is refused. */
export const refusal = (sensitive: string) =>
  `That's a ${sensitive} field, and you never type passwords, payment or identity numbers: sign_in fills a sign-in (a login in the vault, else the browser's saved passwords), fill_secret one of the vault's secrets, and autofill what the browser has saved (a card, an address); a one-time code goes in with sign_in's otp`

/** `text` with the secrets it shows masked. */
export const redact = (text: string) => {
  let out = text
  for (const pattern of SECRETS) {
    out = out.replaceAll(pattern, "[secret hidden: value with save_to keeps it in a file]")
  }
  out = out.replaceAll(WHOLE_CARD, (m) => (luhn(digitsOf(m)) ? "[card number hidden]" : m))
  return out.replaceAll(SSN, "[SSN hidden]")
}

/** Query parameters whose values are credentials. */
const SECRET_PARAM =
  /(?<name>[?&#](?:[a-z_]*token|[a-z_]*key|secret|password|passwd|auth[a-z_]*|code|state|code_verifier|code_challenge|sig|signature|session[a-z_]*|credential[a-z_]*)=)[^&#]*/giu

/** A URL with the values of credential-like query parameters hidden. */
export const redactUrl = (url: string) => url.replaceAll(SECRET_PARAM, "$<name>…")
