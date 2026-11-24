// A window shows and hides at once: macOS's own zoom and fade when a window is ordered in or out
// (NSWindow animationBehavior) is turned off, as everything else in the app moves only to show
// where something goes. A window can also be on screen see-through (its alpha), until it has drawn.
import { dlopen, FFIType } from "bun:ffi"
import type { Pointer } from "bun:ffi"

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.void },
})

/** NSWindowAnimationBehaviorNone. */
const NONE = 2
const SET = objc.symbols.sel_registerName(Buffer.from("setAnimationBehavior:\0"))

const alpha = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64], returns: FFIType.void },
})
const ALPHA = objc.symbols.sel_registerName(Buffer.from("setAlphaValue:\0"))

/** Turns off the window's show and hide animation. */
export const still = (window: Pointer | null) => {
  if (window !== null && SET !== null) {
    objc.symbols.objc_msgSend(window, SET, NONE)
  }
}

/** Makes the window see-through (on screen, where its page runs, but not seen), or seen. */
export const seen = (window: Pointer | null, on: boolean) => {
  if (window !== null && ALPHA !== null) {
    alpha.symbols.objc_msgSend(window, ALPHA, on ? 1 : 0)
  }
}
