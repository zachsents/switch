// The ids the brain's records point at each other by. Each is a string on the wire, branded so one
// kind can't stand in for another.
import { Schema } from "effect"
import { sideOfThread as kitSideOf, sideThread as kitSideThread } from "switch-ext-kit"

export const SpaceId = Schema.String.pipe(Schema.brand("SpaceId"))
export type SpaceId = typeof SpaceId.Type

export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type

export const TurnId = Schema.String.pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

/** A log event's own id, not its seq. */
export const EventId = Schema.String.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

/** An action item's. */
export const ItemId = Schema.String.pipe(Schema.brand("ItemId"))
export type ItemId = typeof ItemId.Type

/** An extension's side thread (switch-ext-kit's side.ts), by its id: whose, in what space, its key. */
export const sideThread = (app: string, space: SpaceId, key: string) => {
  const id = kitSideThread(app, space, key)
  return id === null ? null : ThreadId.make(id)
}

/** Whose side thread a thread is, its space and its key; null for any other thread. */
export const sideOfThread = (thread: string) => {
  const side = kitSideOf(thread)
  return side === null ? null : { ...side, space: SpaceId.make(side.space) }
}
