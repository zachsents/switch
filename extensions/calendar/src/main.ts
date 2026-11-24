// Calendar as a stdio MCP server (`bun src/main.ts`), or on its own:
//   sync            read every calendar once and print each one's count, telling no brain
// Settings in ~/.switch/calendar.json; state in ~/.switch/calendar/.
import { Effect } from "effect"

import { Calendars } from "./calendars.ts"
import { calendarLayer, serveCalendar } from "./serve.ts"

const command = process.argv.at(2)

if (command === "sync") {
  const out = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* syncing() {
        const c = yield* Calendars
        return yield* c.pull
      }),
    ).pipe(Effect.provide(calendarLayer())),
  )
  for (const s of out) {
    process.stdout.write(
      `${s.provider}\t${s.account}\t${s.name}\t${s.events}${s.error === undefined ? "" : `\t${s.error}`}\n`,
    )
  }
} else {
  await serveCalendar()
}
