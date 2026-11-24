// What changes the vault, or reaches past the view (a reveal, a copy): mutations of the bun
// process, the same few calls whichever page asks. Each marks the queries stale when it lands.
import { mutationOptions } from "@tanstack/react-query"

import type { Source } from "../../src/imports.ts"
import type { GrantRow, ItemDraft } from "../shared/rpc.ts"
import { ask } from "./bridge.ts"
import { queryClient, SECRETS } from "./query.ts"

const settle = async () => {
  await queryClient.invalidateQueries({ queryKey: SECRETS })
}

export interface FieldAt {
  readonly id: string
  readonly field: string
  /** A version from its history. */
  readonly at?: number
}

const at = (f: FieldAt) => (f.at === undefined ? { id: f.id, field: f.field } : f)

export const revealMutation = mutationOptions({
  mutationFn: async (f: FieldAt) => await ask.reveal(at(f)),
})

export const copyMutation = mutationOptions({
  mutationFn: async (f: FieldAt) => await ask.copy(at(f)),
})

export const copyTextMutation = mutationOptions({
  mutationFn: async (text: string) => await ask.copyText({ text }),
})

export const unlockMutation = mutationOptions({
  mutationKey: [...SECRETS, "unlock"],
  mutationFn: async () => await ask.unlock({}),
  onSettled: settle,
})

export const lockMutation = mutationOptions({
  mutationFn: async () => await ask.lock({}),
  onSettled: settle,
})

export const retryMutation = mutationOptions({
  mutationFn: async () => await ask.retry({}),
  onSettled: settle,
})

export const saveMutation = mutationOptions({
  mutationFn: async (draft: ItemDraft) => await ask.save({ draft }),
  onSettled: settle,
})

export const restoreMutation = mutationOptions({
  mutationFn: async (r: { id: string; at: number; field: string }) => await ask.restore(r),
  onSettled: settle,
})

export const trashMutation = mutationOptions({
  mutationFn: async (t: { id: string; restore: boolean }) => await ask.trash(t),
  onSettled: settle,
})

export const purgeMutation = mutationOptions({
  mutationFn: async (id: string) => await ask.purge({ id }),
  onSettled: settle,
})

export const approveDeviceMutation = mutationOptions({
  mutationFn: async (id: string) => await ask.approveDevice({ id }),
  onSettled: settle,
})

export const revokeDeviceMutation = mutationOptions({
  mutationFn: async (id: string) => await ask.revokeDevice({ id }),
  onSettled: settle,
})

export const approveExtensionMutation = mutationOptions({
  mutationFn: async (name: string) => await ask.approveExtension({ name }),
  onSettled: settle,
})

export const grantMutation = mutationOptions({
  mutationFn: async (g: { op: "add" | "remove"; grant: GrantRow }) => await ask.grant(g),
  onSettled: settle,
})

export const pickImportMutation = mutationOptions({
  mutationFn: async () => await ask.importPick({}),
})

export const previewImportMutation = mutationOptions({
  mutationFn: async (p: { source: Source; file: string }) => await ask.importPreview(p),
})

export const confirmImportMutation = mutationOptions({
  mutationFn: async () => await ask.importConfirm({}),
  onSettled: settle,
})

export const exportMutation = mutationOptions({
  mutationFn: async (format: "csv" | "json") => await ask.export({ format }),
})

export const openUrlMutation = mutationOptions({
  mutationFn: async (url: string) => await ask.openUrl({ url }),
})

export const revokeExtensionMutation = mutationOptions({
  mutationFn: async (name: string) => await ask.revokeExtension({ name }),
  onSettled: settle,
})
