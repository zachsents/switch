// The core and the credential this window reaches it with. In the app the bun process hands them
// over (it keeps the credential in the Keychain), or the code it's waiting on while it pairs. In a
// browser (a dev view), `?brain=` and `?token=`.
import { useSyncExternalStore } from "react"

export type Auth =
  | { readonly core: string; readonly token: string }
  | { readonly core: string; readonly code: string }

const fromLocation = (): Auth | null => {
  const params = new URLSearchParams(location.search)
  const token = params.get("token")
  const core = params.get("brain") ?? import.meta.env.VITE_BRAIN ?? "ws://127.0.0.1:4871"
  return token === null ? null : { core, token }
}

let current = fromLocation()
const listeners = new Set<() => void>()

const same = (a: Auth, b: Auth | null) =>
  b !== null &&
  a.core === b.core &&
  ("token" in a ? "token" in b && a.token === b.token : "code" in b && a.code === b.code)

export const setAuth = (a: Auth) => {
  if (same(a, current)) {
    return
  }
  current = a
  for (const l of listeners) {
    l()
  }
}

export const onAuth = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export const authNow = () => current

/** The token, once there is one. */
export const tokenNow = () => (current !== null && "token" in current ? current.token : null)

const asUrl = (core: string, protocol: "ws" | "http") => {
  const url = new URL(core)
  const secure = url.protocol === "https:" || url.protocol === "wss:"
  url.protocol = `${protocol}${secure ? "s" : ""}:`
  url.pathname = "/"
  url.search = ""
  return url
}

/** The core this window reaches, as its HTTP origin: what the outbox keeps things under. */
export const coreKey = () => (current === null ? null : asUrl(current.core, "http").origin)

/** The sync socket's address, as ws(s)://. */
export const socketUrl = () => asUrl(current?.core ?? "ws://127.0.0.1:4871", "ws")

/**
 * A route on the core (`/blobs/…`, which may carry its own query), its credential in the address:
 * a header would cost a CORS preflight, and an image can't send one.
 */
export const coreUrl = (route: string, params: Readonly<Record<string, string>> = {}) => {
  const url = new URL(route, asUrl(current?.core ?? "http://127.0.0.1:4871", "http"))
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const token = tokenNow()
  if (token !== null) {
    url.searchParams.set("token", token)
  }
  return url.toString()
}

/**
 * An ask's live view, the core's own page (core/portal.ts): the item and the credential ride in its
 * fragment, which never leaves this machine; `watch` only shows it.
 */
export const portalUrl = (item: string, watch: boolean) => {
  const url = new URL("/portal", asUrl(current?.core ?? "http://127.0.0.1:4871", "http"))
  const hash = new URLSearchParams({ item, token: tokenNow() ?? "" })
  if (watch) {
    hash.set("watch", "1")
  }
  url.hash = hash.toString()
  return url.toString()
}

export const useAuth = () =>
  useSyncExternalStore(
    (l) => onAuth(l),
    () => current,
  )
