// The look, every part in every state, on one page (`#gallery`, dev builds only): tokens, type,
// Button, Segmented, Select and Pick, rows and headings, the band, an ask card, bubbles, the box,
// what floats. Hover and press are shown held, with the classes they take.
import { SpaceId } from "@switch/brain/commands"
import { useState } from "react"
import type { ReactNode } from "react"

import type { ActionItem } from "../brain/items.ts"
import { messageForm } from "../brain/forms.ts"
import { useBrain } from "../brain/use-brain.ts"
import { ChartsGallery } from "../widgets/charts/gallery.tsx"
import { WidgetParts } from "../widgets/basic/gallery.tsx"
import { AskCard } from "./ask-card.tsx"
import { Band } from "./band.tsx"
import { Box } from "./box.tsx"
import { Said } from "./chat.tsx"
import { Button } from "./kit/button.tsx"
import type { Look } from "./kit/button.tsx"
import { FLOAT } from "./kit/float.ts"
import { Pick } from "./kit/pick.tsx"
import { Segmented } from "./kit/segmented.tsx"
import { Select } from "./kit/select.tsx"
import { station } from "./look.ts"
import { Hand, Ring, Runner, Spin, Stop, Warn } from "./marks.tsx"
import { Data, Quiet, Row, Section } from "./parts.tsx"
import { RailSection } from "./rail-section.tsx"
import { useNow } from "./use-now.ts"

const COLORS = [
  "bg",
  "line-1",
  "line-2",
  "ink",
  "ink2",
  "ink3",
  "home",
  "yellow",
  "orange",
  "red",
  "go",
] as const

const Part = ({ name, children }: { name: string; children: ReactNode }) => (
  <section className="flex flex-col line-1-b">
    <h2 className="m-0 flex h-line items-center px-inset text-small font-semibold text-ink2">
      <span className="trim">{name}</span>
    </h2>
    <div className="flex flex-wrap items-start gap-4 px-inset pb-4">{children}</div>
  </section>
)

/** Hover and press, held. */
const HELD: Record<Look, { hover: string; press: string }> = {
  key: { hover: "", press: "translate-y-px" },
  go: { hover: "", press: "translate-y-px" },
  danger: { hover: "", press: "translate-y-px" },
  flat: { hover: "lit!", press: "held!" },
  plate: { hover: "lit!", press: "held!" },
  row: { hover: "lit!", press: "held!" },
  bare: { hover: "", press: "" },
}

/** When the gallery loaded: its asks' ages count from here. */
const SINCE = Date.now()

const ITEM: ActionItem = {
  id: "gallery-ask",
  space: SpaceId.make("home"),
  title: "Finish",
  body: "Satin hides fingerprints; gloss shows the glaze's color best.\n\n- **Satin:** matte, forgiving\n- **Gloss:** brighter, shows dust",
  kind: "question",
  options: ["Satin", "Gloss"],
  at: SINCE - 3 * 60_000,
  status: "open",
  closedAt: null,
}

const TASK: ActionItem = {
  id: "gallery-task",
  space: SpaceId.make("home"),
  title: "Plate",
  body: "Snip the support pad under the gate, then break the tree supports.",
  kind: "task",
  at: SINCE - 6 * 3_600_000,
  status: "open",
  closedAt: null,
}

const LONG =
  "A name long enough that it has to stop somewhere before the end of its row, as names will"

export const Gallery = () => {
  const ink = useBrain((s) => {
    const first = [...s.spaces.values()].find((x) => x.parent === "home")
    return first ? station(s, first.id).ink : "var(--color-home)"
  })
  const now = useNow()
  // What the gallery's controls were last given; nothing acts on it.
  const [, note] = useState<unknown>(null)
  const ignore = (x?: unknown) => {
    note(x)
  }
  return (
    <div className="flex h-full flex-col">
      <Band space={SpaceId.make("home")} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Part name="Colors">
          {COLORS.map((c) => (
            <span key={c} className="flex w-24 flex-col gap-1.5 text-small text-ink2">
              <span
                className="h-10 border border-line-1"
                style={{ background: `var(--color-${c})` }}
              />
              <span className="trim">{c}</span>
            </span>
          ))}
        </Part>
        <Part name="Type">
          <span className="flex flex-col gap-3">
            <span className="sign text-title">Title 22</span>
            <span className="sign text-name">Name 15</span>
            <span className="text-read">Read 14/20: what&apos;s read at length</span>
            <span className="text-ui">UI 13: rows, controls, labels</span>
            <span className="text-small text-ink2">Small 12: supporting</span>
            <span className="text-caption tabular-nums text-ink">12:23 AM</span>
          </span>
        </Part>
        <Part name="Button">
          {(["key", "go", "danger", "flat"] as const).map((look) => (
            <span key={look} className="flex flex-col gap-2">
              <span className="text-small text-ink3">{look}</span>
              <span className="flex items-center gap-2">
                <Button look={look}>Rest</Button>
                <Button look={look} className={HELD[look].hover}>
                  Hover
                </Button>
                <Button look={look} className={HELD[look].press}>
                  Pressed
                </Button>
                <Button look={look} disabled>
                  Disabled
                </Button>
                <Button look={look} className="outline-1 -outline-offset-1 outline-ink3">
                  Focus
                </Button>
              </span>
            </span>
          ))}
          <span className="flex flex-col gap-2">
            <span className="text-small text-ink3">plate</span>
            <span className="flex items-center gap-2 p-1 line-1-b">
              <Button look="plate">Edit</Button>
              <Button look="plate" className={HELD.plate.hover}>
                Hover
              </Button>
              <Button look="plate" aria-pressed>
                Done
              </Button>
            </span>
          </span>
        </Part>
        <Part name="Segmented">
          <Segmented
            label="Show"
            options={[
              { value: "here", label: "This space's" },
              { value: "all", label: "All" },
            ]}
            value="all"
            onChange={ignore}
          />
          <Segmented
            label="Where"
            options={[
              { value: "left", label: "Left" },
              { value: "grid", label: "Grid" },
              { value: "right", label: "Right" },
            ]}
            value="grid"
            onChange={ignore}
          />
        </Part>
        <Part name="Select and Pick">
          <Select
            label="Account"
            value=""
            options={[
              { value: "", label: "Auto" },
              { value: "work", label: "work" },
            ]}
            onChange={ignore}
          />
          <Pick
            label="Model"
            value="claude-code:opus"
            options={[
              { value: "claude-code:opus", label: "opus", group: "Claude" },
              { value: "claude-code:sonnet", label: "sonnet", group: "Claude" },
              { value: "codex:gpt-6-luna", label: "gpt-6-luna", group: "Codex" },
            ]}
            onChange={ignore}
          />
          <Select
            label="Off"
            value=""
            options={[{ value: "", label: "Auto" }]}
            onChange={ignore}
            disabled
          />
        </Part>
        <Part name="Rows and headings">
          <div className="w-[420px] edge">
            <Section mark={<Runner />} label="Running" count={3}>
              <Row>
                <Runner />
                <span className="trim min-w-0 flex-1 truncate font-medium">
                  Move the order past Printing
                </span>
                <Data>1:14</Data>
              </Row>
              <li className="min-w-0 line-2-t">
                <Button look="row" className={HELD.row.hover}>
                  <Hand />
                  <span className="trim min-w-0 flex-1 truncate">Hover</span>
                </Button>
              </li>
              <li className="min-w-0 line-2-t">
                <Button look="row" className={HELD.row.press}>
                  <Stop />
                  <span className="trim min-w-0 flex-1 truncate">Pressed</span>
                </Button>
              </li>
              <Row>
                <Warn />
                <span className="trim min-w-0 flex-1 truncate">{LONG}</span>
                <Data>9:30 PM</Data>
              </Row>
            </Section>
          </div>
          <div className="w-[420px] edge">
            <RailSection mark={<Hand />} label="Needs you" count={0}>
              <Quiet />
            </RailSection>
          </div>
        </Part>
        <Part name="Marks and rings">
          <span className="flex items-center gap-3">
            <Hand />
            <Runner />
            <Spin />
            <Warn />
            <Stop />
            <Ring code="K" ink={ink} />
            <Ring code="K03" ink={ink} />
            <Ring code="" ink="var(--color-ink3)" home />
          </span>
        </Part>
        <Part name="Ask card">
          <div className="w-[560px] px-4 edge">
            <AskCard item={ITEM} now={now} />
          </div>
          <div className="w-[560px] px-4 edge">
            <AskCard item={TASK} now={now} />
          </div>
        </Part>
        <Part name="Bubbles">
          <div className="flex w-[420px] flex-col gap-2">
            <Said who="user" ink={ink}>
              Pause the order
            </Said>
            <Said who="agent" ink="">
              Paused
            </Said>
            <Said who="user" ink="var(--color-home)">
              Home
            </Said>
          </div>
        </Part>
        <Part name="Box">
          <div className="flex w-[420px] flex-col edge">
            <Box
              placeholder="Talk to Switch about Printing…"
              schema={messageForm}
              onSend={ignore}
            />
          </div>
        </Part>
        <Part name="What floats">
          <div className={`${FLOAT} w-[300px]`}>
            <div className="flex h-line items-center px-inset text-ui font-semibold line-2-b">
              <span className="trim">Needs you</span>
            </div>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 p-inset">
              <span className="trim text-ui text-ink2">Show</span>
              <span className="flex">
                <Segmented
                  label="Show"
                  options={[
                    { value: "here", label: "This space's" },
                    { value: "all", label: "All" },
                  ]}
                  value="here"
                  onChange={ignore}
                />
              </span>
              <span className="trim text-ui text-ink2">Group</span>
              <span className="flex">
                <Segmented
                  label="Group"
                  options={[
                    { value: "none", label: "None" },
                    { value: "space", label: "By space" },
                  ]}
                  value="none"
                  onChange={ignore}
                />
              </span>
            </div>
          </div>
        </Part>
        <ChartsGallery />
        <WidgetParts />
      </main>
    </div>
  )
}
