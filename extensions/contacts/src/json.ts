// Reading JSON nobody promised the shape of: from a CLI, an API or a script.

export type Json = Record<string, unknown>

export const isJson = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** An object, or an empty one. */
export const rec = (v: unknown): Json => (isJson(v) ? v : {})

/** The objects in an array, or none. */
export const recs = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isJson) : [])

/** A string, trimmed, or "". */
export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A string or a number as text, untrimmed; anything else "". */
export const text = (v: unknown) => {
  if (typeof v === "string") {
    return v
  }
  if (typeof v === "number") {
    return String(v)
  }
  return ""
}

/** Each element as a string, or null where it isn't one. */
export const strings = (v: unknown): (string | null)[] =>
  Array.isArray(v) ? v.map((x: unknown) => (typeof x === "string" ? x : null)) : []

export const parse = (s: string): unknown => JSON.parse(s)
