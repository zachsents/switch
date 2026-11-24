// A handle on the window for the journey gate (apps/desktop/scripts): open a space, read its widgets.
// Nothing else drives the window.
import { SpaceId } from "@switch/brain/commands"

import { brainQuery } from "./brain/client.ts"
import { queryClient } from "./query.ts"
import { openSpace } from "./ui/nav.ts"

const drive = {
  open: (space: string) => {
    openSpace(SpaceId.make(space))
  },
  /** A space's placed widgets, as this window holds them. */
  widgets: (space: string) =>
    queryClient
      .getQueryData(brainQuery.queryKey)
      ?.extra.widgets.filter((w) => w.space === SpaceId.make(space)) ?? [],
}

declare global {
  interface Window {
    switchDrive?: typeof drive
  }
}

window.switchDrive = drive
