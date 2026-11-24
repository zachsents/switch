// A2UI's Divider: a line-2, the line within a region (DESIGN.md, Two lines), across the cell, or down
// it beside what's in a row (Base UI's Separator).
import { createComponentImplementation } from "@a2ui/react"
import { Separator } from "@base-ui/react/separator"
import { DividerApi } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"

export const Divider = createComponentImplementation(DividerApi, ({ props }) =>
  props.axis === "vertical" ? (
    <Separator
      orientation="vertical"
      className="w-(--line-2) flex-none self-stretch bg-line-2"
      style={share(props.weight)}
    />
  ) : (
    <Separator className="h-(--line-2) flex-none bg-line-2" style={share(props.weight)} />
  ),
)
