// A2UI's Row: its children across, each the cell it draws (its words inset from its own edges, as
// every part's are), with no gaps or padding of its own; `justify` and `align` as A2UI's own. In a
// key, its glyph and words a key's gap apart. `data-across` tells a card in it to rule its side.
import { createComponentImplementation } from "@a2ui/react"
import { RowApi } from "@a2ui/web_core/v1_0"
import { use } from "react"

import { each } from "./each.tsx"
import { ALIGN, JUSTIFY, share } from "./flex.ts"
import { InKey } from "./in-key.ts"

export const Row = createComponentImplementation(RowApi, ({ props, buildChild }) => {
  const inKey = use(InKey)
  return (
    <div
      data-across
      className={`flex ${inKey ? "items-center gap-1.5" : ""} ${props.justify ? JUSTIFY[props.justify] : ""} ${props.align ? ALIGN[props.align] : ""}`}
      style={share(props.weight)}
    >
      {each(props.children, buildChild)}
    </div>
  )
})
