// A2UI's List as the house's Lines were (widgets/catalog.tsx): its children down, with no rules or
// gaps of its own. Across (`direction: "horizontal"`), each child an equal column, as the house Row's
// children are; `align` as A2UI's own.
import { createComponentImplementation } from "@a2ui/react"
import { ListApi } from "@a2ui/web_core/v1_0"

import { each } from "./each.tsx"
import { ALIGN, share } from "./flex.ts"

export const List = createComponentImplementation(ListApi, ({ props, buildChild }) =>
  props.direction === "horizontal" ? (
    <ul
      data-across
      className={`m-0 grid list-none auto-cols-[minmax(0,1fr)] grid-flow-col p-0 ${props.align ? ALIGN[props.align] : ""}`}
      style={share(props.weight)}
    >
      {each(props.children, buildChild)}
    </ul>
  ) : (
    <ul
      className={`m-0 flex list-none flex-col p-0 ${props.align ? ALIGN[props.align] : ""}`}
      style={share(props.weight)}
    >
      {each(props.children, buildChild)}
    </ul>
  ),
)
