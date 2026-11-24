import { A2uiSurface } from "@a2ui/react"
import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"

import type { WidgetWindow as Target } from "../../shared/commands.ts"
import { keyOf, surfaceQuery } from "../widgets/host.ts"
import { Boundary } from "./boundary.tsx"
import { DRAG } from "./kit/window.ts"
import { closeWindow } from "./use-menu.ts"
import { usePainted } from "./use-painted.ts"
import { useThemeSync } from "./use-theme-sync.ts"

const Content = ({ view }: { view: Target }) => {
  const query = useQuery(surfaceQuery(view, `${keyOf(view)}:window:${JSON.stringify(view.input)}`))
  usePainted(query.data !== undefined)
  if (query.isError) {
    throw query.error
  }
  return query.data ? (
    <A2uiSurface surface={query.data} />
  ) : (
    <span className="px-inset py-2 text-small text-ink2">Loading…</span>
  )
}

export const WidgetWindow = ({ view }: { view: Target }) => {
  useThemeSync()
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeWindow()
      }
    }
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("keydown", key)
    }
  }, [])
  return (
    <div className="flex h-full flex-col">
      <header className={`${DRAG} flex h-band flex-none items-center pr-3 pl-[84px] line-1-b`}>
        <h1 className="sign m-0 truncate text-name text-ink">{view.name}</h1>
      </header>
      <main data-cell className="widget-cell widget-body min-h-0 flex-1 overflow-auto">
        <Boundary>
          <Content view={view} />
        </Boundary>
      </main>
    </div>
  )
}
