// The paged history's queries: a space's chat and a thread's transcript, newest page first.
import type { SpaceId, ThreadId } from "@switch/brain"
import { infiniteQueryOptions } from "@tanstack/react-query"

import { page } from "./client.ts"
import { chatKey, LATEST, threadKey, toChatPage, toThreadPage } from "./history.ts"

export const chatQuery = (space: SpaceId) =>
  infiniteQueryOptions({
    queryKey: chatKey(space),
    queryFn: async ({ pageParam }) => toChatPage(await page("chat", { space, before: pageParam })),
    initialPageParam: LATEST,
    staleTime: Infinity,
    getNextPageParam: (last) => (last.more ? last.lines[0]?.seq : undefined),
  })

export const threadQuery = (thread: ThreadId) =>
  infiniteQueryOptions({
    queryKey: threadKey(thread),
    queryFn: async ({ pageParam }) =>
      toThreadPage(await page("thread", { thread, before: pageParam })),
    initialPageParam: LATEST,
    staleTime: Infinity,
    getNextPageParam: (last) => (last.more ? last.items[0]?.seq : undefined),
  })
