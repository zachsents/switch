// A video in a gallery (picture-row.tsx), played where it is: its first frame until it plays, a click
// on it plays or pauses it, and two keys over it, Play or Pause and Full screen, shown while it's
// paused or under the pointer. One plays at a time (use-media.ts). No WebKit
// controls, so no picture-in-picture key to send it away by. A right-click is the file's menu.
import { Glyph } from "../widgets/basic/glyph.tsx"
import { ICONS } from "../widgets/basic/icons.ts"
import { useMedia } from "../widgets/basic/use-media.ts"
import { Button } from "./kit/button.tsx"
import { fileAction } from "./use-menu.ts"

/** Phosphor's arrows-out-simple, bold, as plain's kit has it. */
const FULL =
  "M220,48V96a12,12,0,0,1-24,0V77l-39.51,39.52a12,12,0,0,1-17-17L179,60H160a12,12,0,0,1,0-24h48A12,12,0,0,1,220,48ZM99.51,139.51,60,179V160a12,12,0,0,0-24,0v48a12,12,0,0,0,12,12H96a12,12,0,0,0,0-24H77l39.52-39.51a12,12,0,0,0-17-17Z"

export const VideoTile = ({ url, name, frame }: { url: string; name: string; frame: string }) => {
  const { ref, events, line } = useMedia<HTMLVideoElement>()
  const { playing, toggle } = line
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault()
        void fileAction({ url, name, do: "menu" })
      }}
      className={`group relative flex-none overflow-hidden bg-black ${frame}`}
    >
      {/* `#t` has WebKit draw the first frame rather than black. */}
      <video
        ref={ref}
        src={`${url}#t=0.001`}
        preload="metadata"
        playsInline
        aria-label={name}
        onClick={toggle}
        className="block h-full w-auto max-w-[420px] object-contain"
        {...events}
      >
        <track kind="captions" />
      </video>
      <div
        className={`absolute inset-x-1.5 bottom-1.5 flex items-center justify-between ${playing ? "invisible group-hover:visible" : ""}`}
      >
        <Button
          look="key"
          aria-label={playing ? "Pause" : "Play"}
          className="px-1.5"
          onClick={toggle}
        >
          <Glyph d={playing ? ICONS.pause : ICONS.play} />
        </Button>
        <Button
          look="key"
          aria-label="Full screen"
          className="px-1.5"
          onClick={() => {
            void ref.current?.requestFullscreen()
          }}
        >
          <Glyph d={FULL} />
        </Button>
      </div>
    </div>
  )
}
