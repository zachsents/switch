// A chat's blips: an app's outcome, or a memory a turn learned here (Undo forgets it). The Blip is
// blip.tsx.
import { useMutation } from "@tanstack/react-query"

import type { ChatLine } from "../brain/derive.ts"
import { forgetMutation } from "../brain/mutations.ts"
import type { Quiet } from "../brain/store.ts"
import { Blip, gist } from "./blip.tsx"
import { Button } from "./kit/button.tsx"
import { timeOf } from "./time.ts"

const Learned = ({
  id,
  restore,
  text,
  time,
}: {
  id: string
  restore: readonly string[]
  text: string
  time?: number
}) => {
  const forget = useMutation(forgetMutation)
  return (
    <Blip
      mark="learned"
      time={time}
      whole={text}
      actions={
        <>
          {forget.error && <span className="text-red">{forget.error.message}</span>}
          <Button
            look="flat"
            disabled={forget.isPending}
            onClick={() => {
              forget.mutate({ id, restore })
            }}
          >
            Undo
          </Button>
        </>
      }
    >
      {gist(text)}
    </Blip>
  )
}

export const QuietLine = ({ quiet, line }: { quiet: Quiet; line: ChatLine }) => {
  const at = line.time === undefined ? {} : { time: line.time }
  if (quiet.kind === "learned") {
    return <Learned id={quiet.id} restore={quiet.restore} text={line.text} {...at} />
  }
  // A condition's blip spans from its first event to its latest.
  const until =
    line.time !== undefined && timeOf(quiet.until) !== timeOf(line.time)
      ? `Until ${timeOf(quiet.until)}`
      : ""
  return (
    <Blip
      mark="event"
      time={line.time}
      whole={
        <>
          {line.text}
          {until !== "" && <span className="mt-1 block text-ink2 tabular-nums">{until}</span>}
        </>
      }
    >
      {gist(line.text)}
    </Blip>
  )
}
