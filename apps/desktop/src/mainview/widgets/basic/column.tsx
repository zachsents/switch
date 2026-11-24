// A2UI's Column as the house's Stack was (widgets/catalog.tsx): its children down the cell, each the
// full width, with no gaps or padding of its own; `justify` and `align` as A2UI's own. A camera's
// name plate on its picture finds its column by `data-column` (index.css).
import { createComponentImplementation } from "@a2ui/react"
import { ColumnApi } from "@a2ui/web_core/v1_0"

import { each } from "./each.tsx"
import { ALIGN, JUSTIFY, share } from "./flex.ts"

export const Column = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <div
    data-column
    className={`flex flex-col ${props.justify ? JUSTIFY[props.justify] : ""} ${props.align ? ALIGN[props.align] : ""}`}
    style={share(props.weight)}
  >
    {each(props.children, buildChild)}
  </div>
))
