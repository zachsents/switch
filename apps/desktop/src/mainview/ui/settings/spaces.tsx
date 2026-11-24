// Spaces: how each space with spaces inside it lists them, banner rows or plain rows. Home first,
// then the rest warmest first. The user's, per space, in the brain, shown at once.
import { HOME } from "@switch/brain/commands"
import { useMutation } from "@tanstack/react-query"

import { prefMutation } from "../../brain/mutations.ts"
import * as derive from "../../brain/derive.ts"
import { useBrain } from "../../brain/use-brain.ts"
import { Segmented } from "../kit/segmented.tsx"
import { PaneScroll } from "../pane-scroll.tsx"
import { insideKey, insideView } from "../space-view.ts"
import { Group, Setting } from "./setting.tsx"

const VIEWS = [
  { value: "banners", label: "Banners" },
  { value: "rows", label: "Rows" },
] as const

export const SpacesSettings = () => {
  const spaces = useBrain((s) =>
    derive
      .warmest(s)
      .filter((x) => derive.children(s, x.id).length > 0)
      .toSorted((a, b) => Number(b.id === HOME) - Number(a.id === HOME))
      .map((x) => ({ id: x.id, name: x.id === HOME ? "Home" : x.name, view: insideView(s, x.id) })),
  )
  const saving = useMutation(prefMutation)
  return (
    <PaneScroll className="flex-1">
      <Group label="Spaces">
        {spaces.map((x) => (
          <Setting key={x.id} label={x.name}>
            <Segmented
              label={x.name}
              options={VIEWS}
              value={x.view}
              onChange={(v) => {
                saving.mutate({ key: insideKey(x.id), value: v === "banners" ? v : "rows" })
              }}
            />
          </Setting>
        ))}
      </Group>
    </PaneScroll>
  )
}
