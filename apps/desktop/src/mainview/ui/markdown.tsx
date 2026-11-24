// An agent's words as Markdown, with Vercel's Streamdown: it closes half-written syntax as text
// streams in and memoizes each finished block, so a reply grows without reflowing what's above.
// While a reply streams, its words come at an even pace (useSmooth) and each fades in.
// Every element is the house's: links in ink, code in mono, tables on the grid.
import { defaultRehypePlugins, Streamdown } from "streamdown"
import type { Components } from "streamdown"
import "streamdown/styles.css"

import { Code } from "./code.tsx"
import { InlineImage } from "./inline-image.tsx"
import { Link } from "./link.tsx"
import { useSmooth } from "./smooth.ts"

export const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => <Link href={href}>{children}</Link>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc pl-5 first:mt-0 last:mb-0 marker:text-ink3">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal pl-[2em] first:mt-0 last:mb-0 marker:text-ink3">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  h6: ({ children }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line-2 pl-3 text-ink2">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-line-2" />,
  code: ({ children }) => <Code>{children}</Code>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto border border-line-2 bg-bg px-3 py-2 font-mono text-small first:mt-0 last:mb-0 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-small">
      {children}
    </pre>
  ),
  // Tables on the grid: cells butt together on hairlines, figures tabular, no rounding.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="border-collapse text-ui">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border border-line-2 px-2.5 py-1.5 text-left text-small font-semibold text-ink2"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-line-2 px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
  img: ({ alt, src }) =>
    typeof src === "string" && src !== "" ? (
      <InlineImage src={src} alt={alt ?? ""} />
    ) : (
      <span className="text-ink2">{alt}</span>
    ),
}

type Plugin = (typeof defaultRehypePlugins)[string]

const isNode = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The sanitizer, letting links to pages here (`switchboard:`) and citations (`switch:`) through. */
const ownLinks = (plugin: Plugin): Plugin => {
  if (!Array.isArray(plugin)) {
    return plugin
  }
  const [sanitizer] = plugin
  const schema: unknown = plugin.at(1)
  if (!isNode(schema)) {
    return plugin
  }
  const protocols = isNode(schema.protocols) ? schema.protocols : {}
  const href = (Array.isArray(protocols.href) ? protocols.href : []).filter(
    (p): p is string => typeof p === "string",
  )
  return [
    sanitizer,
    { ...schema, protocols: { ...protocols, href: [...href, "switchboard", "switch"] } },
  ]
}

/** A link to a bare id (`[the ask](i-…)`), not a URL. */
const BARE = /^\w[\w.:-]*$/u
const SCHEME = /^(?:https?|mailto|tel|switch|switchboard|data|blob):/iu

/** A link to one of Switch's own records by its bare id becomes a page here (`switchboard://id/…`). */
const recordLinks = (node: unknown) => {
  if (!isNode(node)) {
    return
  }
  const { properties } = node
  if (node.tagName === "a" && isNode(properties)) {
    const { href } = properties
    if (typeof href === "string" && BARE.test(href) && !SCHEME.test(href)) {
      properties.href = `switchboard://id/${encodeURIComponent(href)}`
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      recordLinks(child)
    }
  }
}

/** Streamdown's own, in its order, the sanitizer letting our links through, after ids are links. */
const REHYPE = [
  () => recordLinks,
  ...Object.entries(defaultRehypePlugins).map(([name, plugin]) =>
    name === "sanitize" ? ownLinks(plugin) : plugin,
  ),
]

const NO_CONTROLS = { table: false, code: false, mermaid: false } as const
const NO_LINK_CHECK = { enabled: false } as const
/** `streaming` while the text is still being written. Streamdown memoizes itself. */
export const Markdown = ({
  children,
  streaming = false,
}: {
  children: string
  streaming?: boolean
}) => {
  const { shown, coming } = useSmooth(children, streaming)
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown
      isAnimating={coming}
      animated={false}
      controls={NO_CONTROLS}
      linkSafety={NO_LINK_CHECK}
      rehypePlugins={REHYPE}
      lineNumbers={false}
      components={components}
      className="min-w-0 max-w-full wrap-anywhere"
    >
      {shown}
    </Streamdown>
  )
}
