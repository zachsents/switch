// The band: one black strip across the top that's also the titlebar, with the page's name.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { linkQuery } from "../brain.ts"
import { Stop } from "./marks.tsx"

const DRAG = "electrobun-webkit-app-region-drag"
const NO_DRAG = "electrobun-webkit-app-region-no-drag"

const Page = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={`${NO_DRAG} sign flex h-10 items-center rounded-row px-2 text-name outline-none hover:bg-band-wash hover:text-band-ink focus-visible:bg-band-wash ${on ? "text-band-ink" : "text-band-ink2"}`}
  >
    {label}
  </button>
)

export const Band = ({
  page,
  onPeople,
  onChanges,
  live,
}: {
  page: "people" | "changes"
  onPeople: () => void
  onChanges: () => void
  /** What's running or went wrong across the window: an import, an undo. */
  live: ReactNode
}) => {
  const { data: link } = useQuery(linkQuery)
  return (
    <header
      className={`${DRAG} flex h-band flex-none items-center gap-1 bg-band pr-3 pl-[84px] text-band-ink`}
    >
      <h1 className="sign m-0 mr-4 text-title text-band-ink">Contacts</h1>
      <Page label="People" on={page === "people"} onClick={onPeople} />
      <Page label="Changes" on={page === "changes"} onClick={onChanges} />
      <span className="ml-auto flex items-center gap-3">
        {live}
        {link === "down" && (
          <span className="flex items-center gap-2 text-small text-band-ink">
            <Stop />
            Can&apos;t reach the core
          </span>
        )}
      </span>
    </header>
  )
}
