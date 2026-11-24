// Dictation into a field: the bun process runs the helper (src/bun/dictation.ts), and what it hears
// feeds the query cache, as the brain's sync does, so a view reads it with a query. There's one
// microphone, so one dictation at a time, app-wide: starting one in a field finishes any other first.
import { queryOptions } from "@tanstack/react-query"

import type { Stopped } from "../../shared/dictation.ts"
import { heardListeners, rpc } from "../ui/use-menu.ts"
import { queryClient } from "../query.ts"

export interface Listening {
  readonly status: "idle" | "starting" | "listening" | "stopping"
  /** The field it's dictating into. */
  readonly field: string | null
  /** All the words heard so far. */
  readonly words: string
  /** How loud they've been lately, oldest first, each 0 to 1. */
  readonly levels: readonly number[]
}

/** How many levels the meter keeps. */
export const LEVELS = 24

const KEY = ["dictation"] as const
const idle: Listening = { status: "idle", field: null, words: "", levels: [] }

/** Only what the bun process says writes it. */
export const dictationQuery = queryOptions({
  queryKey: KEY,
  queryFn: () => queryClient.getQueryData<Listening>(KEY) ?? idle,
  initialData: idle,
  staleTime: Infinity,
  gcTime: Infinity,
})

const now = () => queryClient.getQueryData(dictationQuery.queryKey) ?? idle
const set = (next: (l: Listening) => Listening) => {
  queryClient.setQueryData(dictationQuery.queryKey, (prev) => next(prev ?? idle))
}

/** A field's end of a dictation: all the words, and why it stopped short, if it did. */
export type Ended = (words: string, stopped?: Stopped, message?: string) => void

/** Whether this window can dictate: only in the app, where the helper is. */
export const canDictate = rpc !== undefined

let id = 0
let ended: Ended | null = null
/** A dictation asked for while another finishes. */
let next: { readonly field: string; readonly onEnd: Ended } | null = null

export const isDictating = () => now().status !== "idle"

const begin = (field: string, onEnd: Ended) => {
  id += 1
  ended = onEnd
  set(() => ({ ...idle, status: "starting", field }))
  rpc?.send.dictate({ do: "start", id })
}

/** It's over: the field gets its words; one asked for meanwhile starts. */
const end: Ended = (words, stopped, message) => {
  const done = ended
  ended = null
  set(() => idle)
  done?.(words, stopped, message)
  const then = next
  next = null
  if (then) {
    begin(then.field, then.onEnd)
  }
}

heardListeners.add((h) => {
  if (h.id !== id || now().status === "idle") {
    return
  }
  switch (h.kind) {
    case "ready": {
      set((l) => (l.status === "starting" ? { ...l, status: "listening" } : l))
      break
    }
    case "level": {
      set((l) => ({ ...l, levels: [...l.levels.slice(1 - LEVELS), h.level] }))
      break
    }
    case "words": {
      set((l) => ({ ...l, words: h.text }))
      break
    }
    case "end": {
      end(h.text, h.stopped, h.message)
      break
    }
    default: {
      h satisfies never
    }
  }
})

/** Finishes the dictation under way, keeping its words. */
export const stopDictation = () => {
  const { status } = now()
  if (status === "starting" || status === "listening") {
    set((l) => ({ ...l, status: "stopping" }))
    rpc?.send.dictate({ do: "stop" })
  }
}

/** Starts listening for `field`; `onEnd` gets the words once it's done. */
export const startDictation = (field: string, onEnd: Ended) => {
  if (!isDictating()) {
    begin(field, onEnd)
  } else if (now().field !== field) {
    next = { field, onEnd }
    stopDictation()
  }
}

/** Drops the dictation under way and its words. */
export const cancelDictation = () => {
  if (isDictating()) {
    next = null
    rpc?.send.dictate({ do: "cancel" })
    end("")
  }
}

export const openMicrophoneSettings = () => {
  rpc?.send.dictate({ do: "settings" })
}

/** The fields that take dictation, each with how to start one in it. */
const fields = new Map<HTMLElement, () => void>()

/** Lets ⌘D find a field: a ref callback's body, returning its cleanup. */
export const takesDictation = (el: HTMLElement, start: () => void) => {
  fields.set(el, start)
  return () => {
    fields.delete(el)
  }
}

/** ⌘D: finishes the dictation under way, or starts one in the field with focus, else the one in view. */
export const toggleDictation = () => {
  if (isDictating()) {
    stopDictation()
    return
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const here = focused === null ? undefined : fields.get(focused)
  const shown = [...fields].find(([el]) => el.checkVisibility())?.[1]
  const start = here ?? shown
  if (start) {
    start()
  }
}
