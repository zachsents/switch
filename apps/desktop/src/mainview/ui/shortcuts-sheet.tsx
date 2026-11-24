// ⌘/: every shortcut, a line each, its keys at the end.
import { Dialog } from "@base-ui/react/dialog"

import { FLOAT } from "./kit/float.ts"
import { SHORTCUTS } from "./use-shortcuts.ts"

export const ShortcutsSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0" />
      <Dialog.Popup
        className={`${FLOAT} fixed top-[72px] left-1/2 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2`}
      >
        <Dialog.Title className="flex h-line items-center px-3 text-ui font-semibold text-ink line-1-b">
          <span className="trim">Keyboard Shortcuts</span>
        </Dialog.Title>
        <ul className="m-0 max-h-[min(520px,70vh)] list-none overflow-y-auto p-0">
          {SHORTCUTS.map(([label, keys]) => (
            <li
              key={label}
              className="flex h-line items-center px-3 text-ui line-2-t first:after:hidden"
            >
              <span className="trim min-w-0 flex-1 truncate">{label}</span>
              <kbd className="trim flex-none font-sans text-ui text-ink2">{keys}</kbd>
            </li>
          ))}
        </ul>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
)
