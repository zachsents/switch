// One event, the same from every provider. Times are ms; an all-day event runs from its first day's
// local midnight to the midnight after its last.
import { Schema } from "effect"

export const response = Schema.Literals(["accepted", "declined", "tentative", "needsAction"])
export type Response = typeof response.Type

const RESPONSES: readonly Response[] = ["accepted", "declined", "tentative", "needsAction"]
/** A provider's answer word, or not yet answered. */
export const toResponse = (v: unknown): Response => RESPONSES.find((r) => r === v) ?? "needsAction"

export const person = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
  status: response,
  self: Schema.Boolean,
})
export type Person = typeof person.Type

export const event = Schema.Struct({
  /** `<calendar>/<the provider's id>`. */
  id: Schema.String,
  calendar: Schema.String,
  /** The calendar's name, as the user sees it. */
  calendarName: Schema.String,
  /** The same meeting on two calendars shares this. */
  ical: Schema.NullOr(Schema.String),
  title: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
  allDay: Schema.Boolean,
  location: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  /** A video call's link. */
  call: Schema.NullOr(Schema.String),
  status: Schema.Literals(["confirmed", "tentative", "cancelled"]),
  busy: Schema.Boolean,
  /** The user's answer, when they're invited. */
  response: Schema.NullOr(response),
  organizer: Schema.NullOr(Schema.Struct({ email: Schema.String, self: Schema.Boolean })),
  attendees: Schema.Array(person),
  recurring: Schema.Boolean,
  /** Contacts' people, by attendee email, as far as they're known. */
  people: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type Event = typeof event.Type

export interface Calendar {
  /** `google:<account>:<id>`. */
  readonly id: string
  readonly provider: "google"
  readonly account: string
  readonly remote: string
  readonly name: string
  readonly color: string | null
  readonly writable: boolean
  readonly primary: boolean
}

/** What a provider says changed: events as they are now, and the ids of ones cancelled or deleted. */
export interface Delta {
  readonly events: readonly Event[]
  readonly gone: readonly string[]
  /** A full read: anything of this calendar not in it is gone too. */
  readonly full: boolean
  /** Where the next read starts, if the provider keeps one. */
  readonly cursor: string | null
}

/** Others on it: attendees who aren't the user. */
export const others = (e: { readonly attendees: readonly Person[] }) =>
  e.attendees.filter((p) => !p.self && !p.email.endsWith("resource.calendar.google.com"))

/** It holds the user's time: busy, not declined, not cancelled. */
export const holds = (e: Event) =>
  e.busy && e.status !== "cancelled" && e.response !== "declined" && !e.allDay

/** An invite waiting on the user's answer. */
export const awaiting = (e: Event, now: number) =>
  e.status !== "cancelled" &&
  e.response === "needsAction" &&
  e.organizer?.self !== true &&
  e.end > now
