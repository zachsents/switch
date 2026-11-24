// One item: every field (concealed ones as dots, with Reveal and Copy), its URLs, notes, where it's
// filed, its history with each old value and Restore, and its last uses from the audit.
import { useMutation, useSuspenseQuery } from "@tanstack/react-query"

import { NOTES } from "../../shared/rpc.ts"
import { draftOf } from "../drafts.ts"
import { when } from "../format.ts"
import { KIND_NAMES } from "../listing.ts"
import { openUrlMutation, saveMutation, trashMutation } from "../mutations.ts"
import { itemQuery } from "../queries.ts"
import { editItem } from "../route.ts"
import { Boundary } from "./boundary.tsx"
import { Cells } from "./cells.tsx"
import { FieldRow, Flat } from "./field-row.tsx"
import { HistorySection } from "./history-section.tsx"
import { Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"
import { PurgeKey } from "./purge-key.tsx"
import { UsesSection } from "./uses-section.tsx"

const MATCH = { domain: "Domain", host: "Host", exact: "Exact" } as const

export const ItemPage = ({ id }: { id: string }) => {
  const { data: item } = useSuspenseQuery(itemQuery(id))
  const save = useMutation(saveMutation)
  const trash = useMutation(trashMutation)
  const open = useMutation(openUrlMutation)
  if (!item) {
    return null
  }
  const fields = item.fields.filter((f) => f.set)
  const failed = save.error ?? trash.error
  return (
    <article className="min-h-full bg-paper">
      <header className="flex h-head items-center gap-3 px-inset hairline-b">
        <h2 className="selectable m-0 min-w-0 flex-1 truncate text-name font-semibold">
          {item.title}
        </h2>
        {failed && (
          <span className="flex min-w-0 items-center gap-2 text-small text-ink">
            <Stop size={12} />
            <span className="truncate">{failed.message}</span>
          </span>
        )}
        {item.trashed > 0 ? (
          <>
            <Key
              disabled={trash.isPending}
              onClick={() => {
                trash.mutate({ id, restore: true })
              }}
            >
              Restore
            </Key>
            <PurgeKey id={id} title={item.title} />
          </>
        ) : (
          <>
            <Flat
              disabled={save.isPending}
              onClick={() => {
                save.mutate({ ...draftOf(item), favorite: !item.favorite })
              }}
            >
              {item.favorite ? "★" : "☆"}
            </Flat>
            <Key
              onClick={() => {
                editItem(id)
              }}
            >
              Edit
            </Key>
            <Key
              disabled={trash.isPending}
              onClick={() => {
                trash.mutate({ id, restore: false })
              }}
            >
              Trash
            </Key>
          </>
        )}
      </header>
      <Section label={KIND_NAMES[item.kind]} count={fields.length}>
        {fields.map((f) => (
          <FieldRow key={f.id} item={id} field={f} />
        ))}
        {item.notes && (
          <FieldRow
            item={id}
            field={{
              id: NOTES,
              label: "Notes",
              type: "concealed",
              concealed: true,
              value: "",
              set: true,
            }}
          />
        )}
      </Section>
      {item.urls.length > 0 && (
        <Section label="URLs" count={item.urls.length}>
          {item.urls.map((u) => (
            <Cells key={u.url} label={MATCH[u.match ?? "domain"]}>
              <button
                type="button"
                onClick={() => {
                  open.mutate(u.url)
                }}
                className="text-left text-ink underline-offset-2 hover:underline"
              >
                {u.url}
              </button>
            </Cells>
          ))}
        </Section>
      )}
      <Section label="Details">
        <Cells label="Name">
          <span className="font-mono">{item.name}</span>
        </Cells>
        {item.folder && <Cells label="Folder">{item.folder}</Cells>}
        {item.tags.length > 0 && <Cells label="Tags">{item.tags.join(", ")}</Cells>}
        {item.spaces.length > 0 && <Cells label="Spaces">{item.spaces.join(", ")}</Cells>}
        <Cells label="Source">{item.source}</Cells>
        <Cells label="Created">
          <span className="font-mono text-data">{when(item.created)}</span>
        </Cells>
        <Cells label="Updated">
          <span className="font-mono text-data">{when(item.updated)}</span>
        </Cells>
        {item.trashed > 0 && (
          <Cells label="Trashed">
            <span className="font-mono text-data">{when(item.trashed)}</span>
          </Cells>
        )}
      </Section>
      <Boundary>
        <HistorySection id={id} />
      </Boundary>
      <Boundary>
        <UsesSection id={id} />
      </Boundary>
    </article>
  )
}
