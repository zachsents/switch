// An ask in its space's chat, where it was raised: open, its card as a widget in chat is, the whole
// column's width with rules above and below (chat-widget.tsx; its Reply attaches it to the space's
// box); closed, how it ended as a mark by its title, and under them what came of it (ask-outcome.ts).
// A click opens it as it was decided, in a window of its own.
import type { ActionItem } from "../brain/items.ts"
import { AskCard } from "./ask-card.tsx"
import { AskEnding } from "./ask-ending.tsx"
import { detailOf } from "./ask-outcome.ts"
import { focusBox } from "./box.tsx"
import { Button } from "./kit/button.tsx"
import { attachReply } from "./replying.ts"
import { openItemWindow } from "./use-menu.ts"

export const AskInChat = ({ item, open, now }: { item: ActionItem; open: boolean; now: number }) =>
  open ? (
    <div className="-mx-inset self-stretch line-section-t">
      <div className="px-inset line-section-b">
        <AskCard
          item={item}
          now={now}
          onReply={() => {
            attachReply(item.space, { kind: "ask", id: item.id, title: item.title })
            focusBox()
          }}
        />
      </div>
    </div>
  ) : (
    <AskClosed item={item} />
  )

const AskClosed = ({ item }: { item: ActionItem }) => {
  const detail = detailOf(item)
  return (
    <Button
      look="bare"
      onClick={() => {
        openItemWindow(item.id)
      }}
      className="-mx-1.5 flex max-w-full min-w-0 flex-col gap-1 self-start rounded-key px-1.5 py-1 text-left hover:lit"
    >
      <span className="flex min-w-0 items-center gap-2 text-ui font-medium text-ink2">
        <AskEnding item={item} />
        <span className="min-w-0 truncate">{item.title}</span>
      </span>
      {detail && (
        <span className="line-clamp-2 pl-[22px] text-ui text-ink2">
          {detail.who !== null && <span className="font-medium text-ink">{detail.who} </span>}
          {detail.words}
        </span>
      )}
    </Button>
  )
}
