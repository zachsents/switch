// Extensions: what's installed, each with its version, Update and Remove under the pointer; adding one
// by URL on top.
import { useMutation } from "@tanstack/react-query"

import { useBrain } from "../brain/use-brain.ts"
import { Data, Section } from "./parts.tsx"
import { ExtensionAdd } from "./extension-add.tsx"
import { installMutation, removeMutation, updateMutation } from "./extensions.ts"
import { PaneScroll } from "./pane-scroll.tsx"
import { Button } from "./kit/button.tsx"

const line = "group/line flex h-line items-center gap-2.5 px-inset text-ui text-ink hover:lit"

/** Its keys show under the pointer, or once one is focused. */
const keys = "opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"

export const ExtensionsPage = () => {
  const install = useMutation(installMutation)
  const update = useMutation(updateMutation)
  const remove = useMutation(removeMutation)
  const error = install.error ?? update.error ?? remove.error
  const extensions = useBrain((s) =>
    [...s.extra.extensions.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
  )
  return (
    <PaneScroll className="flex-1 bg-bg">
      <ExtensionAdd install={install} />
      {error && (
        <div className="flex h-line items-center px-inset text-small text-ink line-2-b">
          {error.message}
        </div>
      )}
      <Section label="Installed" count={extensions.length}>
        {extensions.length === 0 && <li className={`${line} text-ink3`}>None</li>}
        {extensions.map((p) => (
          <li key={p.name} className={line} title={p.from}>
            <span className="min-w-0 truncate">{p.name}</span>
            <span className="ml-auto" />
            <Data>{p.version}</Data>
            <Button
              look="key"
              className={keys}
              disabled={update.isPending && update.variables === p.name}
              onClick={() => {
                update.mutate(p.name)
              }}
            >
              Update
            </Button>
            <Button
              look="danger"
              className={keys}
              disabled={remove.isPending && remove.variables === p.name}
              onClick={() => {
                remove.mutate(p.name)
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </Section>
    </PaneScroll>
  )
}
