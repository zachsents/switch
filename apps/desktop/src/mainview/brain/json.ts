// Reading payloads the UI didn't decode: a string or empty, an object or empty, an id.
import { SpaceId, ThreadId } from "@switch/brain/commands"

export const str = (v: unknown): string => (typeof v === "string" ? v : "")

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})

export const spaceId = (v: unknown) => SpaceId.make(str(v))

export const threadId = (v: unknown) => ThreadId.make(str(v))
