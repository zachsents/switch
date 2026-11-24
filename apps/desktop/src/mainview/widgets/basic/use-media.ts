// A video's or a sound's state, as its element tells it: where it's at, how long it is, whether it
// plays; and what its transport (transport.tsx) does to it: play or pause it, move it. One plays at a
// time: one starting pauses every other on the page.
import { useRef, useState } from "react"
import type { SyntheticEvent } from "react"

export const useMedia = <E extends HTMLMediaElement>() => {
  const ref = useRef<E>(null)
  const [at, setAt] = useState(0)
  const [length, setLength] = useState(0)
  const [playing, setPlaying] = useState(false)
  const events = {
    onTimeUpdate: (e: SyntheticEvent<E>) => {
      setAt(e.currentTarget.currentTime)
    },
    onDurationChange: (e: SyntheticEvent<E>) => {
      setLength(e.currentTarget.duration)
    },
    onPlay: (e: SyntheticEvent<E>) => {
      for (const other of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
        if (other !== e.currentTarget) {
          other.pause()
        }
      }
      setPlaying(true)
    },
    onPause: () => {
      setPlaying(false)
    },
  }
  const toggle = () => {
    if (playing) {
      ref.current?.pause()
    } else {
      void ref.current?.play()
    }
  }
  const seek = (to: number) => {
    if (ref.current) {
      ref.current.currentTime = to
    }
  }
  return { ref, events, line: { at, length, playing, toggle, seek } }
}
