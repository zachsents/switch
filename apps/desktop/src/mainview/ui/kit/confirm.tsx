// What takes something away asks first (T3 Code's confirm dialog, on Base UI's AlertDialog): its key
// opens the question; Cancel, first and focused, or Esc, keeps everything; the act's own key, in the
// danger color, goes ahead. Nothing but the question and the two keys.
import { AlertDialog } from "@base-ui/react/alert-dialog"

import { Button } from "./button.tsx"
import { FLOAT } from "./float.ts"

export const Confirm = ({
  act,
  question,
  disabled = false,
  onConfirm,
}: {
  /** The act's word, on its key and on the question's: "Remove". */
  act: string
  question: string
  disabled?: boolean
  onConfirm: () => void
}) => (
  <AlertDialog.Root>
    <AlertDialog.Trigger disabled={disabled} render={<Button look="danger" />}>
      {act}
    </AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="fixed inset-0" />
      <AlertDialog.Popup
        className={`${FLOAT} fixed top-[72px] left-1/2 w-[320px] max-w-[calc(100vw-32px)] -translate-x-1/2`}
      >
        <AlertDialog.Title className="m-0 flex h-line items-center px-3 text-ui font-semibold text-ink line-1-b">
          <span className="trim min-w-0 truncate">{question}</span>
        </AlertDialog.Title>
        <div className="flex h-line items-center justify-end gap-2 px-3">
          <AlertDialog.Close render={<Button look="key" />}>Cancel</AlertDialog.Close>
          <AlertDialog.Close render={<Button look="danger" />} onClick={onConfirm}>
            {act}
          </AlertDialog.Close>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>
)
