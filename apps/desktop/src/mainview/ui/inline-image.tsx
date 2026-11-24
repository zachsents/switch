import { useState } from "react"

import { imageSrc } from "../brain/files.ts"
import { Button } from "./kit/button.tsx"
import { fileAction } from "./use-menu.ts"

/** A picture in an agent's words, at a set height so the column keeps still while it loads; one
 * that can't be fetched (a path on another machine, a dead link) is its name, as a file is. */
export const InlineImage = ({ src, alt }: { src: string; alt: string }) => {
  const [failed, setFailed] = useState(false)
  const url = imageSrc(src)
  const address = new URL(url, location.href)
  const name =
    address.searchParams.get("name") ??
    (address.protocol === "data:" ? "Image" : address.pathname.split("/").at(-1)) ??
    "Image"
  if (failed) {
    return <span className="block text-ink2">{alt || name}</span>
  }
  const open = (action: "look" | "menu") => {
    void fileAction({ url, name, do: action })
  }
  return (
    <Button
      look="bare"
      aria-label={alt || "Image"}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        open("look")
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        open("menu")
      }}
      className="my-2 block max-w-full rounded-key first:mt-0 last:mb-0"
    >
      <img
        src={url}
        alt={alt}
        decoding="sync"
        onError={() => {
          setFailed(true)
        }}
        className="block h-60 w-auto max-w-full object-contain"
      />
    </Button>
  )
}
