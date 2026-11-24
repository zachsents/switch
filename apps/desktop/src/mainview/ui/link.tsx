// A link in the agent's words: another space's exchange is a chip; a page here (`switchboard://`)
// opens in this window; any other link opens in the browser.
import type { ReactNode } from "react"

import { Cite, citedSpace } from "./cite.tsx"
import { followLink } from "./links.ts"

const LINK = "text-ink underline decoration-ink3 underline-offset-2 hover:bg-hover"

export const Link = ({ href, children }: { href: string | undefined; children: ReactNode }) => {
  if (href !== undefined && citedSpace(href) !== null) {
    return <Cite href={href}>{children}</Cite>
  }
  if (href?.startsWith("switchboard:") === true) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          followLink(href)
        }}
        className={LINK}
      >
        {children}
      </a>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  )
}
