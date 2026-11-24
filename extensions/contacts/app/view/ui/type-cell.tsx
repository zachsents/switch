// What they are: a person, a company, a system, or unset. Sent the moment it's chosen.
import { useMutation } from "@tanstack/react-query"

import { TYPES } from "../answers.ts"
import type { PersonType } from "../answers.ts"
import { setMutation } from "../mutations.ts"
import { GridCell } from "./grid-cell.tsx"
import { Stop } from "./marks.tsx"
import { Tip } from "./parts.tsx"

const NAMES: Record<PersonType, string> = { person: "Person", company: "Company", system: "System" }

export const TypeCell = ({ person, type }: { person: string; type: PersonType | null }) => {
  const set = useMutation(setMutation)
  const shown = set.isPending && set.variables.type !== undefined ? set.variables.type : type
  return (
    <GridCell label="Type">
      <select
        aria-label="Type"
        value={shown ?? ""}
        onChange={(e) => {
          set.mutate({ person, type: TYPES.find((t) => t === e.target.value) ?? null })
        }}
        className={`h-line min-w-0 flex-1 appearance-none border-0 bg-transparent pr-3 text-ui outline-none ${shown === null ? "text-ink3" : "text-ink"}`}
      >
        <option value="">None</option>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {NAMES[t]}
          </option>
        ))}
      </select>
      {set.error !== null && (
        <Tip label={set.error.message}>
          <span className="flex flex-none items-center pr-3">
            <Stop size={12} />
          </span>
        </Tip>
      )}
    </GridCell>
  )
}
