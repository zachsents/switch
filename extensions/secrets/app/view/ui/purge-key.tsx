// Delete for good: the item and its history gone from every device, after a confirm and the Mac's
// own check. Floats over the page, so it's rounded.
import { AlertDialog } from "@base-ui/react/alert-dialog"
import { useMutation } from "@tanstack/react-query"

import { purgeMutation } from "../mutations.ts"
import { openFilter } from "../route.ts"
import { Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

export const PurgeKey = ({ id, title }: { id: string; title: string }) => {
  const purge = useMutation(purgeMutation)
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Key />}>Delete</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-100 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed top-[22%] left-1/2 w-[420px] -translate-x-1/2 overflow-hidden rounded-card bg-overlay shadow-float outline-none">
          <AlertDialog.Title className="m-0 flex h-head items-center px-inset text-small font-semibold tracking-[0.06em] text-ink uppercase hairline-b">
            Delete {title}
          </AlertDialog.Title>
          <div className="flex h-head items-center gap-2 px-inset">
            {purge.error && (
              <span className="flex min-w-0 items-center gap-2 text-small text-ink">
                <Stop size={12} />
                <span className="truncate">{purge.error.message}</span>
              </span>
            )}
            <span className="ml-auto flex gap-2">
              <AlertDialog.Close render={<Key />}>Cancel</AlertDialog.Close>
              <Key
                disabled={purge.isPending}
                onClick={() => {
                  purge.mutate(id, {
                    onSuccess: () => {
                      openFilter("trash")
                    },
                  })
                }}
              >
                Delete
              </Key>
            </span>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
