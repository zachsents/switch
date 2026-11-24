// A file in the box before it's sent: its picture or kind, name and size, uploading as it shows.
import { kindOf, typeOf } from "@switch/brain/commands"
import { useQuery } from "@tanstack/react-query"

import { sizeOf, uploadQuery } from "../brain/files.ts"
import type { Chosen } from "../brain/files.ts"
import { Spin, Stop } from "./marks.tsx"
import { Button } from "./kit/button.tsx"

const KIND = { image: "IMG", video: "VID", audio: "AUD", model: "3D", file: "FILE" } as const

/** How its upload is going: running, failed, or done and its size. */
const Status = ({ chosen }: { chosen: Chosen }) => {
  const upload = useQuery(uploadQuery(chosen))
  if (upload.isError) {
    return (
      <span className="flex flex-none items-center text-red" title={upload.error.message}>
        <Stop size={12} />
      </span>
    )
  }
  if (upload.isPending) {
    return <Spin />
  }
  return (
    <span className="flex-none text-caption tabular-nums text-ink3">
      {sizeOf(chosen.file.size)}
    </span>
  )
}

export const Chip = ({ chosen, onRemove }: { chosen: Chosen; onRemove: () => void }) => {
  const { file } = chosen
  const kind = kindOf(typeOf(file.name, file.type), file.name)
  return (
    <div className="flex h-10 max-w-64 items-center gap-2 rounded-key border border-line-2 bg-bg pr-1 text-small">
      {chosen.preview === undefined ? (
        <span className="flex h-10 w-10 flex-none items-center justify-center border-r border-line-2 text-caption tabular-nums text-ink3">
          {KIND[kind]}
        </span>
      ) : (
        <img
          src={chosen.preview}
          alt=""
          className="h-10 w-10 flex-none rounded-l-chip object-cover"
        />
      )}
      <span className="min-w-0 flex-1 truncate text-ink">{file.name || "file"}</span>
      <Status chosen={chosen} />
      <Button
        look="bare"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-key text-ink3 outline-none hover:lit focus-visible:focused"
      >
        ×
      </Button>
    </div>
  )
}
