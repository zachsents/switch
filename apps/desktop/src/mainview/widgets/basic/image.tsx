// A2UI's Image as the house's Picture was (widgets/catalog.tsx): edge to edge, the cell's whole width
// at the picture's own ratio, painted on the first frame, and nothing without a url A2UI's own would
// show (http, https or data). A small one is a picture at old Switchboard's sizes (plain's
// a2ui-gpui): an icon 24, an avatar 40 and round, a small feature 100 wide, each inset from the
// cell's edge; a header the whole width and 200 tall. `fit` fits a picture to a fixed size, `cover`
// when unsaid, as A2UI's own does.
import { createComponentImplementation } from "@a2ui/react"
import { ImageApi, sanitizeMediaUrl } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"
import { wordsOf } from "./words.ts"

const SIZE = {
  icon: "mx-inset size-6",
  avatar: "mx-inset size-10 rounded-full",
  smallFeature: "mx-inset w-[100px]",
  mediumFeature: "w-full",
  largeFeature: "w-full",
  header: "h-[200px] w-full",
} as const

const FIT = {
  contain: "object-contain",
  cover: "object-cover",
  fill: "object-fill",
  none: "object-none",
  scaleDown: "object-scale-down",
} as const

export const Image = createComponentImplementation(ImageApi, ({ props }) => {
  const url = sanitizeMediaUrl(props.url)
  return url === undefined ? null : (
    <div style={share(props.weight)}>
      <img
        src={url}
        alt={wordsOf(props.description)}
        decoding="sync"
        className={`block ${SIZE[props.variant ?? "mediumFeature"]} ${FIT[props.fit ?? "cover"]}`}
      />
    </div>
  )
})
