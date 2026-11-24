// The band: one black strip across the top that's also the titlebar, with the pages and the lock.
import type { ReactNode } from "react"

import type { Page } from "../../shared/rpc.ts"
import { Stop } from "./marks.tsx"

const DRAG = "electrobun-webkit-app-region-drag"
export const NO_DRAG = "electrobun-webkit-app-region-no-drag"

const LABELS: Record<Page, string> = {
  items: "Items",
  generator: "Generator",
  devices: "Devices",
  grants: "Grants",
  audit: "Audit",
  import: "Import",
  export: "Export",
}

const Tab = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
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
  pages,
  onPage,
  online,
  end,
}: {
  page: Page | null
  pages: readonly Page[]
  onPage: (p: Page) => unknown
  online: boolean
  /** Keys at the band's end: Lock. */
  end?: ReactNode
}) => (
  <header
    className={`${DRAG} flex h-band flex-none items-center gap-1 bg-band pr-3 pl-[84px] text-band-ink`}
  >
    <h1 className="sign m-0 mr-4 text-title text-band-ink">Secrets</h1>
    {pages.map((p) => (
      <Tab
        key={p}
        label={LABELS[p]}
        on={p === page}
        onClick={() => {
          onPage(p)
        }}
      />
    ))}
    <span className={`${NO_DRAG} ml-auto flex items-center gap-3`}>
      {!online && (
        <span className="flex items-center gap-2 text-small text-band-ink">
          <Stop />
          Can&apos;t reach the core
        </span>
      )}
      {end}
    </span>
  </header>
)
