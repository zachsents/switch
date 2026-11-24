// Switch's Gallery: several pictures as one row that scrolls sideways, edge to edge in the cell, each
// at one height and its own width; a click is Quick Look (ui/picture-row.tsx). A picture without a url
// A2UI's Image would show (http, https or data) is left out.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema, sanitizeMediaUrl } from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { PictureRow } from "../ui/picture-row.tsx"
import type { Picture } from "../ui/picture-row.tsx"

const Image = z.object({ url: z.string(), description: z.string().optional() })

/** The file a picture opens as: its description, else its link's last part. */
const nameOf = (url: string, description: string | undefined) => {
  if (description !== undefined && description !== "") {
    return description
  }
  if (url.startsWith("data:")) {
    return `picture.${url.slice(url.indexOf("/") + 1, url.search(/[;,]/u))}`
  }
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "picture"
}

const picturesOf = (images: unknown): Picture[] =>
  (Array.isArray(images) ? images : []).flatMap((i) => {
    const image = Image.safeParse(i)
    const safe = image.success ? sanitizeMediaUrl(image.data.url) : undefined
    if (!image.success || safe === undefined) {
      return []
    }
    const url = new URL(safe, location.href).href
    return [{ url, name: nameOf(url, image.data.description), video: false }]
  })

export const Gallery = createComponentImplementation(
  {
    name: "Gallery",
    schema: z.object({
      /** `[{ url, description? }]`. */
      images: DynamicValueSchema,
    }),
  },
  ({ props }) => {
    const pictures = picturesOf(props.images)
    return pictures.length === 0 ? null : <PictureRow pictures={pictures} look="cell" />
  },
)
