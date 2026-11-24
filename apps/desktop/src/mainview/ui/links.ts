// `switchboard://` links, to the page they name: `space/<id>`, `thread/<id>` and `item/<id>` (an
// action item, in its window while it's open, else its space), `id/<id>` (whichever of those has
// the id: a link the agent wrote to a bare id, markdown.tsx), and the old client's forms:
// `open/ws/<slug>`, `workspace/<slug>`, `work/<id>`, `ask/<id>`. An old workspace's slug is its
// space's id (or its name, made a slug); an old task is thread `sb:<id>`. What can't be found opens
// Home.
import { HOME, ThreadId } from "@switch/brain/commands"

import { brainQuery } from "../brain/client.ts"
import type { State } from "../brain/store.ts"
import { queryClient } from "../query.ts"
import { go } from "./nav.ts"
import type { Page } from "./nav.ts"
import { openItemWindow } from "./use-menu.ts"

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")

const spaceNamed = (s: State, given: string): Page => {
  const want = given.replace(/^ws:/u, "")
  const all = [...s.spaces.values()]
  const found =
    all.find((x) => x.id === want) ??
    all.find((x) => x.id.toLowerCase() === want.toLowerCase()) ??
    all.find((x) => slugOf(x.name) === slugOf(want))
  return { kind: "space", id: found ? found.id : HOME }
}

const threadNamed = (s: State, given: string): Page => {
  const id = [given, `sb:${given}`, `space:${given}`]
    .map((x) => ThreadId.make(x))
    .find((x) => s.threads.has(x))
  return id ? { kind: "thread", id } : { kind: "space", id: HOME }
}

/** What a link names: its kind (`space`, `thread`, `item`…) and id. */
const targetOf = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { first: "", id: "" }
  }
  // `switchboard://space/x`: the host is the first part.
  const parts = [parsed.host, ...parsed.pathname.split("/")]
    .filter((p) => p !== "")
    .map((p) => decodeURIComponent(p))
  const [first = "", ...rest] = parts[0] === "open" ? parts.slice(1) : parts
  return { first, id: rest.join("/") }
}

export const pageOfLink = (s: State, url: string): Page => {
  const { first, id } = targetOf(url)
  if (!id) {
    return { kind: "space", id: HOME }
  }
  switch (first) {
    case "space":
    case "ws":
    case "workspace": {
      return id === "home" || id === "ws:home" ? { kind: "space", id: HOME } : spaceNamed(s, id)
    }
    case "thread":
    case "work": {
      return threadNamed(s, id)
    }
    case "ask":
    case "item": {
      const item = s.extra.actions.get(id) ?? s.extra.revising.get(id)
      return { kind: "space", id: item ? item.space : HOME }
    }
    case "id": {
      const item = s.extra.actions.get(id) ?? s.extra.revising.get(id)
      if (item) {
        return { kind: "space", id: item.space }
      }
      const thread = threadNamed(s, id)
      return thread.kind === "thread" ? thread : spaceNamed(s, id)
    }
    default: {
      return { kind: "space", id: HOME }
    }
  }
}

/** Opens a link here: an open action item in its window, any other page in this one. */
export const openLink = (s: State, url: string) => {
  const { first, id } = targetOf(url)
  if ((first === "item" || first === "id") && s.extra.actions.has(id)) {
    openItemWindow(id)
  } else {
    go(pageOfLink(s, url))
  }
}

/** Opens a link in a message, once the brain is read. */
export const followLink = (url: string) => {
  const s = queryClient.getQueryData(brainQuery.queryKey)
  if (s?.ready === true) {
    openLink(s, url)
  }
}
