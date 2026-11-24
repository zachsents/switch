// The extension's answers as queries, all under ["contacts"], so a contacts event in the brain
// marks every one of them stale at once.
import { queryOptions } from "@tanstack/react-query"

import { History, Log, People, Person } from "./answers.ts"
import { call } from "./core.ts"

export const CONTACTS = ["contacts"] as const

export const peopleQuery = queryOptions({
  queryKey: [...CONTACTS, "people"],
  queryFn: async () => {
    const answer = await call("people", {}, People)
    return answer.people
  },
})

/** One person, by id, phone, email or exact name. */
export const personQuery = (person: string) =>
  queryOptions({
    queryKey: [...CONTACTS, "person", person],
    queryFn: async () => await call("get", { person }, Person),
  })

export const historyQuery = (person: string) =>
  queryOptions({
    queryKey: [...CONTACTS, "history", person],
    queryFn: async () => {
      const answer = await call("history", { person, limit: 100 }, History)
      return answer.changes
    },
  })

export const logQuery = queryOptions({
  queryKey: [...CONTACTS, "log"],
  queryFn: async () => {
    const answer = await call("log", { limit: 200 }, Log)
    return answer.batches
  },
})
