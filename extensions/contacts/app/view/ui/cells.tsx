// A section's line as a row of cells: what it is, its value, where it came from, how sure that is,
// and its keys. Lines grow with what they hold; the hairline keeps them apart.
import type { ReactNode } from "react"

const SOURCES: Readonly<Record<string, string>> = {
  apple: "Apple",
  google: "Google",
  imessage: "iMessage",
  gmail: "Gmail",
  email: "Email",
  texts: "Texts",
  instagram: "Instagram",
  telegram: "Telegram",
  fastpeoplesearch: "FastPeopleSearch",
  web: "Web",
  user: "You",
  agent: "Switch",
}

/** Where a field came from, as its name. */
export const sourceName = (source: string) => SOURCES[source] ?? source

export const percent = (confidence: number) => `${Math.round(confidence * 100)}%`

export const Cells = ({
  label,
  children,
  source,
  sure,
  end,
  struck = false,
}: {
  label: ReactNode
  children: ReactNode
  source?: ReactNode
  sure?: string
  end?: ReactNode
  struck?: boolean
}) => (
  <li className="group flex min-h-line items-center hairline-b last:after:hidden">
    <span className="w-label flex-none truncate px-inset text-small text-ink2">{label}</span>
    <span
      className={`selectable min-w-0 flex-1 py-2 pr-3 text-ui break-words ${struck ? "text-ink3 line-through" : "text-ink"}`}
    >
      {children}
    </span>
    {source !== undefined && (
      <span className="w-source flex-none truncate pr-3 font-mono text-data text-ink3">
        {source}
      </span>
    )}
    {sure !== undefined && (
      <span className="w-12 flex-none pr-3 text-right font-mono text-data text-ink3">{sure}</span>
    )}
    {end !== undefined && <span className="flex flex-none items-center gap-2 pr-inset">{end}</span>}
  </li>
)

/** A source's page, opened in the browser. */
export const SourceLink = ({ source, url }: { source: string; url?: string | undefined }) =>
  url === undefined || url === "" ? (
    sourceName(source)
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-ink3 underline-offset-2 hover:text-ink hover:underline"
    >
      {sourceName(source)}
    </a>
  )
