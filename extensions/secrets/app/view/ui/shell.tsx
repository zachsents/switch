// The vault, open: the band, then the filters, the list with its search and the item beside it, or
// a page of its own (the generator, devices, grants, audit, import, export). Commands come from
// the menu bar and the keys alike.
import { useForm, useSelector } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Suspense, useRef } from "react"

import { PAGES } from "../../shared/rpc.ts"
import type { Command, Status } from "../../shared/rpc.ts"
import { useBridge } from "../bridge.ts"
import { draftOf } from "../drafts.ts"
import { listed } from "../listing.ts"
import { lockMutation, saveMutation, trashMutation } from "../mutations.ts"
import { itemsQuery } from "../queries.ts"
import { editItem, newItem, openFilter, openItem, openPage, useRoute } from "../route.ts"
import type { Route } from "../route.ts"
import { AuditPage } from "./audit-page.tsx"
import { Band } from "./band.tsx"
import { Boundary } from "./boundary.tsx"
import { DevicesPage } from "./devices-page.tsx"
import { Editor } from "./editor.tsx"
import { ExportPage } from "./export-page.tsx"
import { Filters } from "./filters.tsx"
import { GeneratorPage } from "./generator-page.tsx"
import { GrantsPage } from "./grants-page.tsx"
import { ImportPage } from "./import-page.tsx"
import { ItemPage } from "./item-page.tsx"
import { List } from "./list.tsx"
import { Stop } from "./marks.tsx"

/** Commands with nothing but their kind. */
type Simple = Exclude<Command["kind"], "open" | "search" | "page">

/** The item the page shows: the one chosen, else the list's first. */
const openOf = (route: Route, order: readonly string[]) => {
  if (route.page === "items") {
    return route.item ?? order[0] ?? null
  }
  return route.page === "edit" ? route.item : null
}

const pageOf = (route: Route) =>
  route.page === "edit" || route.page === "new" ? "items" : route.page

export const Shell = ({ status }: { status: Status }) => {
  const route = useRoute()
  const items = useQuery(itemsQuery)
  const all = items.data ?? []
  const form = useForm({ defaultValues: { query: "" } })
  const query = useSelector(form.store, (f) => f.values.query)
  const search = useRef<HTMLInputElement>(null)
  const lock = useMutation(lockMutation)
  const save = useMutation(saveMutation)
  const trash = useMutation(trashMutation)
  const filter = route.page === "items" ? route.filter : "all"
  const shown = listed(all, filter, query)
  const order = shown.map((i) => i.id)
  const open = openOf(route, order)
  const openNow = all.find((i) => i.id === open)
  const failed = save.error ?? trash.error

  const step = (by: number) => {
    const at = open === null ? -1 : order.indexOf(open)
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))]
    if (next !== undefined) {
      openItem(next)
    }
  }

  const simple: Record<Simple, () => unknown> = {
    find: () => {
      if (route.page !== "items") {
        openPage("items")
      }
      search.current?.focus()
      search.current?.select()
    },
    new: () => {
      newItem("login")
    },
    edit: () => {
      if (openNow) {
        editItem(openNow.id)
      }
    },
    favorite: () => {
      if (openNow) {
        save.mutate({ ...draftOf(openNow), favorite: !openNow.favorite })
      }
    },
    delete: () => {
      if (openNow && openNow.trashed === 0) {
        trash.mutate({ id: openNow.id, restore: false })
      }
    },
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
    lock: () => {
      lock.mutate()
    },
  }

  const run = (c: Command) => {
    if (c.kind === "open") {
      const found = all.find((i) => i.id === c.item || i.name === c.item)
      if (found) {
        openItem(found.id, found.trashed > 0 ? "trash" : "all")
      }
    } else if (c.kind === "search") {
      openPage("items")
      form.setFieldValue("query", c.query)
    } else if (c.kind === "page") {
      openPage(c.page)
    } else {
      simple[c.kind]()
    }
  }

  useBridge(run)

  const side = route.page === "items" || route.page === "edit" || route.page === "new"

  const right = () => {
    switch (route.page) {
      case "items": {
        return open === null ? null : <ItemPage id={open} />
      }
      case "edit": {
        return <Editor id={route.item} kind={openNow?.kind ?? "login"} />
      }
      case "new": {
        return <Editor id={null} kind={route.kind} />
      }
      case "generator": {
        return <GeneratorPage />
      }
      case "devices": {
        return <DevicesPage device={status.device} />
      }
      case "grants": {
        return <GrantsPage items={all} />
      }
      case "audit": {
        return <AuditPage />
      }
      case "import": {
        return <ImportPage />
      }
      case "export": {
        return <ExportPage />
      }
      default: {
        return route satisfies never
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Band
        page={pageOf(route)}
        pages={PAGES}
        onPage={openPage}
        online={status.online}
        end={
          <>
            {failed && (
              <span className="flex items-center gap-2 text-small text-band-ink">
                <Stop />
                {failed.message}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                lock.mutate()
              }}
              className="sign flex h-10 items-center rounded-row px-2 text-name text-band-ink2 outline-none hover:bg-band-wash hover:text-band-ink"
            >
              Lock
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        {side && (
          <>
            <Filters items={all} filter={filter} onFilter={openFilter} />
            <List
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
                            field.handleChange("")
                          }
                        }}
                        className="selectable h-full w-full border-0 bg-transparent px-inset text-read text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
                      />
                    )}
                  </form.Field>
                </form>
              }
              items={shown}
              open={open}
              error={items.error?.message ?? null}
              onOpen={(id) => {
                openItem(id)
              }}
            />
          </>
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-paper">
          <Boundary key={`${route.page}:${open ?? ""}`}>
            <Suspense fallback={null}>{right()}</Suspense>
          </Boundary>
        </main>
      </div>
    </div>
  )
}
