// A box's draft kept in the outbox (outbox.ts) on every change, so a crash or relaunch loses nothing
// typed, dictated or attached: put back when the box comes again, and when a message the core said
// no to is given back to it.
import { Option, Schema } from "effect"
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react"

import { chosenOf, keptOf } from "../brain/files.ts"
import type { Chosen } from "../brain/files.ts"
import * as outbox from "../brain/outbox.ts"
import { putFile } from "../brain/outbox-files.ts"
import type { Span } from "../dictation/words.ts"

const decodeSpans = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
)

const NO_SPANS: readonly Span[] = []
const NO_FILES: readonly Chosen[] = []

interface Values {
  readonly text: string
  readonly dictated: readonly Span[]
  readonly files: readonly Chosen[]
}

/** The box's form, as the draft reads and fills it. */
interface Box {
  readonly values: () => Values
  /** Calls back on each change; answers its end. */
  readonly watch: (l: () => void) => () => void
  readonly put: (v: Partial<Values>) => void
}

/** The form's defaults: the empty box, so each reset (a send, an edit put down) empties it. The
 * draft goes in once (`useBoxDraft`), never as a default, which by the next render is what's typed. */
export const EMPTY: Values = { text: "", dictated: NO_SPANS, files: NO_FILES }

/** A place's draft: its words; its files come as they're read back. */
const draftValues = (place: string): Values => {
  const d = outbox.draft(place)
  return {
    text: d?.text ?? "",
    dictated: Option.getOrNull(decodeSpans(d?.dictated)) ?? NO_SPANS,
    files: NO_FILES,
  }
}

/** A file's bytes kept as it's attached, before any upload or send reads them. */
export const keepBytes = (files: readonly Chosen[]) => {
  for (const c of files) {
    void putFile(c.id, c.file).catch(() => null)
  }
}

const filesOf = async (place: string) => {
  const got = await Promise.all((outbox.draft(place)?.files ?? []).map(chosenOf))
  return got.filter((c) => c !== null)
}

/** Keeps the form's values as `place`'s draft, unless it holds an edit. */
export const useBoxDraft = (place: string | undefined, box: Box, editing: boolean) => {
  const values = useEffectEvent(() => box.values())
  const watch = useEffectEvent((l: () => void) => box.watch(l))
  const put = useEffectEvent((v: Partial<Values>) => {
    box.put(v)
  })
  // Its words go in once per place, before it's drawn; a space shown again keeps what's in it.
  const seeded = useRef<string>(undefined)
  useLayoutEffect(() => {
    if (place !== undefined && seeded.current !== place) {
      seeded.current = place
      const { text, dictated } = draftValues(place)
      put({ text, dictated })
    }
  }, [place])
  useEffect(() => {
    if (place === undefined) {
      return () => null
    }
    // While files are read back, what's kept isn't written over.
    let reading = true
    let last = ""
    const read = async () => {
      reading = true
      const files = await filesOf(place).catch(() => null)
      reading = false
      if (files !== null) {
        put({ files })
      }
    }
    void read()
    const unwatch = watch(() => {
      if (reading || editing) {
        return
      }
      const { text, dictated, files } = values()
      const replyTo = outbox.draft(place)?.replyTo
      const d: outbox.Draft = {
        text,
        ...(dictated.length > 0 && { dictated }),
        ...(files.length > 0 && { files: files.map(keptOf) }),
        ...(replyTo !== undefined && { replyTo }),
      }
      const json = JSON.stringify(d)
      if (json !== last) {
        last = json
        outbox.setDraft(place, d)
      }
    })
    const off = outbox.onRestore((p) => {
      if (p === place) {
        const { text, dictated } = draftValues(place)
        put({ text, dictated })
        void read()
      }
    })
    return () => {
      unwatch()
      off()
    }
  }, [place, editing])
}
