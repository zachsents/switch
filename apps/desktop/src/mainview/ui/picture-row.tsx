// Pictures and videos as one row that scrolls sideways, each at one height and its own width; a
// picture's click is Quick Look on the row's pictures at that one, a video plays where it is
// (video-tile.tsx), a right-click is the file's menu. A row with a video is taller, so a 9:16 clip
// is big enough to see, tallest in an ask's own window. In chat and an ask each is rounded with a
// hairline round it; in a widget's cell the row runs edge to edge, a hairline between pictures.
// When the row holds more than it shows, its count shows under it.
import { ScrollArea, ScrollAreaContent, ScrollAreaViewport } from "@ui-sdk/react/scroll-area"

import { Scrollbar } from "./scrollbar.tsx"
import { fileAction, picturesAction } from "./use-menu.ts"
import { useOverflow } from "./use-overflow.ts"
import { Button } from "./kit/button.tsx"
import { VideoTile } from "./video-tile.tsx"

export interface Picture {
  readonly url: string
  readonly name: string
  readonly video: boolean
}

const BOXED = "rounded-bubble border border-line-1"

/** `high`: a picture's height; `tall`: every one's in a row with a video. */
const LOOK = {
  chat: { row: "gap-1.5", frame: BOXED, high: "h-40", tall: "h-60", wide: "max-w-[420px]" },
  ask: { row: "gap-1.5", frame: BOXED, high: "h-24", tall: "h-60", wide: "max-w-60" },
  window: { row: "gap-1.5", frame: BOXED, high: "h-24", tall: "h-96", wide: "max-w-60" },
  cell: {
    row: "divide-x divide-line-1",
    frame: "",
    high: "h-40",
    tall: "h-40",
    wide: "max-w-[420px]",
  },
}

const counted = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`

/** "3 pictures · 2 videos", each only when there are any. */
const countOf = (items: readonly Picture[]) => {
  const videos = items.filter((p) => p.video).length
  return [
    items.length > videos ? counted(items.length - videos, "picture") : "",
    videos > 0 ? counted(videos, "video") : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export type PictureRowLook = keyof typeof LOOK

export const PictureRow = ({
  pictures,
  look,
  right = false,
}: {
  pictures: readonly Picture[]
  look: PictureRowLook
  right?: boolean
}) => {
  const { over, content } = useOverflow()
  const { row, high, tall, wide } = LOOK[look]
  const frame = `${LOOK[look].frame} ${pictures.some((p) => p.video) ? tall : high}`
  const stills = pictures.filter((p) => !p.video).map(({ url, name }) => ({ url, name }))
  return (
    <div
      className={`flex max-w-full min-w-0 flex-col gap-1 ${right ? "items-end self-end" : "items-start self-start"} ${look === "cell" ? "w-full" : ""}`}
    >
      <ScrollArea className="relative max-w-full min-w-0">
        <ScrollAreaViewport className="max-w-full overflow-x-auto overflow-y-hidden">
          <ScrollAreaContent ref={content} className={`flex w-max ${row}`}>
            {pictures.map((p, i) =>
              p.video ? (
                <VideoTile key={`${String(i)} ${p.url}`} url={p.url} name={p.name} frame={frame} />
              ) : (
                <Button
                  key={`${String(i)} ${p.url}`}
                  look="bare"
                  aria-label={p.name}
                  onClick={() => {
                    picturesAction({
                      pictures: stills,
                      at: pictures.slice(0, i).filter((q) => !q.video).length,
                    })
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    void fileAction({ url: p.url, name: p.name, do: "menu" })
                  }}
                  className={`flex-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-press ${frame}`}
                >
                  <img
                    src={p.url}
                    alt={p.name}
                    decoding="sync"
                    className={`block h-full w-auto object-cover ${wide}`}
                  />
                </Button>
              ),
            )}
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <Scrollbar orientation="horizontal" over={over.x} />
      </ScrollArea>
      {over.x && (
        <span
          className={`text-caption text-ink3 tabular-nums ${look === "cell" ? "px-inset pb-1.5" : ""}`}
        >
          {countOf(pictures)}
        </span>
      )}
    </div>
  )
}
