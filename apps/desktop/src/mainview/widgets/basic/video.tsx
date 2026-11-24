// A2UI's Video: the picture edge to edge at its own ratio, black until a frame or its poster is in (a
// picture's plate is black), and its transport under it, as old Switchboard drew one (plain's
// a2ui-gpui). Nothing without a url A2UI's own would play (http, https or data).
import { createComponentImplementation } from "@a2ui/react"
import { sanitizeMediaUrl, VideoApi } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"
import { Transport } from "./transport.tsx"
import { useMedia } from "./use-media.ts"

export const Video = createComponentImplementation(VideoApi, ({ props }) => {
  const media = useMedia<HTMLVideoElement>()
  const url = sanitizeMediaUrl(props.url)
  const poster = sanitizeMediaUrl(props.posterUrl)
  return url === undefined ? null : (
    <div style={share(props.weight)}>
      <video
        ref={media.ref}
        src={url}
        poster={poster}
        preload="metadata"
        playsInline
        className="block w-full bg-black"
        {...media.events}
      />
      <Transport {...media.line} />
    </div>
  )
})
