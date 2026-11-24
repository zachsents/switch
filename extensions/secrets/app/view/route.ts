// Where the window is: the location's hash, so Back and Forward are the history's.
//   #/items/<filter>/<item>   the list under a filter, an item open
//   #/edit/<item>  #/new/<kind>   the editor
//   #/<page>                  generator, devices, grants, audit, import, export
import { useSyncExternalStore } from "react"

import { KINDS } from "../../src/model.ts"
import type { Kind } from "../../src/model.ts"
import { PAGES } from "../shared/rpc.ts"
import type { Page } from "../shared/rpc.ts"

/** `all`, `favorites`, `trash`, or `kind:`, `tag:`, `folder:`, `space:` and its value. */
export type Filter = string

export type Route =
  | { readonly page: "items"; readonly filter: Filter; readonly item: string | null }
  | { readonly page: "edit"; readonly item: string }
  | { readonly page: "new"; readonly kind: Kind }
  | { readonly page: Exclude<Page, "items"> }

const part = (s: string | undefined) => (s === undefined ? "" : decodeURIComponent(s))

const parse = (hash: string): Route => {
  const [, page = "", a, b] = hash.split("/")
  if (page === "edit" && a !== undefined && a !== "") {
    return { page: "edit", item: part(a) }
  }
  if (page === "new") {
    return { page: "new", kind: KINDS.find((k) => k === a) ?? "login" }
  }
  const other = PAGES.find((p) => p === page && p !== "items")
  if (other && other !== "items") {
    return { page: other }
  }
  return { page: "items", filter: part(a) || "all", item: part(b) || null }
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange)
  return () => {
    window.removeEventListener("hashchange", onChange)
  }
}

export const useRoute = (): Route => parse(useSyncExternalStore(subscribe, () => location.hash))

export const currentRoute = (): Route => parse(location.hash)

const go = (...parts: string[]) => {
  location.hash = `#/${parts.map((p) => encodeURIComponent(p)).join("/")}`
}

/** The filter the list last showed, so an item opens under it. */
const filterNow = () => {
  const r = currentRoute()
  return r.page === "items" ? r.filter : "all"
}

export const openItem = (item: string, filter = filterNow()) => {
  go("items", filter, item)
}

export const openFilter = (filter: Filter) => {
  go("items", filter)
}

export const openPage = (page: Page) => {
  if (page === "items") {
    go("items", filterNow())
  } else {
    go(page)
  }
}

export const editItem = (item: string) => {
  go("edit", item)
}

export const newItem = (kind: Kind) => {
  go("new", kind)
}
