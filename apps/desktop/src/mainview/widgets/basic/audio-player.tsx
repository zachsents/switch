// A2UI's AudioPlayer, as old Switchboard drew one (plain's a2ui-gpui): what it is on a line of its
// own when it says, then its transport. Nothing without a url A2UI's own would play.
import { createComponentImplementation } from "@a2ui/react"
import { AudioPlayerApi, sanitizeMediaUrl } from "@a2ui/web_core/v1_0"

import { share } from "./flex.ts"
import { Transport } from "./transport.tsx"
import { useMedia } from "./use-media.ts"
import { wordsOf } from "./words.ts"

export const AudioPlayer = createComponentImplementation(AudioPlayerApi, ({ props }) => {
  const media = useMedia<HTMLAudioElement>()
  const url = sanitizeMediaUrl(props.url)
  const about = wordsOf(props.description)
  return url === undefined ? null : (
    <div style={share(props.weight)}>
      {about && <p className="m-0 px-inset py-1 text-ui text-ink">{about}</p>}
      <audio ref={media.ref} src={url} preload="metadata" {...media.events} />
      <Transport {...media.line} />
    </div>
  )
})
