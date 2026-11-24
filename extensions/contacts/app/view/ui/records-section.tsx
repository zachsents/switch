// Their cards in other books, each as its book's name, opening the card there; and where a book
// holds something else than what Switch would write.
import { LABELS, SERVICES } from "../../../src/text.ts"
import type { Person } from "../answers.ts"
import { Cells, sourceName } from "./cells.tsx"
import { Warn } from "./marks.tsx"
import { Section } from "./parts.tsx"

/** Each book's card page: Contacts on this Mac, Google Contacts on the web. */
const CARDS: Readonly<Record<string, (id: string) => string>> = {
  apple: (id) => `addressbook://${id}`,
  google: (id) => `https://contacts.google.com/person/${id.replace(/^people\//u, "")}`,
}

/** A pushed key ("first", "phone:…") as the field it is. */
const KEYS: Readonly<Record<string, string>> = { first: "Name", last: "Name", org: "Company" }
const keyName = (key: string) => {
  const [kind = key] = key.split(":")
  return KEYS[kind] ?? LABELS[kind] ?? kind
}

export const RecordsSection = ({ person }: { person: Person }) => {
  const refs = person.fields.filter((f) => f.kind === "ref")
  if (refs.length === 0 && person.conflicts.length === 0) {
    return null
  }
  return (
    <Section label="Records" count={refs.length}>
      {refs.map((f) => {
        const name = SERVICES[f.service ?? ""] ?? sourceName(f.service ?? f.source)
        const card = CARDS[f.service ?? ""]
        const url = card === undefined ? null : card(f.value)
        return (
          <Cells
            key={f.id}
            label={
              url === null ? (
                name
              ) : (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink underline-offset-2 hover:underline"
                >
                  {name}
                </a>
              )
            }
          >
            {null}
          </Cells>
        )
      })}
      {person.conflicts.map((c) => (
        <Cells
          key={`${c.target}:${c.key}`}
          label={
            <span className="flex items-center gap-2">
              <Warn size={12} />
              {sourceName(c.target)}
            </span>
          }
          source={keyName(c.key)}
        >
          {c.theirs}
          <span className="ml-2 text-small text-ink3">{c.ours}</span>
        </Cells>
      ))}
    </Section>
  )
}
