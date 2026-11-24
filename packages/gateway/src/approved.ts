// What the user approved, while it's being sent. An approved item's `send` runs through an extension
// that may itself call another's tool that speaks (an email tool calling the mail account's send):
// that inner call carries the user's own approved words, so the outbound gate doesn't hold it again.
// Only words he approved, to no address he didn't approve, from the app his approval runs through,
// while it runs: changed words, words he never saw, another recipient, or any other app's call go
// through the gate as before.

/** Words the user would read: prose, not ids or numbers. */
const isWords = (v: unknown): v is string => typeof v === "string" && /\s/u.test(v.trim())

/** Every run of words in a call's args, trimmed, nested ones included. */
export const wordsIn = (v: unknown): readonly string[] => {
  if (isWords(v)) {
    return [v.trim()]
  }
  if (Array.isArray(v)) {
    return v.flatMap(wordsIn)
  }
  if (typeof v === "object" && v !== null) {
    return Object.values(v).flatMap(wordsIn)
  }
  return []
}

/** Every string in a call's args, nested ones included. */
const stringsIn = (v: unknown): readonly string[] => {
  if (typeof v === "string") {
    return [v.trim()]
  }
  if (Array.isArray(v)) {
    return v.flatMap(stringsIn)
  }
  if (typeof v === "object" && v !== null) {
    return Object.values(v).flatMap(stringsIn)
  }
  return []
}

/** Args naming who a call reaches. */
const RECIPIENT = /^(?:to|cc|bcc|recipients?|phone|number)$/iu

/** Who a call would reach, as its args name them, nested ones included. */
const reachedBy = (v: unknown): readonly string[] => {
  if (Array.isArray(v)) {
    return v.flatMap(reachedBy)
  }
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).flatMap(([k, x]) => (RECIPIENT.test(k) ? stringsIn(x) : reachedBy(x)))
  }
  return []
}

export const approvals = () => {
  const live = new Map<string, Set<ReadonlySet<string>>>()

  return {
    /** Runs `run`, the user's approved call to `app` with these args, its words and addresses his while it runs. */
    within: async <A>(
      app: string,
      args: Record<string, unknown>,
      run: () => Promise<A>,
    ): Promise<A> => {
      const approved: ReadonlySet<string> = new Set(stringsIn(args))
      const forApp = live.get(app) ?? new Set()
      live.set(app, forApp)
      forApp.add(approved)
      try {
        return await run()
      } finally {
        forApp.delete(approved)
        if (forApp.size === 0) {
          live.delete(app)
        }
      }
    },
    /** Whether `by`'s call with these args says only what the user approved on an approval it's sending now. */
    covers: (by: string, args: Record<string, unknown>) => {
      const said = wordsIn(args)
      if (said.length === 0) {
        return false
      }
      const reaches = reachedBy(args)
      return [...(live.get(by) ?? [])].some(
        (approved) => said.every((w) => approved.has(w)) && reaches.every((a) => approved.has(a)),
      )
    },
  }
}
