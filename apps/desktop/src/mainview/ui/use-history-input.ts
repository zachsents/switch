// Back and forward from a mouse's side buttons and a two-finger swipe across the trackpad (as
// Safari: fingers to the right go back). WebKit gives a swipe as horizontal wheel events; one that
// lands where something scrolls sideways is that thing's.
import { useEffect } from "react"

import { goBack, goForward } from "./nav.ts"

/** How far a swipe goes before it counts, px, and how long a pause ends one, ms. */
const SWIPE_PX = 140
const PAUSE_MS = 250

const scrollsSideways = (target: EventTarget | null) => {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const x = getComputedStyle(el).overflowX
      if (x === "auto" || x === "scroll") {
        return true
      }
    }
  }
  return false
}

export const useHistoryInput = () => {
  useEffect(() => {
    let sum = 0
    let last = 0
    let spent = false
    const mouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        goForward()
      }
    }
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2 || scrollsSideways(e.target)) {
        return
      }
      if (e.timeStamp - last > PAUSE_MS) {
        sum = 0
        spent = false
      }
      last = e.timeStamp
      sum += e.deltaX
      if (spent) {
        return
      }
      if (sum < -SWIPE_PX) {
        spent = true
        goBack()
      } else if (sum > SWIPE_PX) {
        spent = true
        goForward()
      }
    }
    window.addEventListener("mouseup", mouse)
    window.addEventListener("wheel", wheel, { passive: true })
    return () => {
      window.removeEventListener("mouseup", mouse)
      window.removeEventListener("wheel", wheel)
    }
  }, [])
}
