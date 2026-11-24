// An item's answer, by its kind: an approval's drafts to edit (saved as typed), then Approve and Decline; a question's options and a typed answer; a task's Done. An
// assist key (an app's tool, called from here) comes first.
import type { ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import { Textarea } from "@ui-sdk/react/textarea"

import type { Done } from "../brain/item-mutations.ts"
import type { ActionItem } from "../brain/items.ts"
import { AskFile } from "./ask-files.tsx"
import { actionMutation } from "./connections.ts"
import { ConnectionActions } from "./connection-actions.tsx"
import { ActionError } from "./action-error.tsx"
import { Button, buttonLook } from "./kit/button.tsx"
import { useDraftEdits } from "./use-draft-edits.ts"

/** A field in a card: full width, on a hairline, its whole box the click. */
export const FIELD =
  "min-h-8 w-full resize-none rounded-key border border-line-2 bg-bg px-2.5 py-1.5 text-read text-ink outline-none select-text focus:border-ink3"

export const AskAnswer = ({
  item,
  hold,
  aside,
}: {
  item: ActionItem
  hold: (d: Done, label: string) => void
  /** The card's own keys (Reply, Dismiss), at the end of the answer's row. */
  aside?: ReactNode
}) => {
  const canAnswer = item.completion !== "owner"

  const drafts = item.drafts ?? []
  const assist = useMutation(actionMutation)
  const form = useDraftEdits(item)
  const approve = () => {
    const left = form.state.values.drafts
    const edited = drafts.filter((d, i) => left[i] !== d.text).map((d) => d.name)
    hold(
      {
        kind: "answer",
        answer: {
          id: item.id,
          approved: true,
          ...(drafts.length > 0 && {
            drafts: Object.fromEntries(drafts.map((d, i) => [d.name, left[i] ?? d.text])),
          }),
          ...(edited.length > 0 && { edited }),
        },
      },
      "Approved",
    )
  }
  const answerText = () => {
    const text = form.state.values.text.trim()
    if (text !== "") {
      hold({ kind: "answer", answer: { id: item.id, text } }, "Answered")
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {drafts.map((d, i) => (
        <form.Field key={d.name} name={`drafts[${i}]`}>
          {(f) => (
            <label className="flex flex-col overflow-hidden rounded-[8px] border border-line-2 bg-bg focus-within:border-ink3">
              <span className="flex h-8 items-center gap-2 px-3.5 text-small text-ink2 line-2-b">
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
                {f.state.value !== d.text && (
                  <span className="flex-none font-medium text-ink">Edited</span>
                )}
              </span>
              <Textarea
                autoResize
                rows={2}
                name={f.name}
                value={f.state.value}
                onValueChange={f.handleChange}
                onBlur={f.handleBlur}
                className="max-h-[296px] min-h-14 w-full resize-none bg-transparent px-3.5 py-2 text-read text-ink outline-none select-text"
              />
            </label>
          )}
        </form.Field>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {item.action && (
          <Button
            look="key"
            disabled={assist.isPending}
            onClick={() => {
              if (item.action) {
                assist.mutate(item.action)
              }
            }}
          >
            {item.action.label}
          </Button>
        )}
        {assist.isError && <ActionError error={assist.error} />}
        <ConnectionActions action={item.action} pending={assist.isPending} />
        {(item.links ?? []).map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className={buttonLook("key")}
          >
            {`${link.label} ↗`}
          </a>
        ))}
        {canAnswer && item.kind === "approval" && (
          <>
            <Button
              look="go"
              onClick={() => {
                approve()
              }}
            >
              {item.send && drafts.length > 0 ? "Approve & send" : "Approve"}
            </Button>
            <Button
              look="key"
              onClick={() => {
                hold({ kind: "answer", answer: { id: item.id, approved: false } }, "Declined")
              }}
            >
              Decline
            </Button>
          </>
        )}
        {canAnswer &&
          item.kind === "question" &&
          (item.options ?? []).map((o, i) => (
            <span key={o} className="flex items-center gap-1.5">
              {(item.attachments ?? [])
                .filter((a) => a.option === i)
                .map((a) => (
                  <AskFile key={a.name} file={a} />
                ))}
              <Button
                look="key"
                onClick={() => {
                  hold({ kind: "answer", answer: { id: item.id, choice: o } }, o)
                }}
              >
                {o}
              </Button>
            </span>
          ))}
        {canAnswer && item.kind === "task" && item.action?.app !== "connections" && (
          <Button
            look="go"
            onClick={() => {
              hold({ kind: "close", close: { id: item.id, status: "done" } }, "Done")
            }}
          >
            Done
          </Button>
        )}
        {aside !== undefined && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </div>
      {canAnswer && item.kind === "question" && (
        <form.Field name="text">
          {(f) => (
            <Textarea
              autoResize
              rows={1}
              name={f.name}
              value={f.state.value}
              onValueChange={f.handleChange}
              onBlur={f.handleBlur}
              submitShortcut="enter"
              onSubmit={answerText}
              placeholder="Answer…"
              aria-label="Answer"
              className={`${FIELD} max-h-40`}
            />
          )}
        </form.Field>
      )}
    </div>
  )
}
