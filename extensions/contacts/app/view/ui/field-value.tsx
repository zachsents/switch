// A field's value as people read it, a handle as a link to its profile.
import { pretty, profileUrl } from "../../../src/text.ts"
import type { Field } from "../answers.ts"

/** A handle as a link to its profile, anything else as people read it. */
export const FieldValue = ({ field }: { field: Field }) => {
  const url = profileUrl(field)
  return url === null ? (
    pretty(field)
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-ink underline-offset-2 hover:underline"
    >
      {pretty(field)}
    </a>
  )
}
