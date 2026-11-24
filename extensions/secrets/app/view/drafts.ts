// An item as a draft to save: what the view knows of it, its concealed values left out, so the
// bun process keeps them as they are.
import type { FieldDraft, ItemDraft, ShownField, ShownItem } from "../shared/rpc.ts"

export const fieldDraft = (f: ShownField): FieldDraft =>
  f.concealed
    ? { id: f.id, label: f.label, type: f.type }
    : { id: f.id, label: f.label, type: f.type, value: f.value }

export const draftOf = (item: ShownItem): ItemDraft => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  name: item.name,
  fields: item.fields.map(fieldDraft),
  urls: item.urls,
  tags: item.tags,
  folder: item.folder,
  spaces: item.spaces,
  favorite: item.favorite,
})
