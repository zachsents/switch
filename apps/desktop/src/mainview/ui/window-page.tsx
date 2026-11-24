// A window of one thing: an ask, a reply's words, a widget, or Settings. The bun process keeps one
// loaded, hidden and on the brain ahead of time and tells it what to show (`#window`); it says once
// it has drawn that, and comes on screen. In a browser, the hash says (`#settings=`, `#widget=`).
import { Schema } from "effect"

import type { Shows } from "../../shared/commands.ts"
import { WidgetWindow as Widget } from "../../shared/commands.ts"
import { ItemWindow } from "./item-window.tsx"
import { ReadingPage } from "./reading-page.tsx"
import { SettingsWindow } from "./settings/settings-window.tsx"
import { rpc, useShows } from "./use-menu.ts"
import { useSeen } from "./use-painted.ts"
import { WidgetWindow } from "./widget-window.tsx"

const readWidget = Schema.decodeUnknownOption(Schema.fromJsonString(Widget))

const fromHash = (hash: string): Shows | null => {
  const at = hash.indexOf("=")
  if (at === -1) {
    return null
  }
  const key = hash.slice(1, at)
  const given = decodeURIComponent(hash.slice(at + 1))
  if (key === "settings") {
    return { kind: "settings", section: given }
  }
  const view = readWidget(given)
  return key === "widget" && view._tag === "Some" ? { kind: "widget", view: view.value } : null
}

const hashed = fromHash(location.hash)

const Page = ({ shows }: { shows: Shows }) => {
  switch (shows.kind) {
    case "item": {
      return <ItemWindow target={shows.item} />
    }
    case "read": {
      return <ReadingPage reading={shows.reading} />
    }
    case "widget": {
      return <WidgetWindow view={shows.view} />
    }
    case "settings": {
      return <SettingsWindow opened={shows.section} />
    }
    default: {
      return shows satisfies never
    }
  }
}

export const WindowPage = () => {
  const shows = useShows() ?? hashed
  useSeen(shows !== null)
  return (
    shows && (
      <div
        className="h-full"
        ref={() => {
          // Drawn: on screen now.
          rpc?.send.ready()
        }}
      >
        <Page shows={shows} />
      </div>
    )
  )
}
