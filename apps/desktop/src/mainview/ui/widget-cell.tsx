// One of a space's widgets in its column: its extension's A2UI surface, the column's width and its
// own height, nothing in it scrolling. Only headings and captions (an empty state's words, which
// never paint here), with nothing under them, is nothing to show: then it's out of the column until
// it has something.
import { A2uiSurface } from "@a2ui/react"
import { useQuery } from "@tanstack/react-query"

import { keyOf, surfaceQuery } from "../widgets/host.ts"

/** Whether what a widget drew is nothing to show. */
const nothing = (el: HTMLElement) => {
  const marked = [...el.querySelectorAll("[data-head], [data-caption]")]
    .map((h) => h.textContent)
    .join("")
  const words = (el.textContent ?? "").replace(marked, "").trim()
  const media = el.querySelector("img, iframe, canvas, video, svg, switch-mcp-app") !== null
  return words === "" && !media
}

export const WidgetCell = ({ app, name }: { app: string; name: string }) => {
  const surface = useQuery(surfaceQuery({ app, name })).data
  return (
    <section
      data-widget={keyOf({ app, name })}
      ref={(el) => {
        // Nothing's said until its surface is drawn: a widget still loading isn't an empty one.
        const report = () => {
          if (el && el.childElementCount > 0) {
            el.toggleAttribute("data-nothing", nothing(el))
          }
        }
        const changed = new MutationObserver(report)
        if (el) {
          changed.observe(el, { childList: true, subtree: true, characterData: true })
          report()
        }
        return () => {
          changed.disconnect()
        }
      }}
      className="widget-cell widget-body data-nothing:hidden [&_[data-caption]]:hidden"
    >
      {surface && <A2uiSurface surface={surface} />}
    </section>
  )
}
