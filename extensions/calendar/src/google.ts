// Google Calendar, every calendar of every connected Google account, through the REST API. The
// accounts are the user's connections; the core hands out their access tokens. Changes come
// incrementally with sync tokens.
import { Data, Effect } from "effect"

import { toResponse } from "./model.ts"
import type { Calendar, Delta, Event, Person, Response } from "./model.ts"

const API = "https://www.googleapis.com/calendar/v3"
/** How far back a full read reaches. */
const BACK_MS = 30 * 86_400_000

export class GoogleError extends Data.TaggedError("GoogleError")<{
  readonly status: number
  readonly message: string
}> {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})

/** The scope Calendar needs of a Google connection. */
export const SCOPE = "https://www.googleapis.com/auth/calendar"

const core = () => process.env.SWITCH_URL ?? "http://127.0.0.1:4871"

/** A fresh access token from the core, which holds the account's connection. */
const access = (account: string) =>
  Effect.tryPromise({
    try: async () => {
      const id = encodeURIComponent(`google:${account}`)
      const res = await fetch(`${core()}/connections/token?id=${id}`)
      const t = rec(await res.json().catch(() => ({})))
      if (!res.ok || typeof t.token !== "string") {
        throw new GoogleError({ status: 401, message: `${account} isn't connected` })
      }
      return t.token
    },
    catch: (e) =>
      e instanceof GoogleError ? e : new GoogleError({ status: 0, message: String(e) }),
  })

const call = (
  account: string,
  method: string,
  pathname: string,
  options: { readonly query?: Record<string, string>; readonly body?: unknown } = {},
) =>
  Effect.flatMap(access(account), (token) =>
    Effect.tryPromise({
      try: async () => {
        const url = new URL(`${API}${pathname}`)
        for (const [k, v] of Object.entries(options.query ?? {})) {
          url.searchParams.set(k, v)
        }
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        })
        if (res.status === 204) {
          return {}
        }
        const body: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new GoogleError({
            status: res.status,
            message: str(rec(rec(body).error).message) || `Google said ${res.status}`,
          })
        }
        return rec(body)
      },
      catch: (e) =>
        e instanceof GoogleError ? e : new GoogleError({ status: 0, message: String(e) }),
    }),
  )

const calendarPath = (remote: string) => `/calendars/${encodeURIComponent(remote)}`

export const calendarsOf = (account: string) =>
  Effect.map(
    call(account, "GET", "/users/me/calendarList", { query: { maxResults: "250" } }),
    (r): Calendar[] =>
      list(r.items).map((raw) => {
        const c = rec(raw)
        const remote = str(c.id)
        const role = str(c.accessRole)
        return {
          id: `google:${account}:${remote}`,
          provider: "google",
          account,
          remote,
          name: str(c.summaryOverride) || str(c.summary) || remote,
          color: str(c.backgroundColor) || null,
          writable: role === "owner" || role === "writer",
          primary: c.primary === true,
        }
      }),
  )

/** A date or date-time as ms; a date is local midnight. */
const when = (v: unknown) => {
  const t = rec(v)
  if (typeof t.dateTime === "string") {
    return { ms: Date.parse(t.dateTime), allDay: false }
  }
  const [y = 1970, m = 1, d = 1] = str(t.date).split("-").map(Number)
  return { ms: new Date(y, m - 1, d).getTime(), allDay: true }
}

const callOf = (g: Record<string, unknown>) => {
  if (typeof g.hangoutLink === "string") {
    return g.hangoutLink
  }
  const video = list(rec(g.conferenceData).entryPoints)
    .map(rec)
    .find((p) => p.entryPointType === "video")
  return video === undefined ? null : str(video.uri) || null
}

const statuses = ["confirmed", "tentative", "cancelled"] as const
type Status = (typeof statuses)[number]
const toStatus = (v: unknown): Status => statuses.find((s) => s === v) ?? "confirmed"

export const toEvent = (calendar: Calendar, g: Record<string, unknown>): Event => {
  const start = when(g.start)
  const end = when(g.end)
  const attendees: Person[] = list(g.attendees).map((raw) => {
    const a = rec(raw)
    return {
      email: str(a.email).toLowerCase(),
      name: str(a.displayName),
      status: toResponse(a.responseStatus),
      self: a.self === true,
    }
  })
  const organizer = isRecord(g.organizer)
    ? { email: str(g.organizer.email).toLowerCase(), self: g.organizer.self === true }
    : null
  const me = attendees.find((a) => a.self)
  let response: Response | null = null
  if (me !== undefined) {
    response = me.status
  } else if (organizer?.self === true) {
    response = "accepted"
  }
  return {
    id: `${calendar.id}/${str(g.id)}`,
    calendar: calendar.id,
    calendarName: calendar.name,
    ical: str(g.iCalUID) || null,
    title: str(g.summary) || "(No title)",
    start: start.ms,
    end: Number.isNaN(end.ms) ? start.ms + 3_600_000 : end.ms,
    allDay: start.allDay,
    location: str(g.location) || null,
    notes: str(g.description) || null,
    call: callOf(g),
    status: toStatus(g.status),
    busy: g.transparency !== "transparent",
    response,
    organizer,
    attendees,
    recurring: typeof g.recurringEventId === "string",
  }
}

/**
 * What changed in a calendar since `cursor` (its sync token): every event from a month back when
 * there's none, or when Google lets the token lapse (410).
 */
export const read = (
  calendar: Calendar,
  cursor: string | null,
): Effect.Effect<Delta, GoogleError> =>
  Effect.gen(function* reading() {
    const events: Event[] = []
    const gone: string[] = []
    let page: string | undefined
    let next: string | null = null
    for (;;) {
      const query: Record<string, string> = { singleEvents: "true", maxResults: "2500" }
      if (cursor === null) {
        query.timeMin = new Date(Date.now() - BACK_MS).toISOString()
      } else {
        query.syncToken = cursor
      }
      if (page !== undefined) {
        query.pageToken = page
      }
      const r = yield* call(calendar.account, "GET", `${calendarPath(calendar.remote)}/events`, {
        query,
      })
      for (const raw of list(r.items)) {
        const g = rec(raw)
        if (g.status === "cancelled") {
          gone.push(`${calendar.id}/${str(g.id)}`)
        } else {
          events.push(toEvent(calendar, g))
        }
      }
      page = typeof r.nextPageToken === "string" ? r.nextPageToken : undefined
      next = typeof r.nextSyncToken === "string" ? r.nextSyncToken : next
      if (page === undefined) {
        break
      }
    }
    return { events, gone, full: cursor === null, cursor: next }
  }).pipe(
    Effect.catchIf(
      (e) => e.status === 410 && cursor !== null,
      () => read(calendar, null),
    ),
  )

/** What a write sends: Google's own fields. */
export interface Fields {
  readonly title?: string
  readonly start?: number
  readonly end?: number
  readonly allDay?: boolean
  readonly timeZone?: string
  readonly location?: string | null
  readonly notes?: string | null
  readonly busy?: boolean
  readonly attendees?: readonly string[]
  readonly call?: boolean
}

const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const body = (f: Fields): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const tz = f.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (f.title !== undefined) {
    out.summary = f.title
  }
  if (f.start !== undefined) {
    out.start =
      f.allDay === true
        ? { date: day(f.start) }
        : { dateTime: new Date(f.start).toISOString(), timeZone: tz }
  }
  if (f.end !== undefined) {
    out.end =
      f.allDay === true
        ? { date: day(f.end) }
        : { dateTime: new Date(f.end).toISOString(), timeZone: tz }
  }
  if (f.location !== undefined) {
    out.location = f.location ?? ""
  }
  if (f.notes !== undefined) {
    out.description = f.notes ?? ""
  }
  if (f.busy !== undefined) {
    out.transparency = f.busy ? "opaque" : "transparent"
  }
  if (f.attendees !== undefined) {
    out.attendees = f.attendees.map((email) => ({ email }))
  }
  if (f.call === true) {
    out.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    }
  }
  return out
}

/** `notify`: Google emails the guests. Only after the user approved it. */
const sendUpdates = (notify: boolean) => (notify ? "all" : "none")

const remoteOf = (calendar: Calendar, id: string) => id.slice(calendar.id.length + 1)

export const insert = (calendar: Calendar, f: Fields, notify: boolean) =>
  Effect.map(
    call(calendar.account, "POST", `${calendarPath(calendar.remote)}/events`, {
      query: { sendUpdates: sendUpdates(notify), conferenceDataVersion: "1" },
      body: body(f),
    }),
    (g) => toEvent(calendar, g),
  )

/** An event from a line of text, as Google reads it ("Lunch with Robin tomorrow at noon"). Emails no one. */
export const quickAdd = (calendar: Calendar, text: string) =>
  Effect.map(
    call(calendar.account, "POST", `${calendarPath(calendar.remote)}/events/quickAdd`, {
      query: { text, sendUpdates: "none" },
    }),
    (g) => toEvent(calendar, g),
  )

export const patch = (
  calendar: Calendar,
  id: string,
  f: Fields & { readonly status?: Status },
  notify: boolean,
) =>
  Effect.map(
    call(calendar.account, "PATCH", eventPath(calendar, id), {
      query: { sendUpdates: sendUpdates(notify), conferenceDataVersion: "1" },
      body: { ...body(f), ...(f.status === undefined ? {} : { status: f.status }) },
    }),
    (g) => toEvent(calendar, g),
  )

export const remove = (calendar: Calendar, id: string, notify: boolean) =>
  Effect.asVoid(
    call(calendar.account, "DELETE", eventPath(calendar, id), {
      query: { sendUpdates: sendUpdates(notify) },
    }),
  )

const eventPath = (calendar: Calendar, id: string) =>
  `${calendarPath(calendar.remote)}/events/${encodeURIComponent(remoteOf(calendar, id))}`

/** The user's answer to an invite; with `notify`, Google tells the organizer by email. */
export const respond = (calendar: Calendar, id: string, answer: Response, notify: boolean) =>
  Effect.gen(function* responding() {
    const g = yield* call(calendar.account, "GET", eventPath(calendar, id))
    const attendees = list(g.attendees).map((raw) => {
      const a = rec(raw)
      return a.self === true ? { ...a, responseStatus: answer } : a
    })
    const after = yield* call(calendar.account, "PATCH", eventPath(calendar, id), {
      query: { sendUpdates: sendUpdates(notify) },
      body: { attendees },
    })
    return toEvent(calendar, after)
  })
