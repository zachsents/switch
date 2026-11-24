import { Schema } from "effect"

/** Switchboard's core couldn't be read: `sb` failed, or the core refused the query. */
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  reason: Schema.String,
}) {}
