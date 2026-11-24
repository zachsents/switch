// A reading window: one long reply, whole, under the space's name. Esc closes it, as ⌘W does.
import { useEffect } from "react"

import type { Reading } from "../../shared/commands.ts"
import { Markdown } from "./markdown.tsx"
import { rpc } from "./use-menu.ts"
import { usePainted } from "./use-painted.ts"

const DRAG = "electrobun-webkit-app-region-drag"

export const ReadingPage = ({ reading }: { reading: Reading }) => {
  usePainted(true)
  useEffect(() => {
    document.title = reading.title
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        rpc?.send.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
    }
  }, [reading.title])
  return (
    <div className="flex h-full flex-col bg-bg">
      <header
        className={`${DRAG} flex h-band flex-none items-center bg-bg pr-3 pl-[84px] text-ink line-1-b`}
      >
        <h1 className="sign m-0 min-w-0 truncate text-name text-ink">{reading.title}</h1>
      </header>
      <main className="selectable min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-column px-6 py-6 text-read text-ink">
          <Markdown>{reading.text}</Markdown>
        </div>
      </main>
    </div>
  )
}
