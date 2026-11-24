// Signing in. `sign_in` fills a sign-in page's username and password, page after page (email, then
// password), and sends each on: from a login in the user's vault when `account` names one, or when
// the vault has just one for the site (keeper.ts), else the browser fills them itself from its saved passwords (its own suggestions,
// picked through Accessibility). A page asking for a one-time code is filled from `otp`, or the
// login's authenticator code. A field still there after it was sent is reported, never retried. Nothing
// secret ever passes through here: what was filled is said by how many characters it holds.
// `save_account` keeps a login in the vault; `accounts` lists them. Ported from Switchboard's signin.rs.
import * as accounts from "./accounts.ts"
import * as keeper from "./keeper.ts"
import type { Outline } from "./keeper.ts"
import type { Json } from "./chrome.ts"
import { isJson } from "./chrome.ts"
import { browserFills, done, nowOn, num, str, whatAt } from "./common.ts"
import type { Done } from "./common.ts"
import { parseKey } from "./tab.ts"
import type { Tab } from "./tab.ts"

/** Pages a sign-in can take: email, password, code, and a spare. */
const ROUNDS = 6
/** How long a sign-in page's next step may take to show its fields (ms). */
const NEXT_PAGE = 2500

interface Field {
  readonly n: number
  readonly fp: string
  readonly kind: string
  readonly boxes: number
  readonly length: number
  readonly line: string
}

const fieldsOf = (found: unknown): Field[] =>
  (Array.isArray(found) ? found : []).filter(isJson).flatMap((f) => {
    const n = num(f.n)
    return n === null
      ? []
      : [
          {
            n,
            fp: str(f.fp),
            kind: str(f.kind),
            boxes: num(f.boxes) ?? 1,
            length: num(f.length) ?? 0,
            line: str(f.line),
          },
        ]
  })

/** Sends a filled field's form on: its submit button, else Enter. */
const send = async (tab: Tab, field: Field) => {
  const since = Date.now()
  const button = num(
    await tab.page(`submitter(${field.n}, ${JSON.stringify(field.fp)})`).catch(() => null),
  )
  let how: string
  if (button === null) {
    await tab.press(parseKey("Enter"))
    how = "pressed Enter"
  } else {
    const at = await tab.point(button)
    how = `pressed ${await whatAt(tab, at)}`
    await tab.clickAt(at)
  }
  await tab.settle(since)
  return how
}

/** Waits a few seconds for the page to move on from the fields just sent. */
const movedOn = async (tab: Tab, sent: readonly Field[]) => {
  const ns = new Set(sent.map((f) => f.n))
  const until = Date.now() + 6000
  while (Date.now() < until) {
    const found = fieldsOf(await tab.page("signin()").catch(() => []))
    if (!found.some((f) => ns.has(f.n))) {
      return
    }
    await Bun.sleep(300)
  }
}

/** How many characters a field holds now, never what they are. */
const lengthOf = async (tab: Tab, f: Field) =>
  num(await tab.page(`length(${f.n}, ${JSON.stringify(f.fp)})`).catch(() => null)) ?? 0

/** A one-time code into its field: typed box by box when it's split one character to a box. */
const putCode = async (tab: Tab, f: Field, code: string) => {
  if (f.boxes > 1) {
    await tab.clickAt(await tab.point(f.n))
    await tab.keystrokes(code)
    return fieldsOf(await tab.page("signin()")).find((x) => x.n === f.n)?.length ?? 0
  }
  return await tab.fillHidden(f.n, code)
}

/** Where a sign-in's username and password come from. */
interface Source {
  /** How results name it. */
  readonly who: string
  /** Whether it fills a kind of field ("username", "password", "code"). */
  readonly has: (kind: string) => boolean
  /** Fills this page's fields of those kinds; says what went where. */
  readonly fill: (tab: Tab, fields: readonly Field[]) => Promise<string[]>
}

/** What a page's fields hold now, as results say it. */
const heldNow = async (tab: Tab, fields: readonly Field[], filled: Set<string>) => {
  const said: string[] = []
  for (const f of fields) {
    const held = await lengthOf(tab, f)
    if (held > 0) {
      filled.add(f.kind)
      said.push(
        f.kind === "password"
          ? `the password into ${f.line} (${held} characters)`
          : `the ${f.kind} into ${f.line}`,
      )
    }
  }
  return said
}

/** The browser offered several saved sign-ins and none was named. */
class OffersError extends Error {
  override name = "OffersError"

  readonly labels: readonly string[]

  constructor(host: string, labels: readonly string[]) {
    super(
      `The browser offers these saved sign-ins for ${host}:\n${labels.map((l) => `- ${l}`).join("\n")}\nsign_in again with account: words from one.`,
    )
    this.labels = labels
  }
}
/** The browser's saved passwords: `pick` is words in its suggestion, or the one it offers. */
const fromBrowser = (
  start: string | null,
  host: string,
): Source & { pick: () => string | null } => {
  let pick = start
  return {
    who: "the browser's saved passwords",
    pick: () => pick,
    has: (kind) => kind === "username" || kind === "password",
    fill: async (tab, fields) => {
      const [first] = fields
      if (!first) {
        return []
      }
      const at = await tab.point(first.n)
      if (pick === null) {
        // The one saved sign-in the browser offers here, else the list to choose from.
        const offered = await browserFills(tab, at, null)
        const [only, ...more] = offered.labels
        if (only === undefined || more.length > 0) {
          throw new OffersError(host, offered.labels)
        }
        pick = only
      }
      const offered = await browserFills(tab, at, pick)
      await Bun.sleep(400)
      const said = await heldNow(tab, fields, new Set())
      if (said.length === 0) {
        throw new Error(
          `The browser chose "${offered.chose ?? pick}" but the fields still read empty: it may be asking to verify it's the user (Touch ID or the Mac's password); look at a screenshot`,
        )
      }
      return said
    },
  }
}

/** A login in the vault: each page's secrets released for that page alone. */
const fromVault = (login: Outline): Source => {
  const username = keeper.plain(login, "username")
  return {
    who: username === undefined ? login.name : `${login.name} (${username})`,
    has: (kind) =>
      (kind === "username" && username !== undefined) ||
      (kind === "password" && keeper.holds(login, "password")) ||
      (kind === "code" && keeper.holds(login, "totp")),
    fill: async (tab, fields) => {
      const wanted = fields.map(
        (f) => ({ username: "username", password: "password", code: "totp" })[f.kind] ?? "",
      )
      const needs = wanted.filter((w) => w === "password" || w === "totp")
      const page = await tab.info()
      const released =
        needs.length > 0 ? await keeper.release({ item: login.id }, page.url, needs) : null
      const secret = released?.values ?? {}
      const said: string[] = []
      for (const f of fields) {
        const { password } = secret
        const code = secret.totp
        if (f.kind === "username" && username !== undefined) {
          await tab.fill(f.n, username)
          said.push(`the username into ${f.line}`)
        } else if (f.kind === "password" && password !== undefined) {
          const held = await tab.fillHidden(f.n, password)
          if (held !== password.length) {
            throw new Error(
              `${f.line} holds ${held} characters after filling the password, not ${password.length}: the field cuts or changes it; look at the page`,
            )
          }
          said.push(`the password into ${f.line} (${held} characters)`)
        } else if (f.kind === "code" && code !== undefined) {
          const held = await putCode(tab, f, code)
          if (held === 0) {
            throw new Error(
              `${f.line} still reads empty after filling the authenticator code: look at the page`,
            )
          }
          said.push(`the authenticator code into ${f.line}`)
        }
      }
      return said
    },
  }
}

/** The vault's login `named` names, else its one login for this page; none without a vault. */
const vaultLogin = async (named: string | null, url: string): Promise<Outline | null> => {
  try {
    if (named !== null) {
      const found = await keeper.item(named)
      return found?.kind === "login" ? found : null
    }
    const here = await keeper.list({ kind: "login", url })
    return here.length === 1 ? (here[0] ?? null) : null
  } catch (error) {
    if (error instanceof keeper.VaultMissingError) {
      return null
    }
    throw error
  }
}

/**
 * Fills a sign-in, page after page: from the vault's login `account` names, else from the
 * browser's saved passwords (`account` then is words in its suggestion).
 */
export const signIn = async (tab: Tab, args: Json): Promise<Done> => {
  const named =
    typeof args.account === "string" && args.account.trim() !== "" ? args.account.trim() : null
  const otp = typeof args.otp === "string" && args.otp.trim() !== "" ? args.otp.trim() : null
  const submit = args.submit !== false
  const { url } = await tab.info()
  const host = accounts.hostOf(url)
  const codeOnly = otp !== null && named === null
  const stored = codeOnly ? null : await vaultLogin(named, url)
  if (args.backgroundOnly === true && stored === null && otp === null) {
    throw new Error("Private saved sign-in unavailable in the background")
  }
  const browser = fromBrowser(stored ? null : named, host)
  const source: Source = stored ? fromVault(stored) : browser
  const username = stored ? keeper.plain(stored, "username") : undefined
  const steps: string[] = []
  const filled = new Set<string>()
  const sentFields = new Set<number>()
  let picked = false
  let ending = ""
  const wants = (f: Field) =>
    (!codeOnly || f.kind === "code") &&
    !filled.has(f.kind) &&
    (source.has(f.kind) || (f.kind === "code" && otp !== null))
  for (let round = 0; round < ROUNDS; round += 1) {
    // After the first page, the next one's fields may come a beat after the last one's went.
    const started = Date.now()
    let found = fieldsOf(await tab.page("signin()"))
    const wait = round > 0 ? NEXT_PAGE : 0
    while (!found.some(wants) && Date.now() - started < wait) {
      await Bun.sleep(250)
      found = fieldsOf(await tab.page("signin()"))
    }
    // One field of each kind, the first (sign-in forms come before a footer's newsletter box).
    const left = ["username", "password", "code"].flatMap((k) => {
      const f = found.find((x) => x.kind === k && wants(x))
      return f ? [f] : []
    })
    if (left.length === 0) {
      const refused = ["password", "code"].filter(
        (k) => filled.has(k) && found.some((f) => f.kind === k && sentFields.has(f.n)),
      )
      if (refused.length > 0) {
        ending = `The page still shows the ${refused.join(" and ")} field after it was sent, so it was likely refused or didn't go; I didn't fill it again (that can lock an account). Read the page for why.`
      } else if (found.some((f) => f.kind === "code")) {
        ending =
          "A verification code is required. Use challenge with a matching private email/text source and an authenticated page check; never ask for a code in chat or an ordinary task."
      } else if (found.some((f) => f.kind === "new password")) {
        ending =
          "The page wants a new password: save_account with password: generate makes one, puts it in and keeps it."
      } else if (round === 0 && !picked && username !== undefined) {
        // An account picker: the tile for this account, once.
        const tile = num(await tab.page(`chooser(${JSON.stringify(username)})`).catch(() => null))
        if (tile === null) {
          throw new Error(
            `There's no sign-in field here that ${source.who} can fill: open its sign-in page first`,
          )
        }
        const at = await tab.point(tile)
        const what = await whatAt(tab, at)
        const since = Date.now()
        await tab.clickAt(at)
        await tab.settle(since)
        picked = true
        steps.push(`chose ${what} on the account picker`)
        continue
      } else if (round === 0) {
        throw new Error("There's no sign-in field here: open the site's sign-in page first")
      } else {
        ending = "No sign-in field is left to fill."
      }
      break
    }
    const said: string[] = []
    const mine = left.filter((f) => source.has(f.kind) && (f.kind !== "code" || otp === null))
    try {
      said.push(...(await source.fill(tab, mine)))
    } catch (error) {
      if (error instanceof OffersError) {
        return done(error.message)
      }
      throw error
    }
    for (const f of mine) {
      filled.add(f.kind)
    }
    const code = left.find((f) => f.kind === "code" && (otp !== null || !source.has("code")))
    if (code && otp !== null) {
      const held = await putCode(tab, code, otp)
      if (held === 0) {
        throw new Error(`${code.line} still reads empty after filling the code: look at the page`)
      }
      filled.add("code")
      said.push(`the one-time code into ${code.line}`)
    }
    const last = left.at(-1)
    if (!last) {
      break
    }
    if (!submit) {
      steps.push(`filled ${said.join(", ")}`)
      ending = "Not sent on (submit: false)."
      break
    }
    for (const f of left) {
      sentFields.add(f.n)
    }
    steps.push(`filled ${said.join(", ")}, then ${await send(tab, last)}`)
    await movedOn(tab, left)
  }
  const pick = browser.pick()
  let { who } = source
  if (source === browser && pick !== null) {
    who = `the saved sign-in "${pick}"`
  }
  const list = steps.map((s) => `- ${s}`).join("\n")
  return done(`Signing in to ${host} with ${who}:\n${list}\n${ending}\n${await nowOn(tab)}`)
}

const holdsWhat = (o: Outline) => {
  const password = keeper.holds(o, "password")
  const totp = keeper.holds(o, "totp")
  if (password && totp) {
    return "a password and an authenticator key"
  }
  if (password) {
    return "a password"
  }
  return totp ? "an authenticator key" : "nothing secret yet"
}

/** What an element (or the page) shows of a password or key, for the vault and nothing else. */
const revealed = async (tab: Tab, n: number | null) => {
  const value = str(
    await tab.page(n === null ? "reveal(null)" : `reveal(${n}, ${tab.known(n)})`),
  ).trim()
  if (value === "") {
    throw new Error("There's nothing there to keep")
  }
  return value
}

const field = (id: string, label: string, type: string, value: string): keeper.DraftField => ({
  id,
  label,
  type,
  value,
})

/** A file's text, a path on this Mac (~ for home). */
const fileText = async (given: string) =>
  await Bun.file(given.startsWith("~") ? `${process.env.HOME}${given.slice(1)}` : given).text()

/**
 * Keeps a login in the vault, or changes one: its username, its sites, its password (generated by
 * the vault and put in the page's new-password fields, read from the page, or from a file here) and
 * its authenticator key (from the page or a file).
 */
export const saveAccount = async (tab: Tab, args: Json, element: number | null): Promise<Done> => {
  const name = str(args.account).trim()
  accounts.checkName(name)
  const before = await keeper.item(name)
  const passwordFrom = str(args.password).trim()
  const totpFrom = str(args.totp).trim()
  if (passwordFrom === "page" && totpFrom === "page") {
    throw new Error("One thing comes from the page per call: keep the password, then the key")
  }
  const onPage = passwordFrom === "page" || totpFrom === "page" || passwordFrom === "generate"
  let url: string | null = null
  if (onPage) {
    await tab.ensure()
    tab.noDialog()
    ;({ url } = await tab.info())
  }
  let sites = before ? before.urls.map((u) => accounts.site(u)) : []
  if (Array.isArray(args.sites)) {
    sites = args.sites.filter((x) => typeof x === "string").map(accounts.site)
  }
  if (sites.length === 0) {
    if (url === null) {
      throw new Error(`Give sites: the domains ${name} may be filled on, like ["example.com"]`)
    }
    sites = [accounts.site(url)]
  }
  if (url !== null) {
    accounts.allows(sites, url)
  }
  const fields: keeper.DraftField[] = []
  if (typeof args.username === "string") {
    fields.push(field("username", "Username", "text", args.username.trim()))
  }
  const said: string[] = []
  let generated: { length: number } | null = null
  if (passwordFrom === "none") {
    fields.push(field("password", "Password", "password", ""))
    said.push("took its password away")
  } else if (passwordFrom === "generate") {
    generated = { length: num(args.length) ?? 20 }
  } else if (passwordFrom === "page") {
    if (element === null) {
      throw new Error("Name the field or element that shows the password (element or match)")
    }
    const shown = await revealed(tab, element)
    fields.push(field("password", "Password", "password", shown))
    said.push(`kept the password the page shows (${shown.length} characters)`)
  } else if (passwordFrom.startsWith("/") || passwordFrom.startsWith("~")) {
    const read = await fileText(passwordFrom)
    const password = read.replace(/[\r\n]+$/u, "")
    if (password === "") {
      throw new Error(`${passwordFrom} is empty`)
    }
    fields.push(field("password", "Password", "password", password))
    said.push(
      `kept the password in ${passwordFrom} (${password.length} characters; delete that file now that the vault has it)`,
    )
  } else if (passwordFrom !== "" && passwordFrom !== "keep") {
    throw new Error("password is generate, page, a file's path on this Mac, keep or none")
  }
  if (totpFrom === "none") {
    fields.push(field("totp", "One-time code", "totp", ""))
    said.push("took its authenticator key away")
  } else if (totpFrom === "page" || totpFrom.startsWith("/") || totpFrom.startsWith("~")) {
    const fromPage = totpFrom === "page"
    const t = fromPage
      ? accounts.parseTotp(await revealed(tab, element), element === null)
      : accounts.parseTotp(await fileText(totpFrom))
    fields.push(field("totp", "One-time code", "totp", accounts.otpauth(t)))
    said.push(
      fromPage
        ? `kept the authenticator key the page shows (${t.digits} digits every ${t.period} s)`
        : `kept the authenticator key in ${totpFrom} (delete that file now that the vault has it)`,
    )
  } else if (totpFrom !== "" && totpFrom !== "keep") {
    throw new Error("totp is page, a file's path on this Mac, keep or none")
  }
  let saved = await keeper.deposit({
    kind: "login",
    name,
    title: before?.title ?? sites[0] ?? name,
    fields,
    urls: sites.map((site) => ({ url: `https://${site}` })),
    ...(before && { into: before.id }),
  })
  if (generated !== null && url !== null) {
    const found = fieldsOf(await tab.page("signin()"))
    let into = found.filter((f) => f.kind === "new password")
    if (into.length === 0) {
      into = found.filter((f) => f.kind === "password" && f.length === 0)
    }
    if (into.length === 0) {
      throw new Error(
        "There's no new-password field on this page: open the sign-up or change-password form first",
      )
    }
    // Kept before it goes in, so a page that fails halfway never loses it; the one before stays in its history.
    saved = await keeper.save({
      item: saved.id,
      generate: { field: "password", length: generated.length },
    })
    const released = await keeper.release({ item: saved.id }, url, ["password"])
    const { password = "" } = released.values
    for (const f of into) {
      const held = await tab.fillHidden(f.n, password)
      if (held !== password.length) {
        throw new Error(
          `${f.line} holds ${held} characters, not ${password.length}: the site may cap passwords shorter (try length); the generated one is kept as ${name}'s password`,
        )
      }
    }
    said.push(
      `generated a ${password.length}-character password and filled it into ${into.map((f) => f.line).join(" and ")}`,
    )
  }
  const username = keeper.plain(saved, "username")
  let text = `Saved ${saved.name} in the vault: ${username ?? "no username"}, for ${saved.urls.map(accounts.site).join(", ")}; it holds ${holdsWhat(saved)}.`
  if (said.length > 0) {
    text += ` I ${said.join("; ")}.`
  }
  text += ` sign_in {account: "${saved.name}"} fills it on those sites; nothing secret ever comes back.`
  return done(url === null ? text : `${text}\n${await nowOn(tab)}`)
}

/** How long ago a moment was, in words. */
const ago = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) {
    return "just now"
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  return minutes < 2880
    ? `${Math.floor(minutes / 60)} h ago`
    : `${Math.floor(minutes / 1440)} days ago`
}

/** The vault's logins, or with forget, one moved to its trash. */
export const listAccounts = async (args: Json): Promise<Done> => {
  if (args.forget === true) {
    const name = str(args.account).trim()
    await keeper.remove(name)
    return done(`Moved ${name} to the vault's trash: sign_in can't fill it anymore.`)
  }
  const all = await keeper.list({ kind: "login" })
  if (all.length === 0) {
    return done(
      "The vault has no logins. save_account keeps one; sign_in without one fills from the browser's saved passwords.",
    )
  }
  const lines = all.map(
    (a) =>
      `- ${a.name}: ${keeper.plain(a, "username") ?? "no username"}, for ${a.urls.map(accounts.site).join(", ")}; ${holdsWhat(a)}; saved ${ago(a.updated)}${a.used === undefined ? "" : `, last filled ${ago(a.used)}`}`,
  )
  return done(`The vault's logins (sign_in {account} fills one on its sites):\n${lines.join("\n")}`)
}
