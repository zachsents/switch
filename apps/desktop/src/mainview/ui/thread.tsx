// A piece of work opened: its transcript, live, and a box to steer it while it runs.
import { useMutation } from "@tanstack/react-query"

import { liveStep } from "../brain/adapter.ts"
import { wordsForm } from "../brain/forms.ts"
import { retryMutation, steerMutation, stopMutation } from "../brain/mutations.ts"
import { appNames } from "../brain/derive.ts"
import type { ThreadRow } from "../brain/store.ts"
import { useBrain } from "../brain/use-brain.ts"
import { useTranscript } from "../brain/use-transcript.ts"
import { Box } from "./box.tsx"
import { Said } from "./chat.tsx"
import { Runner, Stop } from "./marks.tsx"

import { Scroll } from "./scroll.tsx"
import { followScroll } from "./follow-end.ts"
import { blocks, Steps } from "./steps.tsx"
import type { Block } from "./steps.tsx"
import { Button } from "./kit/button.tsx"

/** Whose words a block is, if it's words. */
const whoOf = (b: Block | undefined, rejected: ReadonlySet<string>): "agent" | "user" | null => {
  if (b?.kind !== "item") {
    return null
  }
  const { item } = b
  if (item.kind === "text" && !rejected.has(item.text.trim().slice(0, 2000))) {
    return "agent"
  }
  return (item.kind === "user" || item.kind === "steer") && item.text !== "" ? "user" : null
}

const keyOf = (b: Block) => (b.kind === "item" ? b.item.seq : `steps:${b.items[0]?.seq ?? 0}`)

export const ThreadPage = ({ t, ink }: { t: ThreadRow; ink: string }) => {
  const { items, rejected, older } = useTranscript(t)
  const steer = useMutation(steerMutation)
  const stop = useMutation(stopMutation)
  const retry = useMutation(retryMutation)
  const stopped = t.status === "failed" || t.status === "limited" || t.status === "interrupted"
  const running = t.status === "running"
  const step = useBrain((s) => (running ? liveStep(t, appNames(s)) : "")) ?? ""
  const list = blocks(items)
  // A side's words in a row run together; the last of a run has the tail.
  const runs = new Map(
    list.map((b, i) => {
      const who = whoOf(b, rejected)
      const before = whoOf(list[i - 1], rejected)
      const after = whoOf(list[i + 1], rejected)
      return [keyOf(b), { who, run: who !== null && who === before, tail: who !== after }]
    }),
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Scroll
        conversation={`thread:${t.id}`}
        label={t.title}
        items={list}
        keyOf={keyOf}
        render={(b) => {
          const at = runs.get(keyOf(b))
          return (
            <div className={`flex min-w-0 flex-col ${at?.run === true ? "pt-0.5" : "pt-2"}`}>
              {b.kind === "steps" && <Steps items={b.items} />}
              {b.kind === "item" && at?.who && (
                <Said who={at.who} ink={ink} tail={at.tail}>
                  {b.item.text}
                </Said>
              )}
            </div>
          )
        }}
        onTop={older}
        tail={
          <>
            {t.streaming !== "" && (
              <Said who="agent" ink={ink} streaming>
                {t.streaming}
              </Said>
            )}
            {stopped && (
              <div className="flex items-center gap-2 self-start px-1 text-small text-ink">
                <Stop size={12} />
                <span className="trim">{t.result}</span>
                <Button
                  look="key"
                  disabled={retry.isPending}
                  onClick={() => {
                    retry.mutate({ thread: t.id })
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            {running && (
              <div className="flex items-center gap-2 self-start px-1 text-small text-ink2">
                <Runner />
                <span className="trim">{step}</span>
                <Button
                  look="danger"
                  disabled={stop.isPending}
                  aria-keyshortcuts="Meta+."
                  onClick={() => {
                    stop.mutate({ thread: t.id })
                  }}
                >
                  Stop
                </Button>
              </div>
            )}
          </>
        }
      />
      {running && (
        <Box
          placeholder="Steer…"
          place={`thread:${t.id}`}
          schema={wordsForm}
          error={steer.error?.message}
          onSend={(words) => {
            followScroll(`thread:${t.id}`)
            steer.mutate({ thread: t.id, ...words })
          }}
        />
      )}
    </div>
  )
}
