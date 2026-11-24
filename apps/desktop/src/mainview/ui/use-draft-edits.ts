// A card's answer form, with the user's edits of its drafts kept on this Mac at each keystroke (the
// outbox, so closing the card or the app can't lose one: another window or the next start sends
// it) and sent to the brain once typing rests, or at once when the card goes. Not an approval. The
// fields open on his newest version, kept here or saved, and take the core's newer one (his edit on
// another device, or in a draft's copy, an email draft, which the core brings in when it opens)
// unless he's typed over it here. The user, Nov 23: "why not instantly? or atleast saved locally
// instantly. i just dont wnana exit out of the window too quickly and risk losing it."
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useEffectEvent, useRef } from "react"

import { draftsMutation, editMutation, keepEdit, keptEdit } from "../brain/item-mutations.ts"
import type { ActionItem } from "../brain/items.ts"
import { shownText } from "../brain/items.ts"
import * as outbox from "../brain/outbox.ts"

const parseTexts: (json: string) => string[] = JSON.parse

/** How long typing rests before it's sent. */
const SAVE_MS = 800

export const useDraftEdits = (item: ActionItem) => {
  const drafts = item.drafts ?? []
  const shown = drafts.map((d) => shownText(item, d))
  const { mutate: save } = useMutation(editMutation)
  const { mutate: open } = useMutation(draftsMutation)
  /** His edit kept here from before (the card closed before the brain had it), read once. */
  const { data: opening } = useQuery({
    queryKey: ["kept-edit", item.id],
    queryFn: () => keptEdit(item.id),
    initialData: () => keptEdit(item.id),
    staleTime: Infinity,
    gcTime: 0,
  })
  /** What this card has kept of each draft, so its own edits coming back aren't news. */
  const mine = useRef(new Map(Object.entries(opening?.drafts ?? {})))
  /**
   * The edit kept here and not sent yet, by its command's id. One from before may be on its way
   * already, so new words go under a new id; a quiet copy sends nothing, so it keeps the one.
   */
  const pending = useRef<string | null>(outbox.QUIET ? (opening?.id ?? null) : null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The versions the fields last took from the core. */
  const seen = useRef(shown)

  /** Sends what's kept and not sent yet, now. */
  const send = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const id = pending.current
    const edit = id === null ? null : keptEdit(item.id)
    pending.current = null
    if (id !== null && edit?.id === id) {
      save({ id, edit: { id: item.id, drafts: edit.drafts } })
    }
  }

  /** Keeps his version on this Mac at once, and sends it once typing rests. */
  const keep = (left: readonly string[]) => {
    const changed = Object.fromEntries(
      drafts.flatMap((d, i) => {
        const text = left[i]
        return text === undefined || text === shown[i] ? [] : [[d.name, text]]
      }),
    )
    for (const d of drafts) {
      const text = changed[d.name]
      if (text === undefined) {
        mine.current.delete(d.name)
      } else {
        mine.current.set(d.name, text)
      }
    }
    if (Object.keys(changed).length === 0) {
      if (pending.current !== null) {
        outbox.drop(pending.current)
        pending.current = null
      }
      return
    }
    pending.current ??= crypto.randomUUID()
    keepEdit(pending.current, { id: item.id, drafts: changed }, SAVE_MS)
    if (timer.current !== null) {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(send, SAVE_MS)
  }

  const form = useForm({
    defaultValues: {
      drafts: drafts.map((d, i) => opening?.drafts[d.name] ?? shown[i] ?? d.text),
      text: "",
    },
    listeners: {
      onChange: ({ formApi }) => {
        keep(formApi.state.values.drafts)
      },
      onBlur: send,
    },
  })

  const took = useEffectEvent((versions: string) => {
    const now = parseTexts(versions)
    for (const [i, text] of now.entries()) {
      const before = seen.current[i]
      const name = drafts[i]?.name ?? ""
      if (text === before || text === mine.current.get(name)) {
        continue
      }
      // Typed here and not taken by the core yet: that goes, over this.
      if (form.getFieldValue(`drafts[${i}]`) !== before) {
        continue
      }
      form.setFieldValue(`drafts[${i}]`, text, { dontRunListeners: true })
    }
    seen.current = now
  })
  const versions = JSON.stringify(shown)
  useEffect(() => {
    took(versions)
  }, [versions])

  // The card or its window going sends the last edit at once; what doesn't make it stays kept.
  const leave = useEffectEvent(() => {
    send()
  })
  useEffect(() => {
    const away = () => {
      leave()
    }
    window.addEventListener("pagehide", away)
    return () => {
      window.removeEventListener("pagehide", away)
      leave()
    }
  }, [])

  const opened = useEffectEvent((id: string) => {
    if (drafts.length > 0) {
      open(id)
    }
  })
  useEffect(() => {
    opened(item.id)
  }, [item.id])

  return form
}
