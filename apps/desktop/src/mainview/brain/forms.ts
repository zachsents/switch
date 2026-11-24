// The forms' schemas, in Effect Schema, handed to TanStack Form as Standard Schema. What a form
// sends is checked again against its command's own schema when it goes (mutations.ts).
import { Schema } from "effect"

const words = Schema.String.check(Schema.makeFilter((s: string) => s.trim() !== ""))

const dictated = Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number }))

const chosen = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    file: Schema.instanceOf(File),
    preview: Schema.optionalKey(Schema.String),
  }),
)

/** The steer box: some words to say, and where they dictated any of them. */
export const wordsForm = Schema.toStandardSchemaV1(
  Schema.Struct({ text: words, dictated, files: chosen }),
)

/** An item's ordinary reply: words only, without dictation or attachment fields. */
export const replyForm = Schema.toStandardSchemaV1(Schema.Struct({ text: words }))

/** The message box: some words, or files, or both. */
export const messageForm = Schema.toStandardSchemaV1(
  Schema.Struct({ text: Schema.String, dictated, files: chosen }).check(
    Schema.makeFilter((m) => m.text.trim() !== "" || m.files.length > 0),
  ),
)

/** The palette: what it finds by, which names a new space too. */
export const findForm = Schema.toStandardSchemaV1(Schema.Struct({ query: Schema.String }))
