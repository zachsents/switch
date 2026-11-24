// A2UI's Text in the house look. Its words are simple Markdown (A2UI's basic catalog): a heading, of
// any level, draws as a widget's heading did (the house Head: a line, the UI size, semibold), the
// rest as a line's words do (Line, Field: the UI size in ink, inset from the cell's edges), wrapping.
// A caption draws as an empty state did (the house Empty: a line in ink3), its words plain, as
// A2UI's own caption's are. Words that are nothing once their headings' marks are gone draw nothing,
// as Head and Empty did; inside a key, only the words.
import { createComponentImplementation } from "@a2ui/react"
import { TextApi } from "@a2ui/web_core/v1_0"
import { use } from "react"
import type { ReactNode } from "react"
import { Streamdown } from "streamdown"
import type { Components } from "streamdown"

import { components as house } from "../../ui/markdown.tsx"
import { share } from "./flex.ts"
import { InKey } from "./in-key.ts"
import { wordsOf } from "./words.ts"

/** What's said once headings' marks are gone. */
const said = (text: string) => text.replaceAll(/^ {0,3}#{1,6}(?=[ \t]|$)/gmu, "").trim()

const Heading = ({ children }: { children?: ReactNode }) =>
  children === undefined || (Array.isArray(children) && children.length === 0) ? null : (
    <h2 data-head className="m-0 flex h-line items-center px-inset text-ui font-semibold text-ink">
      <span className="trim">{children}</span>
    </h2>
  )

const LINE = "m-0 px-inset py-1"

const components: Components = {
  ...house,
  h1: ({ children }) => <Heading>{children}</Heading>,
  h2: ({ children }) => <Heading>{children}</Heading>,
  h3: ({ children }) => <Heading>{children}</Heading>,
  h4: ({ children }) => <Heading>{children}</Heading>,
  h5: ({ children }) => <Heading>{children}</Heading>,
  h6: ({ children }) => <Heading>{children}</Heading>,
  p: ({ children }) => <p className={LINE}>{children}</p>,
  ul: ({ children }) => (
    <ul className="m-0 list-disc py-1 pr-inset pl-7 marker:text-ink3">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="m-0 list-decimal py-1 pr-inset pl-7 marker:text-ink3">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mx-inset my-1 border-l-2 border-line-2 pl-3 text-ink2">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="mx-inset my-1 overflow-x-auto border border-line-2 bg-bg px-3 py-2 font-mono text-small [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-small">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mx-inset my-1 overflow-x-auto">
      <table className="border-collapse text-ui">{children}</table>
    </div>
  ),
  hr: () => <hr className="m-0 h-(--line-2) border-0 bg-line-2" />,
}

const NO_CONTROLS = { table: false, code: false, mermaid: false } as const
const NO_LINK_CHECK = { enabled: false } as const

export const Text = createComponentImplementation(TextApi, ({ props }) => {
  const inKey = use(InKey)
  const text = wordsOf(props.text)
  if (said(text) === "") {
    return null
  }
  if (inKey) {
    return <span className="trim">{text}</span>
  }
  return props.variant === "caption" ? (
    <p
      data-caption
      className="m-0 flex h-line items-center px-inset text-ui text-ink3"
      style={share(props.weight)}
    >
      {text}
    </p>
  ) : (
    <div className="min-w-0 text-ui text-ink wrap-break-word" style={share(props.weight)}>
      <Streamdown
        mode="static"
        components={components}
        controls={NO_CONTROLS}
        linkSafety={NO_LINK_CHECK}
        lineNumbers={false}
      >
        {text}
      </Streamdown>
    </div>
  )
})
