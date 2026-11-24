// Who they are, in a grid of cells edited in place: their name in parts, what the user calls them,
// who they are to the user, where they work, what they are, their labels and a note.
import type { Person } from "../answers.ts"
import { bestOf, familyOf, familySet, labelsOf, typeOf } from "../details.ts"
import type { Settable } from "../mutations.ts"
import { DetailCell } from "./detail-cell.tsx"
import { LabelsCell } from "./labels-cell.tsx"
import { TypeCell } from "./type-cell.tsx"

const PLAIN: readonly { kind: Settable; label: string }[] = [
  { kind: "nickname", label: "Nickname" },
  { kind: "relationship", label: "Relationship" },
  { kind: "company", label: "Company" },
  { kind: "role", label: "Role" },
]

export const DetailsSection = ({ person }: { person: Person }) => {
  const given = bestOf(person, "given")
  const family = familyOf(person)
  const note = bestOf(person, "note")
  return (
    <section>
      <ul className="m-0 grid list-none grid-cols-2 p-0">
        <DetailCell
          key={`given:${given}`}
          person={person.id}
          label="Given"
          value={given}
          toSet={(v) => ({ given: v })}
        />
        <DetailCell
          key={`family:${family.value}`}
          person={person.id}
          label={family.label}
          value={family.value}
          toSet={familySet}
        />
        {PLAIN.map((c) => {
          const value = bestOf(person, c.kind)
          return (
            <DetailCell
              key={`${c.kind}:${value}`}
              person={person.id}
              label={c.label}
              value={value}
              toSet={(v) => ({ [c.kind]: v })}
            />
          )
        })}
        <TypeCell person={person.id} type={typeOf(person)} />
        <LabelsCell person={person.id} labels={labelsOf(person)} />
        <DetailCell
          key={`note:${note}`}
          person={person.id}
          label="Note"
          value={note}
          toSet={(v) => ({ note: v })}
          wide
          multiline
        />
      </ul>
    </section>
  )
}
