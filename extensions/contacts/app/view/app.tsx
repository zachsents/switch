// The window: the band, the list with its search, and the page beside it (a person, people picked
// to merge, or every change). Commands come from the menu bar, the agent and the keys alike.
import { useForm, useSelector } from "@tanstack/react-form"
import { useIsMutating, useMutation } from "@tanstack/react-query"
import { Suspense, useRef, useState } from "react"

import type { Command } from "../shared/commands.ts"
import { useBridge } from "./bridge.ts"
import { KIND_FILTERS, NO_SEARCH, searchForm } from "./forms.ts"
import { useListing } from "./listing.ts"
import { importMutation, undoMutation } from "./mutations.ts"
import { queryClient } from "./query.ts"
import { CONTACTS, logQuery, personQuery } from "./queries.ts"
import { currentRoute, openChanges, openPeople, openPerson, useRoute } from "./route.ts"
import { Band } from "./ui/band.tsx"
import { Boundary } from "./ui/boundary.tsx"
import { ChangesPage } from "./ui/changes-page.tsx"
import { FilterSelect } from "./ui/filter-select.tsx"
import { Runner, Stop } from "./ui/marks.tsx"
import { MergePage } from "./ui/merge-page.tsx"
import { NewPerson } from "./ui/new-person.tsx"
import { PersonPage } from "./ui/person-page.tsx"
import { Side } from "./ui/side.tsx"

/** The person open, as far as the cache knows them when the agent asks. */
const shownOf = (open: string) => {
  const p = queryClient.getQueryData(personQuery(open).queryKey)
  return { id: p?.id ?? open, name: p?.name ?? "" }
}

const TYPE_FILTERS = [
  { value: "person", label: "Person" },
  { value: "company", label: "Company" },
  { value: "system", label: "System" },
  { value: "none", label: "None" },
]

/** Commands with nothing but their kind. */
type Simple = Exclude<Command["kind"], "open" | "search" | "pick">

export const App = () => {
  const route = useRoute()
  const form = useForm({ defaultValues: NO_SEARCH, validators: { onChange: searchForm } })
  const searched = useSelector(form.store, (f) => f.values)
  const search = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<readonly string[]>([])
  const [making, setMaking] = useState(false)
  const importing = useMutation(importMutation)
  const undo = useMutation(undoMutation)
  const { lines, labels, order, error } = useListing(searched)
  const open = route.page === "people" ? (route.person ?? order[0] ?? null) : null
  const busy = useIsMutating({ mutationKey: [...CONTACTS, "import"] }) > 0
  const failed = importing.error ?? undo.error

  const step = (by: number) => {
    const at = open === null ? -1 : order.indexOf(open)
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))]
    if (next !== undefined) {
      openPerson(next)
    }
  }
  const pick = (id: string) => {
    setPicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]))
  }

  const undoLast = async () => {
    const batches = await queryClient.query(logQuery)
    const last = batches.find((b) => !b.undone)
    if (last) {
      undo.mutate(last.batch)
    }
  }

  const simple: Record<Simple, () => void> = {
    find: () => {
      search.current?.focus()
      search.current?.select()
    },
    new: () => {
      setMaking(true)
    },
    people: openPeople,
    changes: openChanges,
    back: () => {
      history.back()
    },
    forward: () => {
      history.forward()
    },
    next: () => {
      step(1)
    },
    previous: () => {
      step(-1)
    },
    merge: () => {
      if (open !== null) {
        pick(open)
      }
    },
    undo: () => {
      void undoLast()
    },
    import: () => {
      importing.mutate()
    },
  }

  const run = (c: Command) => {
    if (c.kind === "open") {
      openPerson(c.person)
    } else if (c.kind === "search") {
      form.setFieldValue("query", c.query)
    } else if (c.kind === "pick") {
      setPicked(c.people)
    } else {
      simple[c.kind]()
    }
  }

  useBridge(run, () => {
    const now = currentRoute()
    const person = now.page === "people" ? (now.person ?? order[0] ?? null) : null
    return {
      page: picked.length >= 2 ? "merge" : now.page,
      person: person === null ? null : shownOf(person),
      query: form.state.values.query,
      listed: order.length,
      picked,
    }
  })

  const pageOf = () => {
    if (picked.length >= 2) {
      return (
        <MergePage
          picked={picked}
          onCancel={() => {
            setPicked([])
          }}
          onDone={(into) => {
            setPicked([])
            openPerson(into)
          }}
        />
      )
    }
    if (route.page === "changes") {
      return <ChangesPage />
    }
    return open === null ? null : <PersonPage person={open} />
  }

  return (
    <div className="flex h-full flex-col">
      <Band
        page={route.page}
        onPeople={openPeople}
        onChanges={openChanges}
        live={
          <>
            {busy && <Runner paper="var(--color-band)" />}
            {failed !== null && (
              <span className="flex items-center gap-2 text-small text-band-ink">
                <Stop />
                {failed.message}
              </span>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <Side
          search={
            <form
              className="flex h-head flex-none items-center hairline-b"
              onSubmit={(e) => {
                e.preventDefault()
              }}
            >
              <form.Field name="query">
                {(field) => (
                  <input
                    ref={search}
                    type="search"
                    aria-label="Search"
                    placeholder="Search"
                    autoFocus
                    value={field.state.value}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault()
                        step(e.key === "ArrowDown" ? 1 : -1)
                      } else if (e.key === "Escape") {
                        if (picked.length > 0) {
                          setPicked([])
                        } else if (field.state.value === "") {
                          form.reset()
                        } else {
                          field.handleChange("")
                        }
                      }
                    }}
                    className="selectable h-full w-full border-0 bg-transparent px-inset text-read text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
                  />
                )}
              </form.Field>
            </form>
          }
          filters={
            <div className="flex h-line flex-none hairline-b">
              <form.Field name="type">
                {(field) => (
                  <FilterSelect
                    label="Type"
                    value={field.state.value}
                    options={TYPE_FILTERS}
                    onChange={(v) => {
                      field.handleChange(KIND_FILTERS.find((k) => k === v) ?? "")
                    }}
                  />
                )}
              </form.Field>
              <form.Field name="label">
                {(field) => (
                  <FilterSelect
                    label="Label"
                    value={field.state.value}
                    options={labels.map((l) => ({ value: l, label: l }))}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            </div>
          }
          lines={lines}
          open={open}
          picked={picked}
          error={error}
          onOpen={openPerson}
          onPick={pick}
        />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-paper">
          <Boundary key={picked.length >= 2 ? "merge" : `${route.page}:${open ?? ""}`}>
            <Suspense fallback={null}>{pageOf()}</Suspense>
          </Boundary>
        </main>
      </div>
      <NewPerson open={making} onOpenChange={setMaking} onMade={openPerson} />
    </div>
  )
}
