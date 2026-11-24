// What the user does with an action item, as mutations: answer it (approve, decline, choose, type),
// mark it done or dismiss it, reopen a closed one, reply on it, or answer a sealed one. Each payload
// is checked against the command's schema (autonomy's items.ts, mirrored) before it goes.
import { mutationOptions } from "@tanstack/react-query"
import { Option, Schema } from "effect"
import { seal } from "switch-ext-kit/sealed"

import { command } from "./client.ts"
import * as outbox from "./outbox.ts"
import { coreUrl } from "./auth.ts"
import type { ActionItem } from "./items.ts"

const Answer = Schema.Struct({
  id: Schema.String,
  approved: Schema.optionalKey(Schema.Boolean),
  choice: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  drafts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  edited: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Answer = typeof Answer.Type

const Close = Schema.Struct({ id: Schema.String, status: Schema.Literals(["done", "dismissed"]) })
export type Close = typeof Close.Type

const Reply = Schema.Struct({ space: Schema.String, text: Schema.String, item: Schema.String })

const valid = <P>(payload: Schema.Codec<P, unknown>, value: P) =>
  Schema.decodeUnknownSync(payload)(value)

/** What the user did with an item, held a moment for Undo before it goes. */
export type Done =
  | { readonly kind: "answer"; readonly answer: Answer }
  | { readonly kind: "close"; readonly close: Close }

/** The command it is, as kept in the outbox while it's held. */
export const commandOf = (done: Done) =>
  done.kind === "answer"
    ? { kind: "command" as const, name: "item.answer", payload: done.answer }
    : { kind: "command" as const, name: "item.close", payload: done.close }

/** It goes with the id it was kept under, so a resend after a relaunch is the same command. */
export const doneMutation = mutationOptions({
  mutationKey: ["item.done"],
  mutationFn: async ({ id, done }: { readonly id: string; readonly done: Done }) =>
    done.kind === "answer"
      ? await command("item.answer", valid(Answer, done.answer), id)
      : await command("item.close", valid(Close, done.close), id),
})

const Edit = Schema.Struct({
  id: Schema.String,
  drafts: Schema.Record(Schema.String, Schema.String),
})

/** The user's own version of an item's drafts, saved as he types: not an approval. */
export const editMutation = mutationOptions({
  mutationKey: ["item.edit"],
  mutationFn: async ({ id, edit }: { readonly id: string; readonly edit: typeof Edit.Type }) =>
    await command("item.edit", valid(Edit, edit), id),
})

const decodeEdit = Schema.decodeUnknownOption(Edit)

/** An edit kept on this Mac at once (outbox.ts), due to be sent in `ms`; under `id`, it replaces. */
export const keepEdit = (id: string, edit: typeof Edit.Type, ms: number) => {
  outbox.keep({
    id,
    kind: "command",
    name: "item.edit",
    payload: valid(Edit, edit),
    due: Date.now() + ms,
  })
}

/** An item's edit kept on this Mac and not yet answered by the brain (outbox.ts), the newest. */
export const keptEdit = (item: string) => {
  const k = outbox.latest("item.edit", (p) => Option.getOrNull(decodeEdit(p))?.id === item)
  const edit = k ? Option.getOrNull(decodeEdit(k.payload)) : null
  return k && edit ? { id: k.id, drafts: edit.drafts } : null
}

/** Its card opened: the core brings each draft's copy (an email draft) and the card to one version. */
export const draftsMutation = mutationOptions({
  mutationKey: ["item.drafts"],
  mutationFn: async (id: string) => {
    if (outbox.QUIET) {
      return
    }
    const res = await fetch(coreUrl(`/items/${encodeURIComponent(id)}/drafts`), {
      method: "POST",
    }).catch(() => {
      throw new Error("Can't reach the core")
    })
    if (!res.ok) {
      throw new Error((await res.text()) || "Didn't go through")
    }
  },
})

export const reopenMutation = mutationOptions({
  mutationKey: ["item.reopen"],
  mutationFn: async (id: string) =>
    await command("item.reopen", valid(Schema.Struct({ id: Schema.String }), { id })),
})

/** Words on an item, to the work that raised it: a message in its space that names the item. */
export const replyMutation = mutationOptions({
  mutationKey: ["item.reply"],
  mutationFn: async (reply: typeof Reply.Type) =>
    await command("message.post", valid(Reply, reply)),
})

/**
 * A sealed answer: sealed here to the item's one-time key, and only the sealed bytes leave, to the
 * core, which hands them to the extension that asked. Nothing of the secret is kept.
 */
export const sealedMutation = mutationOptions({
  mutationKey: ["item.sealed"],
  mutationFn: async ({ item, secret }: { readonly item: ActionItem; readonly secret: string }) => {
    if (!item.sealed) {
      throw new Error("It isn't sealed")
    }
    const sealed = await seal(item.sealed.key, item.id, item.sealed.use, secret)
    const res = await fetch(coreUrl(`/items/${encodeURIComponent(item.id)}/sealed`), {
      method: "POST",
      // Plain text, so the browser sends it without asking first (no CORS preflight).
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(sealed),
    }).catch(() => {
      throw new Error("Can't reach the core")
    })
    if (!res.ok) {
      throw new Error((await res.text()) || "Didn't go through")
    }
  },
  // Never retried with the secret held.
  retry: false,
})
