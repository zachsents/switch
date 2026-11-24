// Where the window is: the location's hash, so Back and Forward are the history's.
import { useSyncExternalStore } from "react"

export type Route =
  | { readonly page: "people"; readonly person: string | null }
  | { readonly page: "changes" }

const parse = (hash: string): Route => {
  if (hash === "#/changes") {
    return { page: "changes" }
  }
  const m = /^#\/person\/(?<id>.+)$/u.exec(hash)
  return {
    page: "people",
    person: m?.groups?.id === undefined ? null : decodeURIComponent(m.groups.id),
  }
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange)
  return () => {
    window.removeEventListener("hashchange", onChange)
  }
}

export const useRoute = (): Route => parse(useSyncExternalStore(subscribe, () => location.hash))

export const currentRoute = (): Route => parse(location.hash)

export const openPerson = (id: string) => {
  location.hash = `#/person/${encodeURIComponent(id)}`
}

export const openChanges = () => {
  location.hash = "#/changes"
}

export const openPeople = () => {
  const r = currentRoute()
  if (r.page !== "people") {
    history.back()
  }
}
