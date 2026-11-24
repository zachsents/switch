// How a closed ask ended, from what the item records: its status, its answer (Approve or Decline,
// the option picked, the words typed, each draft as approved) and whether what Approve ran went
// through. Mirrored on the iPhone in AskOutcome.swift.
import type { ActionItem } from "../brain/items.ts"
import { shownText } from "../brain/items.ts"

export type Ending = "sent" | "approved" | "failed" | "declined" | "dismissed" | "done"

export const endingOf = (item: ActionItem): Ending => {
  const a = item.answer
  if (item.status === "dismissed") {
    return "dismissed"
  }
  if (a?.approved === false) {
    return "declined"
  }
  if (item.ran?.ok === false) {
    return "failed"
  }
  if (a?.approved) {
    return item.ran?.ok === true && (item.drafts ?? []).length > 0 ? "sent" : "approved"
  }
  return "done"
}

/** Who a draft goes to, from its label ("To Ann Lee <ann@x.com> · Re: …", "Email to ann@x.com"): the
 * name it gives, else the address; null when it names no one. */
export const recipientOf = (label: string, to: unknown) => {
  const head = label.split(" · ")[0] ?? ""
  const named = /^(?:\p{L}+\s+)?to\s+(?<who>.+)$/iu.exec(head)?.groups?.who?.trim()
  if (named === undefined || named === "") {
    return typeof to === "string" && to !== "" ? to : null
  }
  const name = named.split(/[<(]/u)[0]?.trim()
  if (name !== undefined && name !== "") {
    return name
  }
  return /[<(](?<inner>[^>)]+)[>)]/u.exec(named)?.groups?.inner ?? named
}

/** What came of it, as data: an approved send's recipient and words as sent (his edit included),
 * the option picked or the words typed; null when nothing more than how it ended. */
export const detailOf = (item: ActionItem) => {
  const a = item.answer
  if (a?.choice !== undefined) {
    return { who: null, words: a.choice }
  }
  if (a?.text !== undefined) {
    return { who: null, words: a.text }
  }
  const draft = item.drafts?.[0]
  if (a?.approved !== true || !draft) {
    return null
  }
  return {
    who: recipientOf(draft.label, item.send?.args.to),
    words: a.drafts?.[draft.name] ?? shownText(item, draft),
  }
}
