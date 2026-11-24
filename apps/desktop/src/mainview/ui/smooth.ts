// A streaming reply's words at an even pace. Tokens land in bursts; markstream-core's controller
// spends the backlog on each frame, faster the further behind it is, so the text flows instead of
// jumping, and it never reveals half a code fence.
import { createSmoothMarkdownStream } from "markstream-core"
import { useLayoutEffect, useState, useSyncExternalStore } from "react"

const PACE = {
  minCharsPerSecond: 60,
  maxCharsPerSecond: 3000,
  // About two bursts behind: enough to even them out, close enough to feel live.
  targetLatencyMs: 300,
  catchUpLatencyMs: 150,
  catchUpThreshold: 400,
  maxCommitFps: 60,
  maxCharsPerCommit: 120,
  startDelayMs: 0,
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)")
const onMotion = (change: () => void) => {
  reduced.addEventListener("change", change)
  return () => {
    reduced.removeEventListener("change", change)
  }
}
const isReduced = () => reduced.matches

/** How many leading characters `a` and `b` share. */
const shared = (a: string, b: string) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1
  }
  return i
}

/** Back to the last whole word, unless the cut already falls between words. */
const wholeWords = (visible: string, text: string) => {
  if (visible.length === text.length || /\s/u.test(text[visible.length] ?? " ")) {
    return visible
  }
  return visible.slice(0, visible.search(/\S*$/u))
}

/** A pacer with `shown` already on screen. */
const pacer = (shown: string) => {
  const made = createSmoothMarkdownStream(PACE)
  made.reset(shown)
  return made
}

/**
 * What of `text` to show now, and whether it's still coming in. While `live`, new text is paced;
 * what was there on mount, and text that never streamed, shows at once. When a reply's final
 * text replaces its draft, what's already shown stays and only the rest is paced.
 */
export const useSmooth = (text: string, live: boolean) => {
  const still = useSyncExternalStore(onMotion, isReduced)
  // A short start is the reply just beginning: pace it from the first word.
  const [pace, setPace] = useState(() =>
    pacer(live && text.length <= PACE.maxCharsPerCommit ? "" : text),
  )
  const { source, visible: onScreen } = pace.getSnapshot()
  if (!text.startsWith(source)) {
    // Rewritten while it streams, as the gate's trimmed reply: keep what's on screen that still
    // stands, leading whitespace aside, and pace the rest. A finished message revised in place
    // (its links put in) shows its new words at once.
    const lead = text.length - text.trimStart().length
    setPace(
      pacer(live ? text.slice(0, lead + shared(text.slice(lead), onScreen.trimStart())) : text),
    )
  }
  const visible = useSyncExternalStore(pace.subscribe, () => pace.getSnapshot().visible)

  useLayoutEffect(() => {
    pace.resume()
    pace.enqueue(text.slice(pace.getSnapshot().source.length))
    if (!live) {
      pace.finish()
    }
    if (still) {
      pace.flush()
    }
    return () => {
      // Stops the frame loop; the next run picks up where this left off.
      pace.pause()
    }
  }, [pace, text, live, still])

  const coming = live || visible.length < text.length
  return { shown: coming ? wholeWords(visible, text) : text, coming, still }
}
