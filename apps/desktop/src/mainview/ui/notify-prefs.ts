// Where notifications go (this Mac, or the iPhone) and whether they're quiet while the app is open:
// the user's, kept in the brain (`pref notifications`).
export interface NotifyPrefs {
  readonly here: boolean
  readonly quietOpen: boolean
}

export const notifyPrefsOf = (v: unknown): NotifyPrefs => {
  const o = typeof v === "object" && v !== null ? v : {}
  return {
    here: !("here" in o && o.here === false),
    quietOpen: "quietOpen" in o && o.quietOpen === true,
  }
}
