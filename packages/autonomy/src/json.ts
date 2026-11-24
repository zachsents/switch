// Reading a model's JSON reply, which may be wrapped in prose or code fences.
const parse: (json: string) => unknown = JSON.parse

/** The first JSON object in a model's reply, or {}. */
export const jsonOf = (text: string): unknown => {
  const m = /\{[\s\S]*\}/u.exec(text)
  if (!m) {
    return {}
  }
  try {
    return parse(m[0])
  } catch {
    return {}
  }
}

export const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined)

export const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

export const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
