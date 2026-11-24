// A2UI's Modal: its trigger in place, and pressing it (what's in it acts too, as in A2UI's own) floats
// its content over the page as what floats does (DESIGN.md, Float: the background, a line-1
// hairline, no shadow, a little rounded), centred, at least 280 wide and its content's size up to most of
// the window, as old Switchboard's was (plain's a2ui-gpui). Esc, a press outside or its ✕ (a flat
// key in its corner, as a widget's is in edit mode) puts it away.
import { createComponentImplementation } from "@a2ui/react"
import { Dialog } from "@base-ui/react/dialog"
import { ModalApi } from "@a2ui/web_core/v1_0"

import { Button } from "../../ui/kit/button.tsx"
import { FLOAT } from "../../ui/kit/float.ts"
import { share } from "./flex.ts"

export const Modal = createComponentImplementation(ModalApi, ({ props, buildChild }) => (
  <Dialog.Root>
    <Dialog.Trigger nativeButton={false} render={<div style={share(props.weight)} />}>
      {buildChild(props.trigger)}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0" />
      <Dialog.Popup
        className={`${FLOAT} fixed top-1/2 left-1/2 max-h-[85vh] max-w-[80vw] min-w-[280px] -translate-1/2 overflow-y-auto`}
      >
        {buildChild(props.content)}
        <Dialog.Close
          render={<Button look="flat" aria-label="Close" className="absolute top-1 right-1 z-10" />}
        >
          ✕
        </Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
))
