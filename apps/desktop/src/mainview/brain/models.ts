// Model profiles, read from the core's /models (which asks every provider first, so it can take a
// while) and changed by commands. A change shows in the cache at once, goes back if the core
// refuses it, and is read again once it's through.
import { recordsOf } from "@switch/brain/commands"
import { DeleteProfile, ProfilesView, SaveProfile, SelectProfile } from "@switch/core/profiles"
import { mutationOptions, queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"

import { queryClient } from "../query.ts"
import { coreUrl } from "./auth.ts"
import { command, eventListeners } from "./client.ts"
import { rec } from "./json.ts"

type View = typeof ProfilesView.Type

const activeOf = Schema.decodeUnknownSync(Schema.Struct({ active: ProfilesView.fields.active }))
/** Each profile and provider account that reads; one that doesn't is left out, said in the log. */
const profilesOf = recordsOf("model profile", ProfilesView.fields.profiles.value)
const capabilitiesOf = recordsOf("provider account", ProfilesView.fields.accounts.value)
const viewOf = (raw: unknown): View => {
  const view = rec(raw)
  return {
    active: activeOf(raw).active,
    profiles: profilesOf(view.profiles),
    accounts: capabilitiesOf(view.accounts),
  }
}

const key = ["models"] as const
export const modelsQuery = queryOptions({
  queryKey: key,
  queryFn: async () => {
    const response = await fetch(coreUrl("/models"), {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    }).catch(() => {
      throw new Error("Models connection failed")
    })
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Models: Not paired")
      }
      if (response.status === 403) {
        throw new Error("Models: Permission denied")
      }
      throw new Error(`Models HTTP ${response.status}`)
    }
    try {
      return viewOf(await response.json())
    } catch {
      throw new Error("Invalid models response")
    }
  },
  staleTime: 60_000,
})
eventListeners.add((e) => {
  if (e.type.startsWith("profile.")) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
})

/** The change shown at once; what was there before, to put back. */
const optimistic = <V>(change: (view: View, v: V) => View) => ({
  onMutate: async (v: V) => {
    await queryClient.cancelQueries({ queryKey: key })
    const before = queryClient.getQueryData(modelsQuery.queryKey)
    if (before) {
      queryClient.setQueryData(modelsQuery.queryKey, change(before, v))
    }
    return { before }
  },
  onError: (_error: Error, _v: V, held: { readonly before: View | undefined } | undefined) => {
    if (held?.before) {
      queryClient.setQueryData(modelsQuery.queryKey, held.before)
    }
  },
  // Read again without holding it up: /models asks every provider first.
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: key })
  },
})

type Saving = typeof SaveProfile.payload.Type

/** By name, as the core lists them. */
const listed = (profiles: View["profiles"]) =>
  profiles.toSorted((a, b) => (a.name < b.name ? -1 : 1))

/** A profile kept, in place of what it was (renamed too) or new; a name that's taken, the core
 * refuses, so it shows nothing. */
const kept = (view: View, p: Saving) => {
  if (view.profiles.some((x) => x.name === p.name && x.name !== p.previous)) {
    return view
  }
  const was = p.previous ?? p.name
  return {
    ...view,
    active: view.active === p.previous ? p.name : view.active,
    profiles: listed([
      ...view.profiles.filter((x) => x.name !== was),
      { name: p.name, roles: p.roles },
    ]),
  }
}

export const selectProfile = mutationOptions({
  mutationFn: async (name: string) => await command(SelectProfile.type, { name }),
  ...optimistic((view, name: string) => ({ ...view, active: name })),
})
export const saveProfile = mutationOptions({
  mutationFn: async (p: Saving) =>
    await command(SaveProfile.type, Schema.decodeUnknownSync(SaveProfile.payload)(p)),
  ...optimistic(kept),
})
export const deleteProfile = mutationOptions({
  mutationFn: async (name: string) => await command(DeleteProfile.type, { name }),
  ...optimistic((view, name: string) => ({
    ...view,
    profiles: view.profiles.filter((p) => p.name !== name),
  })),
})
