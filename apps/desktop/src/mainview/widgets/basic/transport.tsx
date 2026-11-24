// A video's or a sound's line, as old Switchboard drew it (plain's a2ui-gpui): Play or Pause on a
// key, where it's at on a track to press or drag, and its time and length as figures at the line's
// end ("0:12 / 3:04").
import { Button } from "../../ui/kit/button.tsx"
import { Data } from "../../ui/parts.tsx"
import { spanOf } from "../../ui/time.ts"
import { Glyph } from "./glyph.tsx"
import { ICONS } from "./icons.ts"
import { Track } from "./track.tsx"

export const Transport = ({
  at,
  length,
  playing,
  toggle,
  seek,
}: {
  at: number
  length: number
  playing: boolean
  toggle: () => void
  seek: (to: number) => void
}) => {
  const known = Number.isFinite(length) && length > 0
  return (
    <div className="flex h-line items-center gap-2.5 px-inset">
      <Button
        look="key"
        aria-label={playing ? "Pause" : "Play"}
        className="px-1.5"
        onClick={toggle}
      >
        <Glyph d={playing ? ICONS.pause : ICONS.play} />
      </Button>
      <Track
        label="Position"
        value={at}
        min={0}
        max={known ? length : 1}
        step={1}
        disabled={!known}
        onChange={seek}
      />
      <Data>
        {spanOf(at * 1000)} / {known ? spanOf(length * 1000) : "–:––"}
      </Data>
    </div>
  )
}
