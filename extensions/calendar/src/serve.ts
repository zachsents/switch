// Calendar's layers, and serving it on stdio, syncing.
import { Layer } from "effect"
import { AppEvents, Models, serveStdio } from "switch-ext-kit"

import { calendarApp } from "./app.ts"
import { Calendars } from "./calendars.ts"
import { loadSettings } from "./settings.ts"

export const calendarLayer = () =>
  Layer.provideMerge(Calendars.layer(loadSettings()), AppEvents.layer(calendarApp))

/** Serves Calendar on stdio, syncing, until the client goes; connections' tokens come through its host. */
export const serveCalendar = async () => {
  await serveStdio(
    calendarApp,
    Layer.provideMerge(
      Layer.provideMerge(Calendars.workers, Calendars.layer(loadSettings())),
      Models.layer,
    ),
  )
}
