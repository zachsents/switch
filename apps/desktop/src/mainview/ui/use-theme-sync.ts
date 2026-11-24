// Keeps this window's theme and the brain's in step: the brain's pref (set on another Mac or the
// iPhone) is the theme's one home and shows here; a change made here shows at once and is kept in
// the outbox, due to the brain a moment after the last edit, so quitting mid-edit loses nothing.
// This Mac's copy (theme.ts) only paints the first frame before the brain's comes. The text size
// goes to every window (the bun process zooms them), and where notifications go to this Mac's
// notifier.
import { castDraft } from "immer"
import { Option, Schema } from "effect"
import { useEffect } from "react"

import { change } from "../brain/client.ts"
import * as outbox from "../brain/outbox.ts"
import { useBrain } from "../brain/use-brain.ts"
import { notifyPrefsOf } from "./notify-prefs.ts"
import { showTheme, themeOf, useTheme, ZOOM } from "./theme.ts"
import type { Theme } from "./theme.ts"
import { rpc } from "./use-menu.ts"

const SAVE_MS = 600
const decodePref = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))

/** The theme kept in the outbox and not yet taken by the brain, the newest. */
const keptTheme = () =>
  outbox.latest("pref.set", (p) => Option.getOrNull(decodePref(p))?.key === "theme")

/** Shows a theme now and keeps it for the brain, sent once the edits stop. */
export const useSetTheme = () => (t: Theme) => {
  showTheme(t)
  change((s) => {
    s.extra.prefs.set("theme", castDraft(t))
  })
  // The same one while it waits; one that may be on its way already isn't changed under it.
  const had = keptTheme()
  const waiting = had?.due !== undefined && had.due > Date.now() + 100
  outbox.keep({
    id: waiting ? had.id : crypto.randomUUID(),
    kind: "command",
    name: "pref.set",
    payload: { key: "theme", value: t },
    due: Date.now() + SAVE_MS,
  })
}

export const useThemeSync = () => {
  const held = useBrain((s) => s.extra.prefs.get("theme"))
  useEffect(() => {
    const t = themeOf(held)
    // One kept here and not yet taken is newer than what the brain says.
    if (t && keptTheme() === undefined) {
      showTheme(t, true)
    }
  }, [held])
  const { size } = useTheme()
  useEffect(() => {
    rpc?.send.zoom({ factor: ZOOM[size] })
  }, [size])
  const here = useBrain((s) => notifyPrefsOf(s.extra.prefs.get("notifications")).here)
  const quietOpen = useBrain((s) => notifyPrefsOf(s.extra.prefs.get("notifications")).quietOpen)
  useEffect(() => {
    rpc?.send.notify({ here, quietOpen })
  }, [here, quietOpen])
}
