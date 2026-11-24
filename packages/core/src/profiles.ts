// Named model profiles are brain data. A brain with none is given the defaults once; from then on
// each is like any other, changed in place, renamed and removed.
import type { Database } from "bun:sqlite"
import { defineCommand, defineEvent, on } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { claude, image, SUBSCRIPTIONS } from "@switch/models"
import { Effect, Schema } from "effect"

export const ROLES = ["turn", "triage", "gate", "decision", "browse", "image"] as const
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))
export const ModelChoice = Schema.Struct({
  provider: Schema.Literals([
    "gateway",
    "claude-code",
    "codex",
    "antigravity",
    "fx",
    "workers-ai",
    "cursor",
    "opencode",
    "grok",
    "kiro",
    "pi",
    "muse",
    "acp",
  ]),
  id: Name,
  account: Schema.optionalKey(Schema.String),
})
export const NamedProfile = Schema.Struct({
  name: Name,
  roles: Schema.Struct({
    turn: ModelChoice,
    triage: ModelChoice,
    gate: ModelChoice,
    decision: ModelChoice,
    browse: ModelChoice,
    /** Profiles saved before pictures had a role draw with the default. */
    image: ModelChoice.pipe(Schema.withDecodingDefaultKey(Effect.succeed(image))),
  }),
})
export const Capability = Schema.Struct({
  host: Schema.String,
  provider: Schema.Literals(SUBSCRIPTIONS),
  available: Schema.Boolean,
  completion: Schema.optionalKey(Schema.Boolean),
  models: Schema.Array(Schema.String),
  problem: Schema.String,
  /** The email its login reports, where its CLI says. */
  email: Schema.optionalKey(Schema.String),
  /** Other logins of this account (the same email), on this machine or another, by host id. */
  same: Schema.optionalKey(Schema.Array(Schema.String)),
})
export const CatalogUpdated = defineEvent(
  "model.catalog",
  1,
  Schema.Struct({ accounts: Schema.Array(Capability) }),
)
export const ProfileSaved = defineEvent("profile.saved", 1, NamedProfile)
export const ProfileDeleted = defineEvent("profile.deleted", 1, Schema.Struct({ name: Name }))
export const ProfileSelected = defineEvent("profile.selected", 1, Schema.Struct({ name: Name }))
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(NamedProfile))
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogUpdated.payload))

export const profilesState = (db: Database) => {
  const stored = db
    .query<{ body: string }, []>("SELECT body FROM model_profiles ORDER BY name")
    .all()
    .map((r) => decodeProfile(r.body))
  const active =
    db.query<{ name: string }, []>("SELECT name FROM model_profile_active WHERE id = 1").get()
      ?.name ?? ""
  const catalog = db
    .query<{ body: string }, []>("SELECT body FROM model_catalog WHERE id = 1")
    .get()
  return {
    active,
    profiles: stored,
    accounts: catalog ? decodeCatalog(catalog.body).accounts : [],
  }
}
export const currentProfile = (db: Database) => {
  const state = profilesState(db)
  return state.profiles.find((p) => p.name === state.active) ?? claude
}

const projection: Projection = {
  name: "model_profiles",
  version: 1,
  tables: ["model_profiles", "model_profile_active", "model_catalog"],
  create: `CREATE TABLE model_profiles (name TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE model_profile_active (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE model_catalog (id INTEGER PRIMARY KEY, body TEXT NOT NULL);`,
  on: [
    on(ProfileSaved, (db, p) => {
      db.query(
        "INSERT INTO model_profiles VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      ).run(p.name, JSON.stringify(p))
    }),
    on(ProfileDeleted, (db, p) => {
      db.query("DELETE FROM model_profiles WHERE name = ?").run(p.name)
    }),
    on(ProfileSelected, (db, p) => {
      db.query(
        "INSERT INTO model_profile_active VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
      ).run(p.name)
    }),
    on(CatalogUpdated, (db, p) => {
      db.query(
        "INSERT INTO model_catalog VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(JSON.stringify(p))
    }),
  ],
  snapshot: profilesState,
}
export const completionModels = [
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
]
/** The Gateway's image models, newest of each maker; the agent can name any other. */
export const imageModels = [
  "openai/gpt-image-2.6-sunburst",
  "openai/gpt-image-2.6-flare",
  "openai/gpt-image-1-mini",
  "google/gemini-3-pro-image",
  "google/gemini-3.1-flash-image",
  "google/gemini-3.1-flash-lite-image",
  "bfl/flux-3-image",
  "bfl/flux-3-image-klein",
  "bfl/flux-kontext-max",
  "bytedance/seedream-5.5",
  "recraft/recraft-v4.1",
  "recraft/recraft-v4.1-pro",
  "spacexai/grok-imagine-image-2.0",
  "microsoft/mai-image-2.7",
  "meta/muse-image-1.0",
]
/** The Gateway's decision models: Luna, Switchboard's `decide` model, and Jev (crates/decide/src/lib.rs:10-13). */
export const decisionModels = ["openai/gpt-6-luna-decisions", "typesafe-ai/jev"]
/** The Gateway's browser models: Jev, Switchboard's, and Luna. */
export const browseModels = ["openai/gpt-6-luna-decisions", "typesafe-ai/jev"]
// On the Gateway: decisions, the browser and pictures each on the models made for them.
const gatewayOnly = {
  decision: { models: decisionModels, problem: "decision: choose Luna or Jev" },
  browse: { models: browseModels, problem: "browse: choose Luna or Jev" },
  image: { models: imageModels, problem: "image: choose a Gateway image model" },
}
const invalid = (p: typeof NamedProfile.Type, accounts: readonly (typeof Capability.Type)[]) => {
  for (const role of ROLES) {
    const m = p.roles[role]
    // Decisions and the browser may run on a subscription too, as completions (models.ts `decideOn`):
    // a profile that's all Codex. Pictures are the Gateway's only.
    if (
      role === "image" ||
      ((role === "decision" || role === "browse") && m.provider === "gateway")
    ) {
      const { models, problem } = gatewayOnly[role]
      if (m.provider !== "gateway" || !models.includes(m.id) || m.account !== undefined) {
        return problem
      }
    } else if (role === "turn" || m.provider !== "gateway") {
      if (m.provider === "workers-ai") {
        return `${role}: provider unavailable`
      }
      const provider = m.provider === "claude-code" ? "claude" : m.provider
      const matches = accounts.filter(
        (a) =>
          a.provider === provider &&
          a.available &&
          (role === "turn" || a.completion === true) &&
          (m.account === undefined || a.host === m.account || a.same?.includes(m.account) === true),
      )
      if (!matches.some((a) => a.models.includes(m.id))) {
        return `Unavailable model or account: ${m.id}`
      }
    } else if (
      m.provider !== "gateway" ||
      !completionModels.includes(m.id) ||
      m.account !== undefined
    ) {
      return `${role}: choose a Gateway completion model`
    }
  }
  return null
}
export const SaveProfile = defineCommand({
  type: "profile.save",
  payload: Schema.Struct({ ...NamedProfile.fields, previous: Schema.optionalKey(Name) }),
  load: profilesState,
  decide: (s, p) => {
    if (p.previous !== undefined && !s.profiles.some((x) => x.name === p.previous)) {
      return { reject: "No such profile" }
    }
    if (s.profiles.some((x) => x.name === p.name && x.name !== p.previous)) {
      return { reject: "Profile name exists" }
    }
    const problem = invalid(p, s.accounts)
    if (problem !== null) {
      return { reject: problem }
    }
    const renamed = p.previous !== undefined && p.previous !== p.name
    return {
      events: [
        ...(renamed && p.previous !== undefined ? [ProfileDeleted.make({ name: p.previous })] : []),
        ProfileSaved.make({ name: p.name, roles: p.roles }),
        ...(renamed && s.active === p.previous ? [ProfileSelected.make({ name: p.name })] : []),
      ],
    }
  },
})
export const SelectProfile = defineCommand({
  type: "profile.select",
  payload: ProfileSelected.payload,
  load: profilesState,
  decide: (s, p) => {
    const selected = s.profiles.find((x) => x.name === p.name)
    if (!selected) {
      return { reject: "No such profile" }
    }
    const problem = invalid(selected, s.accounts)
    return problem === null
      ? { events: s.active === p.name ? [] : [ProfileSelected.make(p)] }
      : { reject: problem }
  },
})
export const DeleteProfile = defineCommand({
  type: "profile.delete",
  payload: ProfileDeleted.payload,
  load: profilesState,
  decide: (s, p) => {
    if (s.active === p.name) {
      return { reject: "Select another profile first" }
    }
    return { events: s.profiles.some((x) => x.name === p.name) ? [ProfileDeleted.make(p)] : [] }
  },
})
export const profilesConfig = {
  events: [ProfileSaved, ProfileSelected, ProfileDeleted, CatalogUpdated],
  projections: [projection],
  commands: [SaveProfile, SelectProfile, DeleteProfile],
}

export const ProfilesView = Schema.Struct({
  active: Schema.String,
  profiles: Schema.Array(NamedProfile),
  accounts: Schema.Array(Capability),
})
