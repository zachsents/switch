// A control's value: what the surface's data model holds, written back as it's changed (A2UI's
// two-way binding). One bound to nothing keeps what was last chosen in it, as A2UI's own controls
// and old Switchboard's did; whatever the model holds next shows at once.
import { useState } from "react"

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const useHeld = <T>(value: T, write: (next: T) => void) => {
  const [mine, setMine] = useState({ was: value, now: value })
  const shown = same(mine.was, value) ? mine.now : value
  const set = (next: T) => {
    setMine({ was: value, now: next })
    write(next)
  }
  return [shown, set] as const
}
