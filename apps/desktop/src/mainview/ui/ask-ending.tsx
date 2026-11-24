// How a closed ask ended, as its mark: sent, approved or done a tick (sent a paper plane), declined a
// cross, waved off a dash, what Approve ran failing a stop.
import type { ActionItem } from "../brain/items.ts"
import { endingOf } from "./ask-outcome.ts"
import { Declined, Dismissed, Sent, Stop, Tick } from "./marks.tsx"

export const AskEnding = ({ item }: { item: ActionItem }) => {
  const ending = endingOf(item)
  switch (ending) {
    case "sent": {
      return <Sent />
    }
    case "approved":
    case "done": {
      return <Tick />
    }
    case "failed": {
      return <Stop />
    }
    case "declined": {
      return <Declined />
    }
    case "dismissed": {
      return <Dismissed />
    }
    default: {
      return ending satisfies never
    }
  }
}
