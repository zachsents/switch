// A widget shown in a chat, an app's or one the agent made: the whole column's width, rules above
// and below. A page the agent made opens at the height it was made at, then fits what it draws.
import { A2uiSurface } from "@a2ui/react"
import { useQuery } from "@tanstack/react-query"

import type { Shown } from "../brain/store.ts"
import { keyOf, MADE, surfaceQuery, useOffered } from "./host.ts"

/** The height a page opens at (the core's `withHeight`). */
const HEIGHT = /<meta name="switch-height" content="(?<px>\d+)">/u

export const ChatWidget = ({ shown, seq }: { shown: Shown; seq: number }) => {
  const offered = useOffered()
  const surface = useQuery({
    ...surfaceQuery(shown, `${keyOf(shown)}#${seq}`),
    enabled: shown.app === MADE || offered.has(keyOf(shown)),
  }).data
  if (!surface) {
    return null
  }
  const page: unknown = surface.dataModel.get("/page")
  const height = typeof page === "string" ? HEIGHT.exec(page)?.groups?.px : undefined
  return (
    <div className="-mx-inset self-stretch line-section-t">
      <div
        className="widget-cell widget-body line-section-b"
        ref={(el) => {
          if (el && height !== undefined) {
            el.style.setProperty("--a2ui-sandboxed-frame-height", `${height}px`)
          }
        }}
      >
        <A2uiSurface surface={surface} />
      </div>
    </div>
  )
}
