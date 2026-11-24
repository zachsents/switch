// A2UI's Icon: one of its names as old Switchboard drew it (plain's a2ui-gpui: Phosphor, bold), or
// its own `svgPath`, in the ink around it. On its own it sits on a line, inset from the cell's edge,
// as a row's mark does; inside a key, only the glyph. A name it doesn't know keeps the glyph's room,
// as old Switchboard's did.
import { createComponentImplementation } from "@a2ui/react"
import { IconApi } from "@a2ui/web_core/v1_0"
import { use } from "react"

import { share } from "./flex.ts"
import { Glyph } from "./glyph.tsx"
import { ICONS, isIcon } from "./icons.ts"
import { InKey } from "./in-key.ts"

const glyphOf = (name: unknown) => {
  if (typeof name === "string") {
    return isIcon(name) ? <Glyph d={ICONS[name]} /> : <span className="block size-3.5 flex-none" />
  }
  const path: unknown = typeof name === "object" && name !== null && Reflect.get(name, "svgPath")
  return typeof path === "string" ? (
    <Glyph d={path} box={24} />
  ) : (
    <span className="block size-3.5 flex-none" />
  )
}

export const Icon = createComponentImplementation(IconApi, ({ props }) => {
  const inKey = use(InKey)
  const glyph = glyphOf(props.name)
  return inKey ? (
    glyph
  ) : (
    <span className="flex h-line items-center px-inset text-ink" style={share(props.weight)}>
      {glyph}
    </span>
  )
})
