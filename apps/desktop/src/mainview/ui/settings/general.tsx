// General: launching at login and updating by itself (this Mac's own), the version and Update now,
// and every shortcut.
import { useQuery } from "@tanstack/react-query"

import { Button } from "../kit/button.tsx"
import { Segmented } from "../kit/segmented.tsx"
import { PaneScroll } from "../pane-scroll.tsx"
import { localQuery, setLocal, updateNow, updateQuery } from "../use-menu.ts"
import { SHORTCUTS } from "../use-shortcuts.ts"
import { Group, Setting } from "./setting.tsx"

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const

export const General = () => {
  const local = useQuery(localQuery).data
  const update = useQuery(updateQuery).data
  return (
    <PaneScroll className="flex-1">
      <Group label="App">
        <Setting label="Launch at login">
          <Segmented
            label="Launch at login"
            options={ON_OFF}
            value={local?.login === true ? "on" : "off"}
            onChange={(v) => {
              setLocal({ login: v === "on" })
            }}
          />
        </Setting>
        {local?.error !== undefined && (
          <p role="alert" className="px-cell py-2 text-small text-red">
            {local.error}
          </p>
        )}
        <Setting label="Updates">
          <Segmented
            label="Updates"
            options={[
              { value: "auto", label: "Automatic" },
              { value: "manual", label: "Manual" },
            ]}
            value={local?.autoUpdate === false ? "manual" : "auto"}
            onChange={(v) => {
              setLocal({ autoUpdate: v === "auto" })
            }}
          />
        </Setting>
        {update && update.current !== "" && (
          <Setting label="Version">
            <span className="trim font-mono text-data text-ink">{update.current}</span>
            {update.waiting !== "" && (
              <Button look="go" onClick={updateNow}>
                Update now
              </Button>
            )}
          </Setting>
        )}
      </Group>
      <Group label="Shortcuts">
        {SHORTCUTS.map(([label, keys]) => (
          <Setting key={label} label={label}>
            <kbd className="trim font-sans text-ui text-ink">{keys}</kbd>
          </Setting>
        ))}
      </Group>
    </PaneScroll>
  )
}
