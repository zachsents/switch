// A field's dictation controls: the mic; while it listens, a meter of their voice, × to drop it and
// ✓ to keep the words. Why the last one stopped short sits above the box, as an error does.
import type { ReactNode } from "react"

import type { Stopped } from "../../shared/dictation.ts"
import { LEVELS, openMicrophoneSettings } from "../dictation/dictation.ts"
import type { Listening } from "../dictation/dictation.ts"
import { Button } from "./kit/button.tsx"

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    aria-hidden
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="block flex-none"
  >
    {children}
  </svg>
)

const Flat = ({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) => (
  <Button look="flat" aria-label={label} onClick={onClick} className="w-key px-0!">
    {children}
  </Button>
)

export const Mic = ({ onClick }: { onClick: () => void }) => (
  <Flat label="Dictate" onClick={onClick}>
    <Glyph>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.25 7.5 a4.75 4.75 0 0 0 9.5 0 M8 12.25 V14.5" />
    </Glyph>
  </Flat>
)

/** The meter's bars: places, not items, so the newest level moves along them. */
const BARS = Array.from({ length: LEVELS }, (_, i) => `bar-${i}`)

/** How loud they've been lately, newest on the right; it pulses until it hears, and as it finishes. */
const Meter = ({ levels, busy }: { levels: readonly number[]; busy: boolean }) => (
  <div aria-hidden className={`flex h-5 items-center gap-[1.5px] ${busy ? "animate-pulse" : ""}`}>
    {BARS.map((bar, i) => (
      <div
        key={bar}
        className="w-[2px] rounded-full bg-ink2"
        style={{ height: 2 + 16 * (levels[i - (LEVELS - levels.length)] ?? 0) }}
      />
    ))}
  </div>
)

export const Listen = ({
  listening,
  onCancel,
  onDone,
}: {
  listening: Listening
  onCancel: () => void
  onDone: () => void
}) => (
  <div className="flex flex-none items-center gap-2">
    <Meter levels={listening.levels} busy={listening.status !== "listening"} />
    <Flat label="Cancel" onClick={onCancel}>
      <Glyph>
        <path d="M4 4 L12 12 M12 4 L4 12" />
      </Glyph>
    </Flat>
    <Button
      look="key"
      aria-label="Done"
      aria-keyshortcuts="Enter"
      disabled={listening.status === "stopping"}
      onClick={onDone}
    >
      <Glyph>
        <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
      </Glyph>
    </Button>
  </div>
)

/** Why the last dictation stopped short. */
export const stoppedText = (stopped: Stopped, message?: string) => {
  switch (stopped) {
    case "denied": {
      return "Microphone not allowed"
    }
    case "no-input": {
      return "No microphone"
    }
    case "missing": {
      return "Dictation not installed"
    }
    case "failed": {
      return message === undefined ? "Dictation failed" : `Dictation failed: ${message}`
    }
    default: {
      return stopped satisfies never
    }
  }
}

/** Opens the microphone's settings, where a denied one is let in. */
export const fixStopped = (stopped: Stopped) =>
  stopped === "denied" ? openMicrophoneSettings : undefined
