// Durations in plain words, as Plain's Clock takes them, read without a model: "5 minutes",
// "1:30", "1h 30m", "90s", "until 3pm". A bare number is minutes.

const UNITS = { h: 3_600_000, m: 60_000, s: 1000 }

const unit = (word: string) => {
  if (word.startsWith("h")) {
    return UNITS.h
  }
  if (word.startsWith("s")) {
    return UNITS.s
  }
  return word.startsWith("m") ? UNITS.m : null
}

// Time to the next `3pm`, `15:30` or `9:05am`.
const until = (text: string, now: Date) => {
  const match = /^(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<half>am|pm)?$/u.exec(text)
  if (!match?.groups) {
    return null
  }
  let hours = Number(match.groups.h)
  const minutes = Number(match.groups.m ?? 0)
  const { half } = match.groups
  if (half === "pm" && hours < 12) {
    hours += 12
  }
  if (half === "am" && hours === 12) {
    hours = 0
  }
  if (hours > 23 || minutes > 59) {
    return null
  }
  const end = new Date(now)
  end.setHours(hours, minutes, 0, 0)
  if (end <= now) {
    end.setDate(end.getDate() + 1)
  }
  return end.getTime() - now.getTime()
}

/** Milliseconds, or null when it can't be read. */
export const parseDuration = (input: string, now = new Date()): number | null => {
  const text = input.trim().toLowerCase()
  if (text.startsWith("until ")) {
    return until(text.slice(6).trim(), now)
  }
  if (/^\d+(?:\.\d+)?$/u.test(text)) {
    return Number(text) * UNITS.m
  }
  const clock = /^(?:(?<h>\d+):)?(?<m>\d{1,2}):(?<s>\d{2})$/u.exec(text)
  if (clock?.groups) {
    const { h = 0, m, s } = clock.groups
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000
  }
  let ms = 0
  let rest = text
  for (const part of text.matchAll(/(?<n>\d+(?:\.\d+)?)\s*(?<word>[a-z]+)/gu)) {
    const size = unit(part.groups?.word ?? "")
    if (size === null) {
      return null
    }
    ms += Number(part.groups?.n) * size
    rest = rest.replace(part[0], "")
  }
  if (ms === 0 || rest.replaceAll(/\s|and|,/gu, "") !== "") {
    return null
  }
  return Math.round(ms)
}
