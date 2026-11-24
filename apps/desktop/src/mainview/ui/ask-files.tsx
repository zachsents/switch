// The files on an item, drawn as the chat draws them, small. A blob is fetched from the core's blob
// store; a file without one is its link.
import { hashOf } from "@switch/brain/commands"

import { coreUrl } from "../brain/auth.ts"
import type { Attachment } from "../brain/items.ts"
import { AttachedFile, Files } from "./attached.tsx"
import type { Size } from "./attached.tsx"

/** Where a file is: its blob in the core's store, or its link. */
const fileUrl = (a: Attachment) => {
  const hash = a.blob === undefined ? null : hashOf(a.blob)
  if (hash === null) {
    return a.url ?? ""
  }
  const url = new URL(coreUrl(`/blobs/${hash}`))
  url.searchParams.set("type", a.type)
  url.searchParams.set("name", a.name)
  return url.toString()
}

const shownOf = (file: Attachment) => ({
  url: fileUrl(file),
  name: file.name,
  type: file.type,
  size: file.size,
})

export const AskFile = ({ file }: { file: Attachment }) => (
  <AttachedFile f={shownOf(file)} size="ask" />
)

/** The files that go with no option: in an ask's own window, its videos bigger. */
export const AskFiles = ({ files, size }: { files: readonly Attachment[]; size: Size }) =>
  files.length === 0 ? null : (
    <div className="flex flex-wrap items-center gap-2">
      <Files files={files.map(shownOf)} size={size} right={false} />
    </div>
  )
