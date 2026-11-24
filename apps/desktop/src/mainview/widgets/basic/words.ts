// A property's words as A2UI's own parts show them: a figure or a flag as written, nothing as
// nothing.
export const wordsOf = (x: unknown) =>
  typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : ""
