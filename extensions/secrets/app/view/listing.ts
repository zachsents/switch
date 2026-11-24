// The list's rules, worked out in the view on every render from the items the bun process gave:
// which a filter keeps, how a search ranks them, and what each filter counts. Typing never waits.
import { KINDS, TEMPLATES } from "../../src/model.ts"
import type { Kind } from "../../src/model.ts"
import type { ShownItem } from "../shared/rpc.ts"
import type { Filter } from "./route.ts"

export const KIND_LABELS: Record<Kind, string> = {
  login: "Logins",
  password: "Passwords",
  "api-key": "API Keys",
  card: "Cards",
  note: "Notes",
  "ssh-key": "SSH Keys",
  identity: "Identities",
  file: "Files",
}

export const KIND_NAMES: Record<Kind, string> = {
  login: "Login",
  password: "Password",
  "api-key": "API Key",
  card: "Card",
  note: "Note",
  "ssh-key": "SSH Key",
  identity: "Identity",
  file: "File",
}

/** Every folder an item's folder sits in: "Work/Clients" is in Work too. */
const foldersOf = (folder: string) =>
  folder === "" ? [] : folder.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))

export const kept = (item: ShownItem, filter: Filter) => {
  if (filter === "trash") {
    return item.trashed > 0
  }
  if (item.trashed > 0) {
    return false
  }
  if (filter === "favorites") {
    return item.favorite
  }
  const at = filter.indexOf(":")
  const [by, value] = at === -1 ? [filter, ""] : [filter.slice(0, at), filter.slice(at + 1)]
  if (by === "kind") {
    return item.kind === value
  }
  if (by === "tag") {
    return item.tags.includes(value)
  }
  if (by === "folder") {
    return foldersOf(item.folder).includes(value)
  }
  if (by === "space") {
    return item.spaces.includes(value)
  }
  return true
}

export const usernameOf = (item: ShownItem) =>
  item.fields.find((f) => (f.id === "username" || f.type === "email") && f.value !== "")?.value ??
  ""

const hostOf = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname
  } catch {
    return url
  }
}

/** What a line says beside the title: the username, else the site. */
export const detailOf = (item: ShownItem) =>
  usernameOf(item) || (item.urls[0] ? hostOf(item.urls[0].url) : "")

/** How well an item matches every word typed: 0 is not at all. */
export const score = (item: ShownItem, query: string) => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  const title = item.title.toLowerCase()
  const rest = [
    item.name,
    usernameOf(item),
    item.folder,
    ...item.tags,
    ...item.urls.map((u) => u.url),
    ...item.fields.filter((f) => !f.concealed).map((f) => f.value),
  ]
    .join(" ")
    .toLowerCase()
  let total = 0
  for (const w of words) {
    if (title.startsWith(w)) {
      total += 4
    } else if (title.includes(w)) {
      total += 3
    } else if (rest.includes(w)) {
      total += 1
    } else {
      return 0
    }
  }
  return total
}

export const byTitle = (a: ShownItem, b: ShownItem) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" })

/** The items a filter keeps, searched: best first, then by title. */
export const listed = (all: readonly ShownItem[], filter: Filter, query: string) => {
  const under = all.filter((i) => kept(i, filter))
  if (query.trim() === "") {
    return under.toSorted(byTitle)
  }
  return under
    .map((i) => ({ i, s: score(i, query) }))
    .filter((h) => h.s > 0)
    .toSorted((a, b) => b.s - a.s || byTitle(a.i, b.i))
    .map((h) => h.i)
}

const tally = (values: readonly string[]) => {
  const counts = new Map<string, number>()
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }))
}

/** The filters column: each with how many items it keeps. */
export const filtersOf = (all: readonly ShownItem[]) => {
  const live = all.filter((i) => i.trashed === 0)
  return {
    all: live.length,
    favorites: live.filter((i) => i.favorite).length,
    trash: all.length - live.length,
    kinds: KINDS.map((kind) => ({
      value: kind,
      count: live.filter((i) => i.kind === kind).length,
    })).filter((k) => k.count > 0),
    folders: tally(live.flatMap((i) => foldersOf(i.folder))),
    tags: tally(live.flatMap((i) => i.tags)),
    spaces: tally(live.flatMap((i) => i.spaces)),
  }
}

/** The field Enter copies: the kind's main secret, else the first concealed one set. */
export const mainOf = (item: ShownItem) => {
  const first = TEMPLATES[item.kind][0]?.[0]
  return (
    item.fields.find((f) => f.id === first && f.set) ??
    item.fields.find((f) => f.concealed && f.set)
  )
}

/** A filter's name as the list's heading shows it. */
export const filterName = (filter: Filter) => {
  if (filter === "all") {
    return "All"
  }
  if (filter === "favorites") {
    return "Favorites"
  }
  if (filter === "trash") {
    return "Trash"
  }
  const at = filter.indexOf(":")
  const value = filter.slice(at + 1)
  const kind = KINDS.find((k) => k === value)
  return filter.startsWith("kind:") && kind ? KIND_LABELS[kind] : value
}
