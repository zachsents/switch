// A fixture's surface in a widget's cell at its width, its lines round it, made from its messages by
// the same processor as an extension's widget.
import { A2uiSurface } from "@a2ui/react"
import { useQuery } from "@tanstack/react-query"

import { heldSurfaceQuery } from "../host.ts"
import type { Fixture } from "./fixtures.ts"

export const Held = ({ fixture }: { fixture: Fixture }) => {
  const query = useQuery(heldSurfaceQuery(`gallery/${fixture.id}`, fixture.messages))
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="text-small text-ink3">{fixture.name}</figcaption>
      <div
        data-fixture={fixture.id}
        className="widget-cell widget-body edge min-h-line"
        style={{ width: fixture.width }}
      >
        {query.data && <A2uiSurface surface={query.data} />}
        {query.error && <span className="p-inset text-small text-ink2">{query.error.message}</span>}
      </div>
    </figure>
  )
}
