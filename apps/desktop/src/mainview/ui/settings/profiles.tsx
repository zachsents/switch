// Profiles: each a mapping of the brain's roles to a provider, a model and an account, mixed as it
// likes; the one in use picked at the top, each one's roles under its name, to change in place. New
// starts from the one in use; Duplicate and Edit open one in edit in its place.
import type { ProfilesView } from "@switch/core/profiles"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { useAuth } from "../../brain/auth.ts"
import { deleteProfile, modelsQuery, selectProfile } from "../../brain/models.ts"
import { ActionError } from "../action-error.tsx"
import { Button } from "../kit/button.tsx"
import { Segmented } from "../kit/segmented.tsx"
import { PaneScroll } from "../pane-scroll.tsx"
import { ProfileForm } from "./profile-form.tsx"
import { ProfileSection } from "./profile-section.tsx"
import { Setting } from "./setting.tsx"

type Profile = (typeof ProfilesView.Type)["profiles"][number]

const Loaded = ({ view }: { view: typeof ProfilesView.Type }) => {
  const selecting = useMutation(selectProfile)
  const removing = useMutation(deleteProfile)
  // As it was when opened: what's kept meanwhile doesn't close it.
  const [editing, setEditing] = useState<{ profile: Profile; creating: boolean } | null>(null)
  const active = view.profiles.find((p) => p.name === view.active) ?? view.profiles[0]
  const error = selecting.error ?? removing.error
  const form = (e: { profile: Profile; creating: boolean }) => (
    <ProfileForm
      key={`${e.profile.name}:${String(e.creating)}`}
      profile={e.profile}
      creating={e.creating}
      profiles={view.profiles}
      accounts={view.accounts}
      close={() => {
        setEditing(null)
      }}
    />
  )
  return (
    <>
      <Setting label="In use" w="w-32">
        {active && (
          <Segmented
            label="Profile in use"
            options={view.profiles.map((p) => ({ value: p.name, label: p.name }))}
            value={active.name}
            onChange={(name) => {
              selecting.mutate(name)
            }}
          />
        )}
        <span className="flex-1" />
        {active && (
          <Button
            look="flat"
            onClick={() => {
              setEditing({ profile: active, creating: true })
            }}
          >
            New
          </Button>
        )}
      </Setting>
      {error && (
        <div className="flex px-inset py-2 line-2-b">
          <ActionError error={error} />
        </div>
      )}
      {editing?.creating === true && form(editing)}
      {view.profiles.map((p) =>
        editing && !editing.creating && editing.profile.name === p.name ? (
          form(editing)
        ) : (
          <ProfileSection
            key={p.name}
            profile={p}
            active={p.name === active?.name}
            accounts={view.accounts}
            removing={removing.isPending}
            onDuplicate={() => {
              setEditing({ profile: p, creating: true })
            }}
            onEdit={() => {
              setEditing({ profile: p, creating: false })
            }}
            onRemove={() => {
              removing.mutate(p.name)
            }}
          />
        ),
      )}
    </>
  )
}

export const ProfilesSettings = () => {
  const auth = useAuth()
  const ready = auth !== null && "token" in auth
  const query = useQuery({ ...modelsQuery, enabled: ready })
  return (
    <PaneScroll className="flex-1">
      {query.data ? (
        <Loaded view={query.data} />
      ) : (
        <div className="flex min-h-9 flex-wrap items-center gap-2 px-inset py-1.5 line-2-b">
          {query.error ? (
            <>
              <ActionError error={query.error} />
              <Button
                look="key"
                disabled={query.isFetching || !ready}
                onClick={() => {
                  void query.refetch()
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            <span className="trim text-ui text-ink2">Loading</span>
          )}
        </div>
      )}
    </PaneScroll>
  )
}
