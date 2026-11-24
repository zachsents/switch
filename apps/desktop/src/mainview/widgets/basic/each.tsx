// A child list's children in order, each keyed by its id and where in the data it's drawn.
import type { ResolvedChildRef } from "@a2ui/web_core/v1_0"
import { Fragment } from "react"
import type { ReactNode } from "react"

export const each = (
  children: readonly (string | ResolvedChildRef)[],
  build: (id: string, basePath?: string) => ReactNode,
) =>
  children.map((c) => {
    const id = typeof c === "string" ? c : c.id
    const at = typeof c === "string" ? undefined : c.basePath
    return <Fragment key={`${id}@${at ?? ""}`}>{build(id, at)}</Fragment>
  })
