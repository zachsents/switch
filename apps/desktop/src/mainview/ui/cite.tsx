// A reply's citation of an exchange in another space (`switch://space/<id>?seq=…`), drawn as a chip
// that opens that space.
import type { ReactNode } from "react"

import { spaceId } from "../brain/json.ts"
import { openSpace } from "./nav.ts"
import { Button } from "./kit/button.tsx"

const PREFIX = "switch://space/"

/** The space a citation link opens, or null for any other link. */
export const citedSpace = (href: string | undefined) => {
  if (href?.startsWith(PREFIX) !== true) {
    return null
  }
  const id = decodeURIComponent(href.slice(PREFIX.length).split(/[?#]/u)[0] ?? "")
  return id === "" ? null : spaceId(id)
}

export const Cite = ({ href, children }: { href: string; children: ReactNode }) => (
  <Button
    look="bare"
    onClick={() => {
      const space = citedSpace(href)
      if (space !== null) {
        openSpace(space)
      }
    }}
    className="inline-flex h-5 items-center rounded-key bg-bg px-1 align-baseline text-small text-ink2 outline-none hover:lit focus-visible:focused"
  >
    {children}
  </Button>
)
