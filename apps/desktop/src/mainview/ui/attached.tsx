// Files wherever they show (a chat's messages, an ask): pictures and videos as a row that scrolls
// sideways (picture-row.tsx), a lone picture in place, sound to play, 3D files to turn (model.tsx),
// and any other file as its name and size. A picture's click is Quick Look; a video plays in place;
// a file's name, clicked, saves it to Downloads and opens it (a 3D file in Preview), turning while
// it's fetched. Right-click gives Open, Quick Look, Show in Finder and Download. Each is a set height
// before it loads, so a column keeps to its latest as they come in.
import { kindOf } from "@switch/brain/commands"
import type { Attachment } from "@switch/brain/commands"
import { lazy, Suspense, useState } from "react"
import type { MouseEvent, ReactNode } from "react"

import { blobUrl, sizeOf } from "../brain/files.ts"
import { fileAction } from "./use-menu.ts"
import { PictureRow } from "./picture-row.tsx"
import { Button } from "./kit/button.tsx"
import { Spin, Stop } from "./marks.tsx"

const Model = lazy(async () => await import("./model.tsx"))

/** A file as it's drawn: where it's fetched, its name and type, and its size when known. */
export interface Shown {
  readonly url: string
  readonly name: string
  readonly type: string
  readonly size?: number | undefined
}

/** A message's file, fetched from the core's blobs. */
export const shownOf = (a: Attachment): Shown => ({
  url: blobUrl(a),
  name: a.name,
  type: a.type,
  size: a.size,
})

const ask = async (f: Shown, action: "open" | "look" | "menu") =>
  await fileAction({ url: f.url, name: f.name, do: action })

const menu = (f: Shown) => (e: MouseEvent) => {
  e.preventDefault()
  void ask(f, "menu")
}

/** Chat draws them big; an ask, small, but for its videos (picture-row.tsx). */
const PICTURE = {
  chat: "h-60 w-auto max-w-full",
  ask: "h-24 w-auto max-w-60",
  window: "h-24 w-auto max-w-60",
}
const MODEL = { chat: "h-60 w-80 max-w-full", ask: "h-24 w-32", window: "h-24 w-32" }
const WIDE = { chat: "max-w-[min(80%,420px)]", ask: "max-w-80", window: "max-w-80" }

export type Size = keyof typeof PICTURE

/** The pictures and videos a row shows (picture-row.tsx): any video, or more than one picture. */
const rowOf = <F extends { type: string; name: string }>(files: readonly F[]) => {
  const media = files.filter((f) => ["image", "video"].includes(kindOf(f.type, f.name)))
  return media.length > 1 || media.some((f) => kindOf(f.type, f.name) === "video") ? media : []
}

const Frame = ({ f, size, children }: { f: Shown; size: Size; children: ReactNode }) => (
  <div
    onContextMenu={menu(f)}
    className={`${WIDE[size]} overflow-hidden rounded-bubble border border-line-1`}
  >
    {children}
  </div>
)

/** A file as its name and size; clicked, it's opened, turning while it's fetched. */
const FileLine = ({ f, boxed, size }: { f: Shown; boxed: boolean; size: Size }) => {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle")
  const open = async () => {
    if (state === "opening") {
      return
    }
    setState("opening")
    setState((await ask(f, "open")) ? "idle" : "failed")
  }
  return (
    <Button
      look="bare"
      onClick={() => {
        void open()
      }}
      onContextMenu={menu(f)}
      className={`flex h-10 max-w-full min-w-0 items-center gap-3 px-3 text-small outline-none hover:lit focus-visible:focused ${boxed ? `${WIDE[size]} rounded-bubble border border-line-1` : "w-full line-1-t"}`}
    >
      <span className="min-w-0 flex-1 truncate text-left text-ink">{f.name}</span>
      {state === "opening" && <Spin />}
      {state === "failed" && <Stop size={12} />}
      {f.size !== undefined && (
        <span className="flex-none text-caption tabular-nums text-ink3">{sizeOf(f.size)}</span>
      )}
    </Button>
  )
}

/** One file, drawn as what it is. */
export const AttachedFile = ({ f, size = "chat" }: { f: Shown; size?: Size }) => {
  const kind = kindOf(f.type, f.name)
  if (kind === "image") {
    return (
      <Button
        look="bare"
        aria-label={f.name}
        onClick={() => {
          void ask(f, "look")
        }}
        onContextMenu={menu(f)}
        className={`${WIDE[size]} flex-none overflow-hidden rounded-bubble outline-none focus-visible:ring-2 focus-visible:ring-press`}
      >
        <img
          src={f.url}
          alt={f.name}
          decoding="sync"
          className={`block object-contain ${PICTURE[size]}`}
        />
      </Button>
    )
  }
  if (kind === "video") {
    return <PictureRow pictures={[{ url: f.url, name: f.name, video: true }]} look={size} />
  }
  if (kind === "audio") {
    return (
      <Frame f={f} size={size}>
        <audio src={f.url} controls preload="metadata" className="block w-80 max-w-full">
          <track kind="captions" />
        </audio>
      </Frame>
    )
  }
  if (kind === "model") {
    return (
      <Frame f={f} size={size}>
        <Suspense fallback={<span className={`block ${MODEL[size]}`} />}>
          <Model url={f.url} name={f.name} className={MODEL[size]} />
        </Suspense>
        <FileLine f={f} boxed={false} size={size} />
      </Frame>
    )
  }
  return <FileLine f={f} boxed size={size} />
}

/** A message's or an ask's files: its pictures and videos as a gallery, then the rest as they are. */
export const Files = ({
  files,
  size,
  right,
}: {
  files: readonly Shown[]
  size: Size
  right: boolean
}) => {
  const media = rowOf(files)
  const rest = files.filter((f) => !media.includes(f))
  return (
    <>
      {media.length > 0 && (
        <PictureRow
          pictures={media.map((f) => ({
            url: f.url,
            name: f.name,
            video: kindOf(f.type, f.name) === "video",
          }))}
          look={size}
          right={right}
        />
      )}
      {rest.map((f, i) => (
        <AttachedFile key={`${String(i)} ${f.url}`} f={f} size={size} />
      ))}
    </>
  )
}

/** `under` a bubble, a gallery keeps the space that sets two messages apart (chat.tsx's ABOVE). */
export const Attached = ({
  files,
  right,
  under,
}: {
  files: readonly Attachment[]
  right: boolean
  under: boolean
}) => {
  const gallery = rowOf(files).length > 0
  return (
    <div
      className={`flex max-w-full flex-col gap-1.5 ${right ? "items-end self-end" : "items-start self-start"} ${under && gallery ? "pt-3" : ""}`}
    >
      <Files files={files.map(shownOf)} size="chat" right={right} />
    </div>
  )
}

/** A message's files while it's being sent: their names. */
export const Sending = ({ names }: { names: readonly string[] }) => (
  <div className="flex flex-col items-end gap-1.5 self-end opacity-60">
    {names.map((n) => (
      <div
        key={n}
        className="flex h-10 items-center rounded-bubble border border-line-1 px-3 text-small text-ink"
      >
        {n}
      </div>
    ))}
  </div>
)
