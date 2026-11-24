// A2UI's Button as the house's keys (ui/kit/button.tsx): a raised key, the primary one the green key
// that acts, a borderless one a flat key, on a line inset from the cell's edge as keys sit in a row.
// What's in it draws as a key's words and glyphs. Pressing it fires its action, through the host to
// its extension's tool, as A2UI's own does; while its checks fail it's off.
import { createComponentImplementation } from "@a2ui/react"
import { ButtonApi } from "@a2ui/web_core/v1_0"

import { Button as Key } from "../../ui/kit/button.tsx"
import { share } from "./flex.ts"
import { InKey } from "./in-key.ts"

const LOOK = { default: "key", primary: "go", borderless: "flat" } as const

export const Button = createComponentImplementation(ButtonApi, ({ props, buildChild }) => (
  <div className="flex h-line items-center px-inset" style={share(props.weight)}>
    <InKey value>
      <Key
        look={LOOK[props.variant ?? "default"]}
        disabled={props.isValid === false}
        onClick={() => {
          void props.action()
        }}
      >
        {buildChild(props.child)}
      </Key>
    </InKey>
  </div>
))
