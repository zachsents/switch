// Whether a scroll area's content is bigger than its viewport, each way, kept current as either
// resizes: a scrollbar shows only then (scrollbar.tsx). Measured by the content's own box, so a line
// drawn past a row's edge (a pseudo-element hanging below the last row) or a picture's rounding
// doesn't count as more to scroll.
import { useState } from "react"

export const useOverflow = () => {
  const [over, setOver] = useState({ x: false, y: false })
  /** The ref for the area's content, a child of its viewport. */
  const content = (el: HTMLElement | null) => {
    const viewport = el?.parentElement ?? null
    const seen = new ResizeObserver(() => {
      if (el && viewport) {
        const box = el.getBoundingClientRect()
        const x = box.width > viewport.clientWidth + 1
        const y = box.height > viewport.clientHeight + 1
        setOver((was) => (was.x === x && was.y === y ? was : { x, y }))
      }
    })
    if (el && viewport) {
      seen.observe(el)
      seen.observe(viewport)
    }
    return () => {
      seen.disconnect()
    }
  }
  return { over, content }
}
