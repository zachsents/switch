/// <reference lib="dom" />

// The tab held for the user, live: its own rendering, and their taps, scrolls and typing applied to
// it as the browser's trusted input. Runs as an MCP App view and speaks the MCP Apps messages
// itself, asking the extension's tools for frames (view) and applying input (input). What's typed
// is sent and kept nowhere.
const PROTOCOL = "2026-01-26"
/** A frame this often while something's happening, and every IDLE_MS when nothing is. */
const FRAME_MS = 500
const IDLE_MS = 2000

const app = document.body.dataset.app ?? "browser"
const found = document.querySelector("#frame")
const img = found instanceof HTMLImageElement ? found : null
const keys = document.querySelector("#keys")
const typing = keys instanceof HTMLInputElement ? keys : null
const none = document.querySelector<HTMLElement>("#none")

let next = 2
const pending = new Map<number, (result: unknown, error: unknown) => void>()
const post = (message: Record<string, unknown>) => {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*")
}
const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const request = async (method: string, params: Record<string, unknown>) => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const id = next
  next += 1
  pending.set(id, (result, error) => {
    if (error === undefined) {
      resolve(result)
    } else {
      reject(
        new Error(isRecord(error) && typeof error.message === "string" ? error.message : "Failed"),
      )
    }
  })
  post({ id, method, params })
  return await promise
}

/** A tool's structured result, or its words as the error. */
const callTool = async (name: string, args: Record<string, unknown>) => {
  const result = await request("tools/call", { name: `${app}_${name}`, arguments: args })
  if (!isRecord(result)) {
    throw new Error("Failed")
  }
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content.filter(isRecord) : []
    const words = content.find((c) => typeof c.text === "string")?.text
    throw new Error(typeof words === "string" ? words : "Failed")
  }
  return isRecord(result.structuredContent) ? result.structuredContent : {}
}

const ignore = () => {
  // Each loop catches its own.
}

let session = ""
let initialized = false
let inputReceived = false
let framesStarted = false
const startFrames = () => {
  if (initialized && inputReceived && !framesStarted) {
    framesStarted = true
    frameLoop().catch(ignore)
  }
}
let width = 1
let height = 1
let busyUntil = 0

const say = (text: string) => {
  if (none) {
    none.textContent = text
  }
}

const frameLoop = async () => {
  try {
    const f = await callTool("view", session === "" ? {} : { session })
    if (img && typeof f.data === "string") {
      img.src = `data:image/jpeg;base64,${f.data}`
      session = typeof f.session === "string" ? f.session : session
      width = typeof f.width === "number" ? f.width : width
      height = typeof f.height === "number" ? f.height : height
      say("")
      size()
    }
  } catch (error) {
    img?.removeAttribute("src")
    say(error instanceof Error ? error.message : "Nothing held")
  }
  setTimeout(
    () => {
      frameLoop().catch(ignore)
    },
    Date.now() < busyUntil ? FRAME_MS : IDLE_MS,
  )
}

/** Input to the tab; frames come quickly for a while after. */
const input = (args: Record<string, unknown>) => {
  if (session === "") {
    return
  }
  busyUntil = Date.now() + 5000
  callTool("input", { session, ...args }).catch(() => {
    say("Input failed")
  })
}

/** A point on the picture, in the page's own coordinates. */
const pointOf = (e: MouseEvent) => {
  const r = img?.getBoundingClientRect()
  if (!r || r.width === 0 || r.height === 0) {
    return null
  }
  // object-fit: contain centers the picture inside the image element's box.
  const scale = Math.min(r.width / width, r.height / height)
  const x = (e.clientX - r.left - (r.width - width * scale) / 2) / scale
  const y = (e.clientY - r.top - (r.height - height * scale) / 2) / scale
  return x < 0 || y < 0 || x >= width || y >= height ? null : { x, y }
}

img?.addEventListener("click", (e) => {
  const at = pointOf(e)
  if (at) {
    input({ kind: "click", ...at })
    typing?.focus()
  }
})
img?.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault()
    const at = pointOf(e)
    if (at) {
      const r = img.getBoundingClientRect()
      const scale = Math.min(r.width / width, r.height / height)
      input({ kind: "scroll", ...at, dy: e.deltaY / scale })
    }
  },
  { passive: false },
)
typing?.addEventListener("input", () => {
  if (typing.value !== "") {
    input({ kind: "type", text: typing.value })
    typing.value = ""
  }
})
typing?.addEventListener("keydown", (e) => {
  const named: Record<string, string> = {
    Enter: "Enter",
    Backspace: "Backspace",
    Tab: "Tab",
    Escape: "Escape",
  }
  const key = named[e.key]
  if (key !== undefined) {
    e.preventDefault()
    input({ kind: "key", keys: key })
  }
})

/** The tab's own shape. */
let asked = 0
const size = () => {
  const w = document.documentElement.clientWidth || window.innerWidth
  const h = Math.round((w * height) / width)
  if (w > 0 && h !== asked) {
    asked = h
    post({ method: "ui/notifications/size-changed", params: { height: h } })
  }
}

window.addEventListener(
  "message",
  (
    e: MessageEvent<{
      id?: unknown
      result?: unknown
      error?: unknown
      method?: unknown
      params?: unknown
    }>,
  ) => {
    if (e.source !== window.parent) {
      return
    }
    if (e.data.method === "ui/notifications/tool-input" && isRecord(e.data.params)) {
      const { arguments: args } = e.data.params
      if (isRecord(args) && typeof args.session === "string") {
        ;({ session } = args)
      }
      inputReceived = true
      startFrames()
      return
    }
    if (typeof e.data.id !== "number") {
      return
    }
    if (e.data.id === 1 && e.data.result !== undefined) {
      initialized = true
      post({ method: "ui/notifications/initialized" })
      startFrames()
      return
    }
    const settle = pending.get(e.data.id)
    if (settle) {
      pending.delete(e.data.id)
      settle(e.data.result, e.data.error)
    }
  },
)
window.addEventListener("resize", size)

post({
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "browser-tab", version: "1" },
    appCapabilities: {},
    protocolVersion: PROTOCOL,
  },
})
