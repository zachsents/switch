// Code in a reply copies on a click: inline, its words; in a block, the whole block. Its text stays
// selectable, and a click that ends a selection copies nothing.
import type { ReactNode } from "react"

import { nothingSelected, useCopy } from "./use-copy.ts"
import { Button } from "./kit/button.tsx"

/** In a block, the whole block. */
const blockOf = (button: HTMLElement) => button.closest("pre") ?? button

export const Code = ({ children }: { children?: ReactNode }) => {
  const { copy } = useCopy()
  return (
    <Button
      look="bare"
      title="Copy"
      onClick={(e) => {
        if (e.detail === 0 || nothingSelected()) {
          copy(blockOf(e.currentTarget).textContent)
        }
      }}
      className="inline cursor-copy text-left whitespace-[inherit] outline-none select-text focus-visible:underline"
    >
      <code className="rounded-key bg-bg px-1 py-px font-mono text-[0.9em]">{children}</code>
    </Button>
  )
}
