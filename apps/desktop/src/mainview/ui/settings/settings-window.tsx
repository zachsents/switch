// Settings, a window of its own: its sections down the left, the one open beside it. ⌘, (or a section asked for from the app) brings it forward at that section.
import { useEffect, useState } from "react"

import { Boundary } from "../boundary.tsx"
import { ConnectionsPage } from "../connections-page.tsx"
import { Button } from "../kit/button.tsx"
import { DRAG } from "../kit/window.ts"
import { MemoryPage } from "../memory-page.tsx"
import { ExtensionsPage } from "../extensions-page.tsx"
import { SystemPage } from "../system-page.tsx"
import { useNow } from "../use-now.ts"
import { closeWindow, onCommand } from "../use-menu.ts"
import { usePainted } from "../use-painted.ts"
import { useThemeSync } from "../use-theme-sync.ts"
import { Devices } from "./devices.tsx"
import { General } from "./general.tsx"
import { Notifications } from "./notifications.tsx"
import { ProfilesSettings } from "./profiles.tsx"
import { ProvidersSettings } from "./providers.tsx"
import { SpacesSettings } from "./spaces.tsx"
import { ThemeSection } from "./theme-section.tsx"

const SECTIONS = {
  general: "General",
  providers: "Providers",
  profiles: "Profiles",
  theme: "Theme",
  spaces: "Spaces",
  connections: "Connections",
  extensions: "Extensions",
  devices: "Devices",
  notifications: "Notifications",
  memory: "Memory",
  system: "System",
} as const
type Section = keyof typeof SECTIONS

const ALL = [
  "general",
  "providers",
  "profiles",
  "theme",
  "spaces",
  "connections",
  "extensions",
  "devices",
  "notifications",
  "memory",
  "system",
] as const satisfies readonly Section[]
const sectionOf = (s: string): Section => ALL.find((x) => x === s) ?? "general"

const Open = ({ section, now }: { section: Section; now: number }) => {
  switch (section) {
    case "providers": {
      return <ProvidersSettings />
    }
    case "profiles": {
      return <ProfilesSettings />
    }
    case "general": {
      return <General />
    }
    case "theme": {
      return <ThemeSection />
    }
    case "spaces": {
      return <SpacesSettings />
    }
    case "connections": {
      return <ConnectionsPage />
    }
    case "extensions": {
      return <ExtensionsPage />
    }
    case "devices": {
      return <Devices />
    }
    case "notifications": {
      return <Notifications />
    }
    case "memory": {
      return <MemoryPage />
    }
    case "system": {
      return <SystemPage now={now} />
    }
    default: {
      return section satisfies never
    }
  }
}

export const SettingsWindow = ({ opened }: { opened: string }) => {
  const [section, setSection] = useState(() => sectionOf(opened))
  const now = useNow()
  useThemeSync()
  usePainted(true)
  useEffect(() => {
    document.title = "Settings"
    const off = onCommand((c) => {
      if (c.kind === "settings") {
        setSection(sectionOf(c.section))
      }
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeWindow()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      off()
      window.removeEventListener("keydown", onKey)
    }
  }, [])
  return (
    <div className="flex h-full flex-col">
      <header className={`${DRAG} flex h-band flex-none items-center pl-[72px] line-1-b`}>
        <h1 className="sign m-0 text-name text-ink">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings" className="w-side flex-none line-1-r">
          <ul className="m-0 list-none p-0 rows">
            {ALL.map((s) => (
              <li key={s}>
                <Button
                  look="row"
                  aria-current={s === section ? "page" : undefined}
                  onClick={() => {
                    setSection(s)
                  }}
                  className="aria-[current=page]:font-semibold"
                >
                  {SECTIONS[s]}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Boundary>
            <Open section={section} now={now} />
          </Boundary>
        </main>
      </div>
    </div>
  )
}
