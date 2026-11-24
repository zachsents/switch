// The time now, every `ms` while `live`.
import { useEffect, useState } from "react"

export const useNow = (ms = 30_000, live = true) => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = live
      ? setInterval(() => {
          setNow(Date.now())
        }, ms)
      : undefined
    return () => {
      clearInterval(t)
    }
  }, [ms, live])
  return now
}
