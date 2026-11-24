// A2UI's Card, on the grid: no box, no rounding, no padding (CONCEPTS.md, Grid, not cards). Its child
// edge to edge, a region of its own: a line-1 parts it from what follows it (index.css), as regions
// are parted (DESIGN.md, Two lines).
import { createComponentImplementation } from "@a2ui/react"
import { CardApi } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"

export const Card = createComponentImplementation(CardApi, ({ props, buildChild }) => (
  <div data-card className="flex flex-col" style={share(props.weight)}>
    {buildChild(props.child)}
  </div>
))
