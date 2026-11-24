// A bubble's presses, as iMessage's: over its words the page's own selection is left alone (a
// double-click selects a word, a double-click and drag selects words); off them a double-click
// opens its tapbacks for the whole message, as a right-click anywhere on it does.
import { useRef, useState } from "react"

import { nothingSelected } from "./use-copy.ts"

/** Whether a point is on the words' own letters, not the bubble around them. */
const onWords = (x: number, y: number) => {
  const at = document.caretPositionFromPoint(x, y)
  const node = at?.offsetNode
  if (!at || !node || node.nodeType !== Node.TEXT_NODE) {
    return false
  }
  const letter = document.createRange()
  letter.setStart(node, Math.max(0, at.offset - 1))
  letter.setEnd(node, Math.min(node.textContent?.length ?? 0, at.offset + 1))
  return [...letter.getClientRects()].some(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
  )
}

/** A second press off the words selects none of them: it's the whole message's. */
const pressed = (e: MouseEvent) => {
  if (e.detail === 2 && !onWords(e.clientX, e.clientY)) {
    e.preventDefault()
  }
}

/** The bubble (its tapbacks are placed by it), the ref that wires its presses, and whether its
 * tapbacks are open. A line not yet in the log (`seq` none) has none. */
export const useBubble = (seq: number | undefined) => {
  const bubble = useRef<HTMLDivElement | null>(null)
  const [reacting, setReacting] = useState(false)
  const twice = () => {
    if (nothingSelected()) {
      setReacting(true)
    }
  }
  const menu = (e: MouseEvent) => {
    e.preventDefault()
    setReacting(true)
  }
  const ref = (el: HTMLDivElement | null) => {
    bubble.current = el
    const live = seq === undefined ? null : el
    live?.addEventListener("mousedown", pressed)
    live?.addEventListener("dblclick", twice)
    live?.addEventListener("contextmenu", menu)
    return () => {
      bubble.current = null
      live?.removeEventListener("mousedown", pressed)
      live?.removeEventListener("dblclick", twice)
      live?.removeEventListener("contextmenu", menu)
    }
  }
  return { bubble, ref, reacting, setReacting }
}
