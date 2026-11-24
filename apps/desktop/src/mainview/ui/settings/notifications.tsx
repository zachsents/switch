// Notifications: where they go (this Mac or the iPhone) and whether they're quiet while the app is
// open. The user's, in the brain.
import { useMutation } from "@tanstack/react-query"

import { prefMutation } from "../../brain/mutations.ts"
import { useBrain } from "../../brain/use-brain.ts"
import { Segmented } from "../kit/segmented.tsx"
import { notifyPrefsOf } from "../notify-prefs.ts"
import type { NotifyPrefs } from "../notify-prefs.ts"
import { PaneScroll } from "../pane-scroll.tsx"
import { Group, Setting } from "./setting.tsx"

export const Notifications = () => {
  const prefs = useBrain((s) => notifyPrefsOf(s.extra.prefs.get("notifications")))
  const saving = useMutation(prefMutation)
  const set = (next: Partial<NotifyPrefs>) => {
    saving.mutate({ key: "notifications", value: { ...prefs, ...next } })
  }
  return (
    <PaneScroll className="flex-1">
      <Group label="Notifications">
        <Setting label="Send to">
          <Segmented
            label="Send to"
            options={[
              { value: "here", label: "This Mac" },
              { value: "iphone", label: "iPhone" },
            ]}
            value={prefs?.here ? "here" : "iphone"}
            onChange={(v) => {
              set({ here: v === "here" })
            }}
          />
        </Setting>
        <Setting label="While the app is open">
          <Segmented
            label="While the app is open"
            options={[
              { value: "show", label: "Show" },
              { value: "quiet", label: "Quiet" },
            ]}
            value={prefs?.quietOpen ? "quiet" : "show"}
            onChange={(v) => {
              set({ quietOpen: v === "quiet" })
            }}
          />
        </Setting>
      </Group>
    </PaneScroll>
  )
}
