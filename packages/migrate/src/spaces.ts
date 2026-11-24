// Workspaces become spaces under Home, with their tree, names, inks and what they're for. Each is
// made once: a space Switch already has under its id is left as the user keeps it, never renamed,
// described, moved, inked or archived again.
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import path from "node:path"
import {
  allSpaces,
  EventId,
  HOME,
  SpaceArchived,
  SpaceCreated,
  SpaceInked,
  SpaceId,
} from "@switch/brain"
import type { Incoming } from "@switch/brain"

import type { Body } from "./source.ts"
import { num, obj, str, strs } from "./source.ts"

export interface Workspace {
  readonly ws: string
  readonly name: string
  readonly parent: string | null
  readonly ink: { readonly day: string; readonly night: string } | null
  readonly about: string
  readonly archivedAt: number | null
  readonly folder: string | null
  /** When it first shows in the log. */
  readonly since: number
}

const time = (v: unknown): number | null => {
  if (typeof v === "number") {
    return v
  }
  const t = Date.parse(str(v))
  return Number.isNaN(t) ? null : t
}

export const expand = (p: string) => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p)

/** From the workspaces read model, their entities' briefs, and when each first shows. */
export const workspacesOf = (
  rows: readonly Body[],
  briefs: ReadonlyMap<string, Body>,
  since: ReadonlyMap<string, number>,
): Workspace[] =>
  rows.map((r) => {
    const ws = str(r.id)
    const what = str(obj(briefs.get(ws)).what)
    const aliases = strs(r.aliases)
    const day = str(r.ink)
    const night = str(r.night)
    return {
      ws,
      name: str(r.name),
      parent: str(r.parent) === "" ? null : str(r.parent),
      ink: day === "" ? null : { day, night: night === "" ? day : night },
      about: [what, aliases.length > 0 ? `Also called ${aliases.join(", ")}.` : ""]
        .filter((s) => s !== "")
        .join(" "),
      archivedAt: str(r.state) === "archived" ? (time(r.archived_at) ?? num(r.last_at)) : null,
      folder: str(r.folder) === "" ? null : expand(str(r.folder)),
      since: since.get(ws) ?? 0,
    }
  })

const slug = (ws: string) => (ws === "ws:home" ? HOME : SpaceId.make(ws.replace(/^ws:/u, "")))

export interface Placed {
  /** Each workspace's space. */
  readonly ids: ReadonlyMap<string, SpaceId>
  readonly names: ReadonlyMap<SpaceId, string>
  readonly folders: ReadonlyMap<SpaceId, string>
  readonly events: Incoming[]
}

const depth = (w: Workspace, all: ReadonlyMap<string, Workspace>) => {
  let n = 0
  for (let p = w.parent; p !== null && n < 32; p = all.get(p)?.parent ?? null) {
    n += 1
  }
  return n
}

const at = (when: number, id: string, type: string, payload: unknown): Incoming => ({
  id: EventId.make(id),
  type,
  source: "switchboard",
  time: when,
  payload,
})

/** The events that make a workspace's space. */
const made = (w: Workspace, space: SpaceId, parent: SpaceId, now: number) => {
  const key = `sb:space:${space}`
  const since = w.since > 0 ? w.since : now
  const p: typeof SpaceCreated.payload.Type = {
    id: space,
    name: w.name,
    parent,
    ephemeral: false,
    about: w.about,
  }
  const out: Incoming[] = [at(since, key, SpaceCreated.type, p)]
  const { ink } = w
  if (ink !== null) {
    const inked: typeof SpaceInked.payload.Type = { id: space, ...ink }
    out.push(at(since, `${key}:ink:${ink.day}:${ink.night}`, SpaceInked.type, inked))
  }
  if (w.archivedAt !== null) {
    const archived: typeof SpaceArchived.payload.Type = { id: space }
    out.push(at(w.archivedAt, `${key}:archived`, SpaceArchived.type, archived))
  }
  return out
}

/** The events that make the spaces Switch doesn't have yet, and where each workspace went. */
export const placeSpaces = (
  db: Database,
  workspaces: readonly Workspace[],
  now: number,
): Placed => {
  const existing = allSpaces(db)
  const byWs = new Map(workspaces.map((w) => [w.ws, w]))
  const ids = new Map<string, SpaceId>()
  const names = new Map<SpaceId, string>([[HOME, "Home"]])
  const folders = new Map<SpaceId, string>()
  const events: Incoming[] = []
  const have = new Set(existing.map((s) => s.id))
  for (const w of workspaces.toSorted((a, b) => depth(a, byWs) - depth(b, byWs))) {
    const space = slug(w.ws)
    ids.set(w.ws, space)
    names.set(space, existing.find((s) => s.id === space)?.name ?? w.name)
    if (w.folder !== null) {
      folders.set(space, w.folder)
    }
    if (!have.has(space)) {
      const parent = w.parent === null ? HOME : (ids.get(w.parent) ?? HOME)
      events.push(...made(w, space, parent, now))
    }
  }
  return { ids, names, folders, events }
}
