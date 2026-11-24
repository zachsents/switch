// An ask's live view in the apps' web views (core/portal.ts serves it): the screen of the Mac that
// holds the tab, decoded with WebCodecs from screen-relay's H.264 stream as the core relays it, and
// the user's input sent back as the engine's input records. The fragment names the item, the
// credential and the mode: `watch` only shows it (a card's preview); otherwise it's driven. With a
// mouse, clicks, drags, the wheel and typing go to the Mac (⌘V types the clipboard); nothing with
// ⌘, ⌃ or ⌥ goes, since that could reach past the page. With a finger, as Switchboard's iPhone
// portal: a tap clicks; hold, then drag, drags; a swipe scrolls (the zoomed-in view first, then
// the page); a pinch zooms the picture here; the keyboard key brings up the keyboard, with Tab and
// Shift-Tab beside it. When the view ends, the app hosting it hears why (`ended`).
import {
  encodeAck,
  encodeInput,
  h264Codec,
  HID_KEYS,
  parseMessage,
  textEvents,
} from "screen-relay/protocol"
import type { InputEvent } from "screen-relay/protocol"

const params = new URLSearchParams(location.hash.slice(1))
const item = params.get("item") ?? ""
const token = params.get("token") ?? ""
const watching = params.get("watch") === "1"

const stage = document.querySelector<HTMLDivElement>("#stage")
const canvas = document.querySelector<HTMLCanvasElement>("#screen")
const keys = document.querySelector<HTMLTextAreaElement>("#keys")
const bar = document.querySelector<HTMLDivElement>("#bar")
const context = canvas?.getContext("2d")
if (!stage || !canvas || !keys || !bar || !context) {
  throw new Error("The viewer's page is missing its parts")
}

declare global {
  interface Window {
    /** The iPhone's web view: its handler for what this page tells it. */
    readonly webkit?: {
      readonly messageHandlers?: { readonly portal?: { postMessage: (m: unknown) => void } }
    }
  }
}

/** Tells the app hosting this page: the iPhone's web view, or the desktop's frame. */
const tell = (message: Record<string, unknown>) => {
  window.webkit?.messageHandlers?.portal?.postMessage(message)
  if (window.parent !== window) {
    window.parent.postMessage({ portal: item, ...message }, "*")
  }
}

// ——— The picture ———

/** The screen's size in pixels, from its frames. */
let width = 0
let height = 0
/** Zoom over fitting the whole screen, and where its corner is on the page. */
let zoom = 1
let offsetX = 0
let offsetY = 0

const fit = () => (width > 0 && height > 0 ? Math.min(innerWidth / width, innerHeight / height) : 1)
const scale = () => fit() * zoom
/** As far in as it zooms: three points on the page to a pixel of the screen. */
const maxZoom = () => Math.max(1, 3 / fit())

/** Keeps the picture on the page: centered where it's smaller, edge to edge where it's larger. */
const clamp = () => {
  const w = width * scale()
  const h = height * scale()
  offsetX = w <= innerWidth ? (innerWidth - w) / 2 : Math.min(0, Math.max(innerWidth - w, offsetX))
  offsetY =
    h <= innerHeight ? (innerHeight - h) / 2 : Math.min(0, Math.max(innerHeight - h, offsetY))
}

const place = () => {
  clamp()
  canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale()})`
}
addEventListener("resize", place)

/** A point on the page as a fraction of the screen, as the engine takes it. */
const at = (clientX: number, clientY: number) => {
  const s = scale()
  const x = Math.min(Math.max((clientX - offsetX) / s, 0), width - 1)
  const y = Math.min(Math.max((clientY - offsetY) / s, 0), height - 1)
  return { x: x / Math.max(width - 1, 1), y: y / Math.max(height - 1, 1) }
}

// ——— The stream ———

let socket: WebSocket | null = null
let decoder: VideoDecoder | null = null
let generation = 0
/** Frames sent to the decoder and not yet drawn, oldest first, to ACK in order. */
let waiting: { sequence: number; timestamp: number; arrived: number }[] = []
let ended = false

const reset = () => {
  if (decoder && decoder.state !== "closed") {
    decoder.close()
  }
  decoder = null
  waiting = []
}

const draw = (frame: VideoFrame) => {
  const ws = socket
  const done: typeof waiting = []
  while (waiting.length > 0 && (waiting[0]?.timestamp ?? Infinity) <= frame.timestamp) {
    const w = waiting.shift()
    if (w) {
      done.push(w)
    }
  }
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth
    canvas.height = frame.displayHeight
    width = frame.displayWidth
    height = frame.displayHeight
    place()
  }
  context.drawImage(frame, 0, 0)
  frame.close()
  for (const w of done) {
    ws?.send(Uint8Array.from(encodeAck(generation, w.sequence, performance.now() - w.arrived)))
  }
}

const receive = (data: ArrayBuffer) => {
  const message = parseMessage(data)
  if (message.type !== "frame") {
    return
  }
  const { generation: now } = message
  if (now !== generation) {
    reset()
    generation = now
  }
  if (!decoder) {
    if (!message.keyframe) {
      return
    }
    decoder = new VideoDecoder({
      output: draw,
      error: () => {
        socket?.close()
      },
    })
    decoder.configure({
      codec: h264Codec(message.data),
      codedWidth: message.width,
      codedHeight: message.height,
      optimizeForLatency: true,
    })
  }
  waiting.push({
    sequence: message.sequence,
    timestamp: message.timestamp,
    arrived: performance.now(),
  })
  decoder.decode(
    new EncodedVideoChunk({
      type: message.keyframe ? "key" : "delta",
      timestamp: message.timestamp,
      data: message.data,
    }),
  )
}

const connect = () => {
  if (ended || document.hidden || socket) {
    return
  }
  const url = new URL(`/portal/${encodeURIComponent(item)}`, location.href)
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  if (watching) {
    url.searchParams.set("watch", "1")
  }
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  socket = ws
  ws.addEventListener("message", (e) => {
    if (e.data instanceof ArrayBuffer) {
      receive(e.data)
    }
  })
  ws.addEventListener("close", (e) => {
    if (socket !== ws) {
      return
    }
    socket = null
    reset()
    generation = 0
    // Hidden, it waits to be seen again; anything else is the end, which the app hears.
    if (!document.hidden) {
      ended = true
      tell({ ended: e.reason || "Ended", code: e.code })
    }
  })
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    socket?.close()
  } else {
    connect()
  }
})

// ——— Input ———

/** The buttons held down, as the engine's mask counts them: 1 the left, 2 the middle, 4 the right. */
const held = new Set<1 | 2 | 3>()
const MASK = { 1: 1, 2: 2, 3: 4 } as const
let shifted = false

const send = (event: InputEvent) => {
  if (watching || socket?.readyState !== WebSocket.OPEN || generation === 0) {
    return
  }
  let buttons = 0
  for (const b of held) {
    buttons += MASK[b]
  }
  // Shift is the second of the engine's modifier bits.
  const modifiers = shifted ? 2 : 0
  socket.send(Uint8Array.from(encodeInput({ ...event, buttons, modifiers }, generation, 0)))
}

const press = (key: number, shift = false) => {
  const SHIFT = HID_KEYS.ShiftLeft ?? 225
  if (shift) {
    shifted = true
    send({ type: "keyDown", key: SHIFT })
  }
  send({ type: "keyDown", key })
  send({ type: "keyUp", key })
  if (shift) {
    shifted = false
    send({ type: "keyUp", key: SHIFT })
  }
}

const type = (text: string) => {
  for (const event of textEvents(text)) {
    send(event)
  }
}

const click = (clientX: number, clientY: number) => {
  const p = at(clientX, clientY)
  send({ type: "pointerMove", ...p })
  held.add(1)
  send({ type: "buttonDown", button: 1, ...p })
  held.delete(1)
  send({ type: "buttonUp", button: 1, ...p })
}

/** Keys sent as themselves; anything printable is typed as its character. */
const NAMED = new Set([
  "Backspace",
  "Enter",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
])

/** A key that was sent itself, so the edit the field would make of it isn't sent again. */
let keyed = false

keys.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey) {
    // ⌘V types the clipboard (the paste below); nothing else with ⌘ or ⌃ goes.
    if (!(e.metaKey && e.key === "v")) {
      e.preventDefault()
    }
    return
  }
  const code = HID_KEYS[e.code === "" ? e.key : e.code] ?? HID_KEYS[e.key]
  if (NAMED.has(e.key) && code !== undefined) {
    e.preventDefault()
    keyed = true
    press(code, e.shiftKey)
    return
  }
  if (!e.isComposing && e.key.length === 1 && !e.altKey) {
    e.preventDefault()
    type(e.key)
  }
})

keys.addEventListener("beforeinput", (e) => {
  e.preventDefault()
  if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
    type(e.data ?? "")
  } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
    if (!keyed) {
      press(HID_KEYS.Enter ?? 40)
    }
  } else if (e.inputType === "deleteContentBackward" && !keyed) {
    press(HID_KEYS.Backspace ?? 42)
  }
  keyed = false
})

keys.addEventListener("paste", (e) => {
  e.preventDefault()
  type(e.clipboardData?.getData("text/plain") ?? "")
})

// With a mouse: clicks, drags and the wheel.
const BUTTON: Record<number, 1 | 2 | 3> = { 0: 1, 1: 2, 2: 3 }
/** Wheel notches, as screen-relay's viewer counts them: what's left over waits for the next. */
let wheelLeft = 0
const PIXELS_PER_NOTCH = 100

const wheel = (notches: number, clientX: number, clientY: number) => {
  if (Math.sign(notches) !== Math.sign(wheelLeft)) {
    wheelLeft = 0
  }
  wheelLeft += notches
  const whole = Math.trunc(wheelLeft)
  if (whole === 0) {
    return
  }
  wheelLeft -= whole
  send({
    type: "wheel",
    axis: "vertical",
    delta: Math.min(Math.max(whole * 120, -1200), 1200),
    ...at(clientX, clientY),
  })
}

stage.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") {
    return
  }
  const button = BUTTON[e.button]
  if (!button) {
    return
  }
  e.preventDefault()
  keys.focus()
  stage.setPointerCapture(e.pointerId)
  held.add(button)
  send({ type: "buttonDown", button, ...at(e.clientX, e.clientY) })
})
stage.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") {
    send({ type: "pointerMove", ...at(e.clientX, e.clientY) })
  }
})
stage.addEventListener("pointerup", (e) => {
  const button = BUTTON[e.button]
  if (e.pointerType !== "mouse" || !button) {
    return
  }
  held.delete(button)
  send({ type: "buttonUp", button, ...at(e.clientX, e.clientY) })
})
stage.addEventListener("contextmenu", (e) => {
  e.preventDefault()
})
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault()
    const notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / PIXELS_PER_NOTCH
    wheel(notches, e.clientX, e.clientY)
  },
  { passive: false },
)

// With a finger: tap, hold then drag, swipe, pinch.
const HOLD_MS = 300
const SLOP = 10
const DRAG_EVERY_MS = 30

type Touching =
  | { kind: "maybe"; x: number; y: number; started: number; timer: number }
  | { kind: "drag"; last: number }
  | { kind: "swipe"; x: number; y: number; t: number; vx: number; vy: number }
  | { kind: "pinch"; distance: number; x: number; y: number }
  | null

let touching: Touching = null

const spread = (t: TouchList) => {
  const [a, b] = t
  if (!a || !b) {
    return null
  }
  return {
    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  }
}

/** Scrolls the page by a move of the finger on the page: the page moves with it. */
const scrollBy = (dy: number, clientX: number, clientY: number) => {
  wheel(-dy / scale() / PIXELS_PER_NOTCH, clientX, clientY)
}

/** A finger's move: the zoomed-in picture moves first; what's left scrolls the page. */
const pan = (dx: number, dy: number, clientX: number, clientY: number) => {
  const beforeX = offsetX
  const beforeY = offsetY
  offsetX += dx
  offsetY += dy
  place()
  const leftY = dy - (offsetY - beforeY)
  const leftX = dx - (offsetX - beforeX)
  if (Math.abs(leftY) > Math.abs(leftX) && Math.abs(leftY) > 0.5) {
    scrollBy(leftY, clientX, clientY)
  }
}

stage.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault()
    if (e.touches.length >= 2) {
      if (touching?.kind === "maybe") {
        clearTimeout(touching.timer)
      }
      const s = spread(e.touches)
      touching = s && { kind: "pinch", ...s }
      return
    }
    const [t] = e.touches
    if (!t) {
      return
    }
    const x = t.clientX
    const y = t.clientY
    const timer = window.setTimeout(() => {
      if (touching?.kind === "maybe") {
        const p = at(x, y)
        send({ type: "pointerMove", ...p })
        held.add(1)
        send({ type: "buttonDown", button: 1, ...p })
        touching = { kind: "drag", last: performance.now() }
      }
    }, HOLD_MS)
    touching = { kind: "maybe", x, y, started: performance.now(), timer }
  },
  { passive: false },
)

stage.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault()
    const [t] = e.touches
    if (!t || !touching) {
      return
    }
    if (touching.kind === "pinch") {
      const s = spread(e.touches)
      if (!s) {
        return
      }
      const now = Math.min(Math.max((zoom * s.distance) / touching.distance, 1), maxZoom())
      const k = now / zoom
      // The point under the fingers stays under them, and moves with them.
      offsetX = s.x - (touching.x - offsetX) * k
      offsetY = s.y - (touching.y - offsetY) * k
      zoom = now
      place()
      touching = { kind: "pinch", ...s }
      return
    }
    if (touching.kind === "maybe") {
      if (Math.hypot(t.clientX - touching.x, t.clientY - touching.y) <= SLOP) {
        return
      }
      clearTimeout(touching.timer)
      touching = { kind: "swipe", x: touching.x, y: touching.y, t: performance.now(), vx: 0, vy: 0 }
    }
    if (touching.kind === "drag") {
      const now = performance.now()
      if (now - touching.last >= DRAG_EVERY_MS) {
        touching.last = now
        send({ type: "pointerMove", ...at(t.clientX, t.clientY) })
      }
      return
    }
    const now = performance.now()
    const dx = t.clientX - touching.x
    const dy = t.clientY - touching.y
    const dt = Math.max(now - touching.t, 1)
    touching = {
      kind: "swipe",
      x: t.clientX,
      y: t.clientY,
      t: now,
      vx: (dx / dt) * 1000,
      vy: (dy / dt) * 1000,
    }
    pan(dx, dy, t.clientX, t.clientY)
  },
  { passive: false },
)

const lift = (e: TouchEvent) => {
  e.preventDefault()
  const [t] = e.changedTouches
  const was = touching
  if (e.touches.length > 0 || !t || !was) {
    if (e.touches.length === 0) {
      touching = null
    }
    return
  }
  touching = null
  if (was.kind === "maybe") {
    clearTimeout(was.timer)
    if (e.type === "touchend") {
      click(t.clientX, t.clientY)
    }
  } else if (was.kind === "drag") {
    const p = at(t.clientX, t.clientY)
    send({ type: "pointerMove", ...p })
    held.delete(1)
    send({ type: "buttonUp", button: 1, ...p })
  } else if (was.kind === "swipe" && Math.abs(was.vy) > 400) {
    // A fling carries on: about a third of a second's worth.
    const canY = height * scale() > innerHeight + 1
    if (!canY) {
      scrollBy(was.vy * 0.3, t.clientX, t.clientY)
    }
  }
}
stage.addEventListener("touchend", lift, { passive: false })
stage.addEventListener("touchcancel", lift, { passive: false })

// The keyboard's row, under a finger: the keyboard itself, Tab and Shift-Tab.
const row = (label: string, act: () => void) => {
  const b = document.createElement("button")
  b.type = "button"
  b.textContent = label
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault()
  })
  b.addEventListener("click", act)
  bar.append(b)
}

if (!watching) {
  if (matchMedia("(pointer: coarse)").matches) {
    row("Keyboard", () => {
      if (document.activeElement === keys) {
        keys.blur()
      } else {
        keys.focus()
      }
    })
    row("Tab", () => {
      press(HID_KEYS.Tab ?? 43)
    })
    row("⇧Tab", () => {
      press(HID_KEYS.Tab ?? 43, true)
    })
    bar.hidden = false
    // The row rides above the keyboard.
    visualViewport?.addEventListener("resize", () => {
      const v = visualViewport
      if (v) {
        bar.style.bottom = `${Math.max(innerHeight - v.height - v.offsetTop, 0)}px`
      }
    })
  } else {
    keys.focus()
  }
}

connect()
