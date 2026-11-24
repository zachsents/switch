// The window: the band, then the page open. Every space's page is mounted once, each in its own
// <Activity>, visible only while it's open: React draws the hidden ones ahead and keeps their
// state, so opening one is instant and keeps its place. A first open shows once its chat has laid
// out (use-shown-page.ts). No fade.
import type { SpaceId } from "@switch/brain"
import { useMutation } from "@tanstack/react-query"
import { Activity, useState } from "react"

import { useAuth } from "./brain/auth.ts"
import * as derive from "./brain/derive.ts"
import { HOME, ThreadId } from "@switch/brain/commands"
import { stopMutation } from "./brain/mutations.ts"
import { useBrain } from "./brain/use-brain.ts"
import { Band } from "./ui/band.tsx"
import { Boundary } from "./ui/boundary.tsx"
import { station } from "./ui/look.ts"
import { Runner } from "./ui/marks.tsx"
import { useWhere } from "./ui/nav.ts"
import { Pairing } from "./ui/pairing.tsx"
import { Palette } from "./ui/palette.tsx"
import { useShown } from "./ui/reports.ts"
import { SpacePage } from "./ui/space-page.tsx"
import { ThreadPage } from "./ui/thread.tsx"
import { ShortcutsSheet } from "./ui/shortcuts-sheet.tsx"
import { spaceMenuOf, useRenaming } from "./ui/spaces.ts"
import { useCommands } from "./ui/use-commands.ts"
import { useHistoryInput } from "./ui/use-history-input.ts"
import { useMenu } from "./ui/use-menu.ts"
import { useNow } from "./ui/use-now.ts"
import { useShownPage } from "./ui/use-shown-page.ts"
import { useShortcuts } from "./ui/use-shortcuts.ts"
import { useThemeSync } from "./ui/use-theme-sync.ts"
import { useTrack } from "./ui/use-track.ts"
import { usePrefetch } from "./widgets/use-prefetch.ts"
import { useWatch } from "./widgets/use-watch.ts"

/** The window, or the code to approve while this app pairs. */
export const App = () => {
  const auth = useAuth()
  return auth !== null && "code" in auth ? <Pairing code={auth.code} /> : <Window />
}

const Window = () => {
  const { page } = useWhere()
  const now = useNow()
  const [finding, setFinding] = useState(false)
  /** The space whose chat ⌘F's bar is open on. */
  const [searchingIn, setSearchingIn] = useState<SpaceId | null>(null)
  useTrack(page)
  useThemeSync()
  useHistoryInput()
  useWatch()
  usePrefetch()

  const { thread, space, parent, ink, menu, running, name } = useBrain((s) => {
    const t = page.kind === "thread" ? s.threads.get(page.id) : undefined
    const opened = page.kind === "space" ? page.id : HOME
    const here = t ? derive.spaceOf(s, t) : opened
    // A space archived or not yet known: Home, once the log has said so.
    const at = s.spaces.has(here) || !s.ready ? here : HOME
    const own = s.threads.get(ThreadId.make(`space:${at}`))
    const live = t ?? (page.kind === "space" ? own : undefined)
    return {
      running: live?.status === "running" ? live.id : null,
      thread: t,
      space: at,
      parent: s.spaces.get(at)?.parent ?? HOME,
      ink: at === HOME ? "var(--color-home)" : station(s, at).ink,
      name: s.spaces.get(at)?.name ?? "Home",
      menu: {
        spaces: derive.warmest(s).map((x) => ({ id: x.id, name: x.name })),
        inside: derive.children(s, at).map((x) => ({ id: x.id, name: x.name })),
        here: spaceMenuOf(s, at),
      },
    }
  })

  // In a fixed order, so a page's node never moves (a moved node loses its scroll).
  const pages = useBrain((s) => [
    ...new Set([HOME, space, ...derive.live(s).map((x) => x.id)].toSorted()),
  ])
  const { shown, arriving, laidOut } = useShownPage(page, space)
  const [shortcuts, setShortcuts] = useState(false)
  const renaming = useRenaming()
  useShown({
    space: page.kind === "space" ? space : null,
    screen: thread ? `thread ${thread.title} in ${name}` : `${page.kind} ${name}`,
  })
  const searching = page.kind === "space" && searchingIn === space
  const stopping = useMutation(stopMutation)
  const run = useCommands({
    page,
    space,
    parent,
    setFinding,
    setShortcuts,
    searching,
    setSearchingIn,
    stop: () => {
      if (running) {
        stopping.mutate({ thread: running })
      }
    },
  })
  useShortcuts(run, space, finding || searching || shortcuts || renaming !== null)
  useMenu(menu, run)

  return (
    <div className="flex h-full flex-col">
      <Boundary>
        <Band
          space={page.kind === "space" ? shown : space}
          title={thread?.title}
          live={
            thread?.status === "running" ? <Runner size={20} paper="var(--color-bg)" /> : undefined
          }
        />
      </Boundary>
      {thread && (
        <Boundary>
          <ThreadPage key={thread.id} t={thread} ink={ink} />
        </Boundary>
      )}
      <div
        className={`relative flex min-h-0 flex-1 flex-col ${page.kind === "space" ? "" : "hidden"}`}
      >
        {pages?.map((id) => (
          <Activity
            key={id}
            mode={page.kind === "space" && (id === shown || id === arriving) ? "visible" : "hidden"}
          >
            <div
              className={
                id === arriving
                  ? "invisible absolute inset-0 flex flex-col"
                  : "flex min-h-0 flex-1 flex-col"
              }
            >
              <Boundary>
                <SpacePage
                  space={id}
                  now={now}
                  at={page.kind === "space" && page.id === id ? (page.at ?? null) : null}
                  searching={searching && id === space}
                  onSearchEnd={() => {
                    setSearchingIn(null)
                  }}
                  onLaidOut={() => {
                    laidOut(id)
                  }}
                />
              </Boundary>
            </div>
          </Activity>
        ))}
      </div>
      <Boundary>
        <Palette here={space} open={finding} onOpenChange={setFinding} />
      </Boundary>
      <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} />
    </div>
  )
}
