// Where pages' links lead and what lets them in. A link is `<base>/p/<token>`: `base` the install's
// public address for pages when it has one (a proxy's, like Tailscale Funnel's), else the core's own
// on the private network; the token an HMAC of the page's id under a key kept in the core's folder
// (readable only by its owner, made the first time), so it's unguessable, the same for every
// version, and in no record or log.
import { existsSync, readFileSync } from "node:fs"
import { createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import { createFileAtomic } from "@switch/brain/files"
import { Context, Layer } from "effect"

export interface PagesShape {
  /** Where links start, without a trailing slash. */
  readonly base: string
  /** Whether that's on the public internet (https), so Google Calendar can subscribe. */
  readonly public: boolean
  readonly tokenOf: (id: string) => string
  readonly linkOf: (id: string) => string
}

const KEY = /^[0-9a-f]{64}$/u

// One that isn't whole is an error, never a key.
const keyOf = (dir: string) => {
  const file = path.join(dir, "pages.key")
  if (!existsSync(file)) {
    createFileAtomic(file, randomBytes(32).toString("hex"), { mode: 0o600 })
  }
  const key = readFileSync(file, "utf-8").trim()
  if (!KEY.test(key)) {
    throw new Error(`${file} is damaged`)
  }
  return Buffer.from(key, "hex")
}

export class Pages extends Context.Service<Pages, PagesShape>()("switch/Pages") {
  static readonly layer = (config: { readonly dir: string; readonly base: string }) =>
    Layer.sync(Pages, () => {
      const key = keyOf(config.dir)
      const base = config.base.replace(/\/+$/u, "")
      const tokenOf = (id: string) =>
        createHmac("sha256", key).update(id).digest("hex").slice(0, 32)
      return {
        base,
        public: base.startsWith("https://"),
        tokenOf,
        linkOf: (id) => `${base}/p/${tokenOf(id)}`,
      }
    })
}

/** An item's passkey ceremony, a token of its own: `<base>/p/passkey/<token>`. */
export const passkeyToken = (pages: PagesShape, item: string): string =>
  pages.tokenOf(`passkey:${item}`)

export const passkeyLink = (pages: PagesShape, item: string): string =>
  `${pages.base}/p/passkey/${passkeyToken(pages, item)}`
