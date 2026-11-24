// A2UI's Tabs: their titles as the house's Segmented over the chosen tab's child, on a strip as the
// house strips a Segmented over what it chooses (Settings › Providers: inset, a line-2 under it). The
// first is chosen until another is, and again when the chosen one is gone, as in A2UI's own.
import { createComponentImplementation } from "@a2ui/react"
import { TabsApi } from "@a2ui/web_core/v1_0"
import { useState } from "react"

import { Segmented } from "../../ui/kit/segmented.tsx"
import { share } from "./flex.ts"
import { wordsOf } from "./words.ts"

export const Tabs = createComponentImplementation(TabsApi, ({ props, buildChild }) => {
  const [chosen, setChosen] = useState(0)
  const at = chosen < props.tabs.length ? chosen : 0
  const tab = props.tabs[at]
  return (
    <div className="flex flex-col" style={share(props.weight)}>
      <div className="flex h-9 items-center px-inset line-2-b">
        <Segmented
          label="Tabs"
          options={props.tabs.map((t, i) => ({ value: String(i), label: wordsOf(t.title) }))}
          value={String(at)}
          onChange={(next) => {
            setChosen(Number(next))
          }}
        />
      </div>
      {tab && buildChild(tab.child)}
    </div>
  )
})
