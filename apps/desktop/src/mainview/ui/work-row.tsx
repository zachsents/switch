// A row of running work: the runner, its title and under it its stage as a task says it (the user,
// Nov 23: "nice if that showed on a second line underneath the name of the task"). The row opens it;
// under the pointer Stop shows at its end, over the row.
import { useMutation } from "@tanstack/react-query"

import type { Work } from "../brain/derive.ts"
import { stopMutation } from "../brain/mutations.ts"
import { useBrain } from "../brain/use-brain.ts"
import { Button } from "./kit/button.tsx"
import { Runner, Warn } from "./marks.tsx"
import { spanOf } from "./time.ts"
import { openThread } from "./nav.ts"

export const WorkRow = ({ w, now }: { w: Work; now: number }) => {
  const stop = useMutation(stopMutation)
  // Untitled (its pre-read gave no title): named by its space.
  const space = useBrain((s) => s.spaces.get(w.space)?.name ?? "")
  return (
    <li className="group/work relative min-w-0 line-2-t">
      <Button
        look="row"
        className="h-auto! min-h-work! gap-[9px]! px-[14px]! py-[7px]!"
        onClick={() => {
          openThread(w.thread.id)
        }}
      >
        <Runner />
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="trim truncate font-medium">{w.thread.title || space}</span>
          {w.thread.stage !== "" && (
            <span className="trim truncate text-small text-ink2">{w.thread.stage}</span>
          )}
        </span>
        <span className="trim flex-none text-caption tabular-nums text-ink3">
          {spanOf(now - w.thread.since)}
        </span>
      </Button>
      <span className="invisible absolute inset-y-0 right-0 flex items-center gap-1.5 pr-1 group-hover/work:visible focus-within:visible">
        {stop.isError && <Warn />}
        <Button
          look="danger"
          disabled={stop.isPending}
          onClick={() => {
            stop.mutate({ thread: w.thread.id })
          }}
        >
          Stop
        </Button>
      </span>
    </li>
  )
}
