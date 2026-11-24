// Every command the UI sends, as a mutation. Each payload is checked against the command's own
// schema before it goes, and what the UI shows at once is put in the cache first (`onMutate`).
import {
  AskRef,
  ArchiveSpace,
  CreateSpace,
  HOME,
  MoveSpace,
  ReactToMessage,
  PostMessage,
  RenameSpace,
  SpaceId,
  SplitOff,
  UnarchiveSpace,
  SpaceRead,
} from "@switch/brain/commands"
import { EDIT, EditPayload, FORGET, ForgetPayload } from "@switch/autonomy/memory-commands"
import {
  EditPayload as EditMessage,
  RetryPayload,
  StopPayload,
  ThreadSteered,
} from "@switch/core/steered"
import { mutationOptions } from "@tanstack/react-query"
import { castDraft } from "immer"
import { Schema } from "effect"

import type { Dictated, Reaction } from "@switch/brain/commands"

import { STEER } from "./adapter.ts"
import { keptOf } from "./files.ts"
import type { Chosen } from "./files.ts"
import * as outbox from "./outbox.ts"
import { putFile } from "./outbox-files.ts"
import { queryClient } from "../query.ts"
import { brainQuery, change, command, emit } from "./client.ts"
import { madeSpace, readTo } from "./store.ts"
import { setPart, setReaction } from "./history.ts"
import type { Reply } from "./store.ts"

interface Post {
  readonly id: string
  readonly space: SpaceId
  readonly text: string
  readonly dictated?: Dictated
  readonly files: readonly Chosen[]
  /** What it replies to: words quoted from the chat, asks. */
  readonly replyTo?: readonly Reply[]
}

const askRef = Schema.decodeUnknownSync(AskRef)

/** A reply's refs as the brain takes them, each with the user's reply to it when there is one. */
const refsOf = (replies: readonly Reply[]) =>
  replies.map((r) => {
    const reply = (r.reply ?? "").trim() === "" ? {} : { reply: (r.reply ?? "").trim() }
    return r.kind === "quote"
      ? { kind: "quote" as const, seq: r.seq, text: r.text, ...reply }
      : askRef({ kind: "ask", id: r.id, ...reply })
  })

/** A closed action item open again (autonomy's `item.reopen`). */
const Reopen = Schema.Struct({ id: Schema.String })

/** Checks a payload against its command's own schema; what fails never leaves. */
const valid = <P>(payload: Schema.Codec<P, unknown>, value: P) =>
  Schema.decodeUnknownSync(payload)(value)

/**
 * A message, kept in the outbox at once with its files (their bytes are kept as they're attached),
 * which uploads them and sends it; the chat shows it from there, and "Not sent" if the core says no.
 */
export const postMutation = mutationOptions({
  mutationKey: ["message.post"],
  mutationFn: async ({ id, files, replyTo = [], ...words }: Post) => {
    const payload = valid(PostMessage.payload, {
      ...words,
      ...(replyTo.length > 0 && { replyTo: refsOf(replyTo) }),
    })
    outbox.keep({
      id,
      kind: "command",
      name: "message.post",
      payload,
      ...(files.length > 0 && { files: files.map(keptOf) }),
      time: Date.now(),
      ...(replyTo.length > 0 && { view: { replyTo } }),
    })
    // Bytes not kept yet (a box with no draft) are kept now, before any upload reads them.
    await Promise.all(
      files.map(async (c) => {
        await putFile(c.id, c.file)
      }),
    )
  },
})

export const steerMutation = mutationOptions({
  mutationKey: [STEER],
  mutationFn: async (payload: typeof ThreadSteered.payload.Type) =>
    await command(STEER, valid(ThreadSteered.payload, payload)),
})

interface React {
  readonly seq: number
  /** The tapback chosen. */
  readonly reaction: Reaction
  /** The user's reaction on it (or on these words) now, if any: choosing it again takes it off. */
  readonly was?: Reaction
  /** Words of the message it's on alone. */
  readonly quote?: string
}

/** A tapback shown at once, on the message or on its words alone. */
const showReaction = (seq: number, reaction: Reaction | undefined, quote: string | undefined) => {
  if (quote === undefined) {
    setReaction(queryClient, seq, "user", reaction)
  } else {
    setPart(queryClient, seq, "user", quote, reaction)
  }
}

/** The user's tapback on a message, as iMessage's: the same one again takes it off, another replaces it. */
export const reactMutation = mutationOptions({
  mutationKey: [ReactToMessage.type],
  mutationFn: async ({ seq, reaction, was, quote }: React) =>
    await command(
      ReactToMessage.type,
      valid(ReactToMessage.payload, {
        seq,
        reaction: reaction === was ? null : reaction,
        ...(quote !== undefined && { quote: { text: quote } }),
      }),
    ),
  onMutate: ({ seq, reaction, was, quote }) => {
    showReaction(seq, reaction === was ? undefined : reaction, quote)
  },
  onError: (_error, { seq, was, quote }) => {
    showReaction(seq, was, quote)
  },
})

/** Stops a thread's running turn. */
export const stopMutation = mutationOptions({
  mutationKey: ["thread.stop"],
  mutationFn: async (payload: typeof StopPayload.Type) =>
    await command("thread.stop", valid(StopPayload, payload)),
})

/** Runs a turn that didn't finish again. */
export const retryMutation = mutationOptions({
  mutationKey: ["thread.retry"],
  mutationFn: async (payload: typeof RetryPayload.Type) =>
    await command("thread.retry", valid(RetryPayload, payload)),
})

/** The user's last message, changed; the brain runs it again or sends it new. */
export const editMutation = mutationOptions({
  mutationKey: ["message.edit"],
  mutationFn: async (payload: typeof EditMessage.Type) =>
    await command("message.edit", valid(EditMessage, payload)),
})

/** The palette's commands, each with what it changes on screen before the brain answers. */
export type Act =
  | { readonly type: "space.create"; readonly payload: typeof CreateSpace.payload.Type }
  | { readonly type: "space.archive"; readonly payload: typeof ArchiveSpace.payload.Type }
  | { readonly type: "space.unarchive"; readonly payload: typeof UnarchiveSpace.payload.Type }
  | { readonly type: "space.rename"; readonly payload: typeof RenameSpace.payload.Type }
  | { readonly type: "space.move"; readonly payload: typeof MoveSpace.payload.Type }
  | { readonly type: "space.split"; readonly payload: typeof SplitOff.payload.Type }
  | { readonly type: "item.reopen"; readonly payload: typeof Reopen.Type }

const checked = (act: Act) => {
  switch (act.type) {
    case "space.create": {
      return valid(CreateSpace.payload, act.payload)
    }
    case "space.archive": {
      return valid(ArchiveSpace.payload, act.payload)
    }
    case "space.unarchive": {
      return valid(UnarchiveSpace.payload, act.payload)
    }
    case "space.rename": {
      return valid(RenameSpace.payload, act.payload)
    }
    case "space.move": {
      return valid(MoveSpace.payload, act.payload)
    }
    case "space.split": {
      return valid(SplitOff.payload, act.payload)
    }
    case "item.reopen": {
      return valid(Reopen, act.payload)
    }
    default: {
      return act satisfies never
    }
  }
}

export const actMutation = mutationOptions({
  mutationKey: ["act"],
  mutationFn: async (act: Act) => await command(act.type, checked(act)),
  /** Answers the space as it was, to put back if the brain says no. */
  onMutate: (act) => {
    const held = queryClient.getQueryData(brainQuery.queryKey)
    const id =
      act.type.startsWith("space.") && "id" in act.payload ? SpaceId.make(act.payload.id) : HOME
    const space = held?.spaces.get(id)
    change((s) => {
      const target = s.spaces.get(id)
      switch (act.type) {
        case "space.create": {
          madeSpace(s, act.payload.id, act.payload.name, act.payload.parent ?? HOME)
          break
        }
        case "space.split": {
          madeSpace(s, act.payload.id, act.payload.name ?? "", act.payload.from)
          break
        }
        case "space.archive":
        case "space.unarchive": {
          if (target) {
            target.archived = act.type === "space.archive"
          }
          break
        }
        case "space.rename": {
          if (target) {
            target.name = act.payload.name.trim()
          }
          break
        }
        case "space.move": {
          if (target) {
            target.parent = act.payload.parent ?? HOME
          }
          break
        }
        case "item.reopen": {
          // It comes back whole with `item.reopened`.
          break
        }
        default: {
          act satisfies never
        }
      }
    })
    return { space }
  },
  // Undone where the brain said no; whatever landed meanwhile stays.
  onError: (_error, act, was) => {
    change((s) => {
      if (act.type === "space.create" || act.type === "space.split") {
        s.spaces.delete(act.payload.id)
      } else if (was?.space) {
        s.spaces.set(was.space.id, was.space)
      }
    })
  },
})

/** A space's chat read through `seq`: its unread mark clears at once, here and on every device. */
export const readMutation = mutationOptions({
  mutationKey: ["space.read"],
  mutationFn: async (payload: typeof SpaceRead.payload.Type) =>
    await command("space.read", valid(SpaceRead.payload, payload)),
  onMutate: ({ space, seq }) => {
    change((s) => {
      readTo(s, space, seq)
    })
  },
  retry: false,
})

/** UI analytics: best effort, never a word on screen. */
export const emitMutation = mutationOptions({
  mutationKey: ["emit"],
  mutationFn: async ({ event, payload }: { readonly event: string; readonly payload: unknown }) => {
    await emit(event, payload)
  },
  retry: false,
})

/** Forgets a memory, putting back what it replaced: the memory page's Forget, a line's Undo. */
export const forgetMutation = mutationOptions({
  mutationKey: [FORGET],
  mutationFn: async (payload: typeof ForgetPayload.Type) =>
    await command(FORGET, valid(ForgetPayload, payload)),
  onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories"] })
  },
})

/** The user's own words for a memory. */
export const editMemoryMutation = mutationOptions({
  mutationKey: [EDIT],
  mutationFn: async (payload: typeof EditPayload.Type) =>
    await command(EDIT, valid(EditPayload, payload)),
  onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories"] })
  },
})

/** A preference set in the brain, for every client. */
export const prefMutation = mutationOptions({
  mutationKey: ["pref.set"],
  mutationFn: async (payload: { readonly key: string; readonly value: unknown }) =>
    await command("pref.set", payload),
  onMutate: (payload) => {
    change((s) => {
      s.extra.prefs.set(payload.key, castDraft(payload.value))
    })
  },
})
