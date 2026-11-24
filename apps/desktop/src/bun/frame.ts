// Every window frame the app gives goes through here. AppKit throws on a frame that isn't finite
// or has a negative size, and that aborts the app; and a window being closed (asked to close, its
// close event not yet back) reads back a frame that is no frame at all. So a frame is made finite,
// sized and on a display, and a closing window is left alone. A window whose page is away (a video
// played full screen takes the page into a window of WebKit's own until it's back) takes its frame
// once the page is back: Electrobun's resize reaches for the page's container through the page's
// parent, the full screen window's view has no such method, and the throw aborts the app.
import { dlopen, FFIType } from "bun:ffi"
import type { Pointer } from "bun:ffi"
import { BrowserWindow, Screen } from "electrobun/main"

export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/** The smallest side a window takes. */
const LEAST = 200

const finite = (n: number, otherwise: number) => (Number.isFinite(n) ? n : otherwise)

/** The work area of the display under `f`'s centre, else the primary's; null when none is known. */
const areaOf = (f: Frame): Frame | null => {
  const cx = f.x + f.width / 2
  const cy = f.y + f.height / 2
  const areas = Screen.getAllDisplays()
    .map((d) => d.workArea)
    .filter((a) => a.width > 0 && a.height > 0)
  const under = areas.find(
    (a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height,
  )
  const primary = Screen.getPrimaryDisplay().workArea
  return under ?? (primary.width > 0 && primary.height > 0 ? primary : (areas[0] ?? null))
}

/** `f` as a frame AppKit takes: finite, whole, at least LEAST a side, within a display's work area. */
export const safeFrame = (f: Frame): Frame => {
  const width = Math.round(Math.max(finite(f.width, LEAST), LEAST))
  const height = Math.round(Math.max(finite(f.height, LEAST), LEAST))
  const given = { x: Math.round(finite(f.x, 0)), y: Math.round(finite(f.y, 0)), width, height }
  const area = areaOf(given)
  if (area === null) {
    return given
  }
  const w = Math.min(width, area.width)
  const h = Math.min(height, area.height)
  return {
    x: Math.min(Math.max(given.x, area.x), area.x + area.width - w),
    y: Math.min(Math.max(given.y, area.y), area.y + area.height - h),
    width: w,
    height: h,
  }
}

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})
const asks = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
})
/** An address Bun gives back; past 2^53 it's a bigint, which no object's address is. */
const address = (got: Pointer | bigint | null) => (typeof got === "bigint" ? null : got)
const sel = (name: string) => address(objc.symbols.sel_registerName(Buffer.from(`${name}\0`)))
const NS_VIEW = sel("nsView")
const SUPERVIEW = sel("superview")
const RESPONDS = sel("respondsToSelector:")
/** What Electrobun's resize asks of a page's parent: only its own container answers it. */
const CONTAINER_ASK = sel("updateActiveWebviewForMousePosition:")

/** `to`'s answer to `what`, an object. */
const send = (to: Pointer | null, what: Pointer | null) =>
  to === null || what === null ? null : address(objc.symbols.objc_msgSend(to, what))

/** The window's page is in its container (or it has none), so a resize can reach it. */
const home = (w: BrowserWindow) => {
  const parent = send(send(w.webview?.ptr ?? null, NS_VIEW), SUPERVIEW)
  return (
    parent === null ||
    RESPONDS === null ||
    asks.symbols.objc_msgSend(parent, RESPONDS, CONTAINER_ASK)
  )
}

/** How often a window whose page is away is looked at again. */
const AWAY_MS = 250

/** The latest frame given each window whose page is away. */
const waiting = new WeakMap<BrowserWindow, Frame>()

/** Gives `w` its waiting frame once its page is back, or drops it once it's closing. */
const awaitHome = (w: BrowserWindow) => {
  const check = setInterval(() => {
    if (closing.has(w) || home(w)) {
      clearInterval(check)
      const f = waiting.get(w)
      waiting.delete(w)
      if (f) {
        setFrame(w, f)
      }
    }
  }, AWAY_MS)
}

/** Windows asked to close whose close event hasn't come back. */
const closing = new WeakSet<BrowserWindow>()

/** A window whose first frame is a safe one, and that is known to be closing once it's asked to. */
export const openFramed = (
  options: ConstructorParameters<typeof BrowserWindow>[0] & { frame: Frame },
) => {
  const w = new BrowserWindow({ ...options, frame: safeFrame(options.frame) })
  const close = w.close.bind(w)
  w.close = () => {
    closing.add(w)
    close()
  }
  w.on("close", () => {
    closing.add(w)
  })
  return w
}

/** The window's frame, or null once it's closing. */
export const currentFrame = (w: BrowserWindow): Frame | null => {
  if (closing.has(w)) {
    return null
  }
  const f = w.getFrame()
  return [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0
    ? f
    : null
}

/** Moves and sizes the window to a safe `f`; a closing window is left alone, and one whose page is
 * away takes it once the page is back. */
export const setFrame = (w: BrowserWindow, f: Frame) => {
  if (closing.has(w)) {
    return
  }
  if (!home(w)) {
    if (!waiting.has(w)) {
      awaitHome(w)
    }
    waiting.set(w, f)
    return
  }
  // A newer frame than the one waiting.
  waiting.delete(w)
  const s = safeFrame(f)
  w.setFrame(s.x, s.y, s.width, s.height)
}
