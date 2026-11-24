// A page's preview: loaded in a headless browser at a width, measured, captured, its console read,
// as T3 Code's html_preview does (apps/server/src/htmlRender/headlessChrome.ts and
// apps/server/src/preview/PreviewBrowser.ts, MIT, Copyright (c) 2026 T3 Tools Inc.). The browser
// is Chrome for Testing's headless shell at T3's pin, fetched once into the core's folder and
// checked by size and SHA-256; it's driven over DevTools on a pipe (fd 3 in, fd 4 out, JSON
// messages ending in NUL).
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { Context, Effect, Layer, Option, Schema } from "effect"

// Update from each chrome-headless-shell zip at
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
const VERSION = "158.0.8127.36"
const ARCHIVES = {
  "mac-arm64": {
    bytes: 105_057_133,
    sha256: "c24d40a3786322ff3a5e3ac6eed162226cbaf07ebe468715407827226b0f8897",
  },
  "mac-x64": {
    bytes: 112_306_247,
    sha256: "e0c5d07d8f5bcc5bdd5ef370e7daf3770856b585fcc9eecf441c7e3bb2e3d1cf",
  },
  linux64: {
    bytes: 132_087_165,
    sha256: "2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a",
  },
  "linux-arm64": {
    bytes: 129_938_239,
    sha256: "176ee5c55486c22de43128871189061365ea28e881fc96016fd18e7cb59437c8",
  },
} as const
type Platform = keyof typeof ARCHIVES

/** The headless shell's platform for this machine's, by `<platform>-<arch>`. */
const PLATFORMS: Readonly<Record<string, Platform>> = {
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
  "linux-x64": "linux64",
  "linux-arm64": "linux-arm64",
}

/** How long a call waits for the browser to be fetched before saying it's still coming. */
const INSTALL_WAIT_MS = 90_000
const CAPTURE_TIMEOUT = "20 seconds"
const VIEWPORT_HEIGHT = 800
const MAX_CAPTURE_HEIGHT = 4000
const MAX_CONSOLE = 20
const MAX_CONSOLE_CHARS = 500
// Fonts, then two frames, so late layout is in.
const SETTLE =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))"
// scrollHeight is at least the viewport's; a shorter page is its root's box.
const MEASURE =
  "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()"

export interface ConsoleLine {
  readonly level: "log" | "info" | "warning" | "error"
  readonly text: string
}

export interface Captured {
  /** Base64. */
  readonly png: string
  readonly contentHeight: number
  readonly capturedHeight: number
  readonly console: readonly ConsoleLine[]
}

const LEVELS: Readonly<Record<string, ConsoleLine["level"]>> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warning",
  error: "error",
  assert: "error",
}

const Message = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Number),
    method: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    params: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
)
const decodeMessage = Schema.decodeUnknownOption(Message)
const Remote = Schema.Struct({
  type: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.String),
})
const decodeConsole = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, args: Schema.Array(Remote) }),
)
const decodeException = Schema.decodeUnknownOption(
  Schema.Struct({
    exceptionDetails: Schema.Struct({
      text: Schema.String,
      exception: Schema.optionalKey(Remote),
    }),
  }),
)
const decodeLog = Schema.decodeUnknownOption(
  Schema.Struct({
    entry: Schema.Struct({
      level: Schema.String,
      text: Schema.String,
      url: Schema.optionalKey(Schema.String),
    }),
  }),
)

const textOf = (v: typeof Remote.Type) => {
  if (typeof v.value === "string") {
    return v.value
  }
  return v.description ?? (v.value === undefined ? v.type : JSON.stringify(v.value))
}

/** A console line from a DevTools event, if it's one. */
const consoleLine = (method: string, params: unknown): ConsoleLine | undefined => {
  if (method === "Runtime.consoleAPICalled") {
    const e = Option.getOrUndefined(decodeConsole(params))
    const level = e === undefined ? undefined : LEVELS[e.type]
    return e && level ? { level, text: e.args.map(textOf).join(" ") } : undefined
  }
  if (method === "Runtime.exceptionThrown") {
    const d = Option.getOrUndefined(decodeException(params))?.exceptionDetails
    return d ? { level: "error", text: d.exception?.description ?? d.text } : undefined
  }
  if (method === "Log.entryAdded") {
    const e = Option.getOrUndefined(decodeLog(params))?.entry
    return e && (e.level === "error" || e.level === "warning")
      ? { level: e.level, text: e.url === undefined ? e.text : `${e.text} ${e.url}` }
      : undefined
  }
  return undefined
}

// Never half an emoji: a lone surrogate is JSON a model refuses.
const clip = (text: string) => {
  if (text.length <= MAX_CONSOLE_CHARS) {
    return text
  }
  const split = (text.codePointAt(MAX_CONSOLE_CHARS - 1) ?? 0) > 0xff_ff
  return `${text.slice(0, split ? MAX_CONSOLE_CHARS - 1 : MAX_CONSOLE_CHARS)}…`
}

const Target = Schema.Struct({ targetId: Schema.String })
const Session = Schema.Struct({ sessionId: Schema.String })
const Navigated = Schema.Struct({ errorText: Schema.optionalKey(Schema.String) })
const Measured = Schema.Struct({ result: Schema.Struct({ value: Schema.Finite }) })
const Shot = Schema.Struct({ data: Schema.String })
const Ignored = Schema.Unknown

const FLAGS = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--block-new-web-contents",
]

type Send = <A>(
  method: string,
  params: Record<string, unknown>,
  result: Schema.Decoder<A>,
  sessionId?: string,
) => Promise<A>

/**
 * Loads `file` at `width` in the headless shell at `exe`, then `finish` reads what it wants of it
 * (with what the console said). The browser goes when it's done, or when `signal` says to stop.
 */
const run = async <T>(
  exe: string,
  dir: string,
  file: string,
  width: number,
  appearance: string,
  signal: AbortSignal,
  finish: (send: Send, sessionId: string, logged: () => ConsoleLine[]) => Promise<T>,
): Promise<T> => {
  const child = spawn(
    exe,
    [...FLAGS, `--user-data-dir=${path.join(dir, "profile")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" },
  )
  const [toBrowser, fromBrowser] = child.stdio.slice(3)
  if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
    child.kill("SIGKILL")
    throw new Error("No pipe to the preview browser")
  }
  const url = pathToFileURL(file).href
  const pending = new Map<number, PromiseWithResolvers<unknown>>()
  const loaded = Promise.withResolvers<undefined>()
  const lines: ConsoleLine[] = []
  let omitted = 0
  let gone: Error | undefined
  let next = 0
  let partial = ""
  const fail = (e: Error) => {
    gone = e
    for (const p of pending.values()) {
      p.reject(e)
    }
    pending.clear()
  }
  child.on("error", fail)
  child.on("exit", () => {
    fail(new Error("The preview browser quit"))
  })
  fromBrowser.setEncoding("utf-8")
  fromBrowser.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\0")
    partial = parts.pop() ?? ""
    for (const raw of parts) {
      const m = Option.getOrUndefined(decodeMessage(raw))
      if (m?.id !== undefined) {
        const waiting = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) {
          waiting?.reject(new Error(m.error.message))
        } else {
          waiting?.resolve(m.result)
        }
      } else if (m?.method === "Page.loadEventFired") {
        loaded.resolve(undefined)
      } else if (m?.method !== undefined) {
        const line = consoleLine(m.method, m.params)
        if (line && lines.length >= MAX_CONSOLE) {
          omitted += 1
        } else if (line) {
          lines.push({ level: line.level, text: clip(line.text.replaceAll(url, "page.html")) })
        }
      }
    }
  })
  const send: Send = async (method, params, result, sessionId) => {
    if (gone) {
      throw gone
    }
    next += 1
    const id = next
    const answer = Promise.withResolvers<unknown>()
    pending.set(id, answer)
    toBrowser.write(
      `${JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) })}\0`,
    )
    return Schema.decodeUnknownSync(result)(await answer.promise)
  }
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" }, Target)
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }, Session)
    await Promise.all(
      ["Page.enable", "Runtime.enable", "Log.enable"].map(
        async (method) => await send(method, {}, Ignored, sessionId),
      ),
    )
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: appearance }] },
      Ignored,
      sessionId,
    )
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      Ignored,
      sessionId,
    )
    const went = await send("Page.navigate", { url }, Navigated, sessionId)
    if (went.errorText !== undefined) {
      throw new Error(`The page didn't open: ${went.errorText}`)
    }
    await loaded.promise
    await send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true }, Ignored, sessionId)
    return await finish(send, sessionId, () =>
      omitted === 0
        ? lines
        : [...lines, { level: "warning", text: `${omitted} more console messages` }],
    )
  } finally {
    child.removeAllListeners("exit")
    child.kill("SIGKILL")
  }
}

/** A loaded page's height, and its picture at `width`. */
const shoot =
  (width: number, scale = 1) =>
  async (send: Send, sessionId: string, logged: () => ConsoleLine[]): Promise<Captured> => {
    const measured = await send(
      "Runtime.evaluate",
      { expression: MEASURE, returnByValue: true },
      Measured,
      sessionId,
    )
    const contentHeight = Math.max(0, Math.ceil(measured.result.value))
    const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT))
    const shot = await send(
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: capturedHeight, scale },
      },
      Shot,
      sessionId,
    )
    return { png: shot.data, contentHeight, capturedHeight, console: logged() }
  }

const Printed = Schema.Struct({ data: Schema.String })

/** A loaded page printed as a PDF on letter paper, with its print styles and its page size. */
const printPdf = async (send: Send, sessionId: string) => {
  const printed = await send(
    "Page.printToPDF",
    { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false },
    Printed,
    sessionId,
  )
  return Buffer.from(printed.data, "base64")
}

/** Fetches the headless shell for `platform` into `root`, checked by size and SHA-256. */
const install = async (dir: string, root: string, platform: Platform) => {
  const archive = ARCHIVES[platform]
  mkdirSync(dir, { recursive: true })
  const res = await fetch(
    `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-headless-shell-${platform}.zip`,
  )
  if (!res.ok) {
    throw new Error(`The preview browser didn't download (${res.status})`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (bytes.byteLength !== archive.bytes || sha256 !== archive.sha256) {
    throw new Error("The preview browser's download failed its size or SHA-256 check")
  }
  const zip = path.join(dir, `${VERSION}.zip`)
  await Bun.write(zip, bytes)
  // Unpacked beside its place, then moved in, so a half-unpacked one is never taken for it.
  const unpacking = `${root}.unpacking`
  rmSync(unpacking, { recursive: true, force: true })
  const unzip = Bun.spawnSync(["unzip", "-q", "-o", zip, "-d", unpacking])
  rmSync(zip, { force: true })
  if (unzip.exitCode !== 0) {
    throw new Error(`The preview browser didn't unpack: ${unzip.stderr.toString().trim()}`)
  }
  renameSync(unpacking, root)
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface PreviewShape {
  /** A prepared page at `width`, in light or dark. Fails with what went wrong. */
  readonly capture: (input: {
    readonly page: string
    readonly width: number
    readonly appearance: "light" | "dark"
  }) => Effect.Effect<Captured, string>
  /** An HTML page printed as a PDF, in light, as paper is. */
  readonly print: (page: string) => Effect.Effect<Uint8Array, string>
  /** An SVG drawn as a PNG, twice its size, on white. */
  readonly rasterize: (svg: string) => Effect.Effect<Uint8Array, string>
}

// The picture's own box, for a page that's one picture.
const PICTURE_BOX =
  "(() => { const r = document.images[0]?.getBoundingClientRect(); return r ? [r.width, r.height] : [0, 0]; })()"
const Box = Schema.Struct({
  result: Schema.Struct({ value: Schema.Tuple([Schema.Finite, Schema.Finite]) }),
})

const picture = async (send: Send, sessionId: string) => {
  const box = await send(
    "Runtime.evaluate",
    { expression: PICTURE_BOX, returnByValue: true },
    Box,
    sessionId,
  )
  const [width, height] = box.result.value
  if (width < 1 || height < 1) {
    throw new Error("The SVG doesn't draw")
  }
  const shot = await send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 2 },
    },
    Shot,
    sessionId,
  )
  return Buffer.from(shot.data, "base64")
}

const make = (config: { readonly dir: string }): PreviewShape => {
  const platform = PLATFORMS[`${process.platform}-${process.arch}`]
  const root = path.join(config.dir, VERSION)
  let installing: Promise<void> | null = null

  // One fetch at a time; a failed one is tried again by the next call.
  const fetchOnce = async (p: Platform) => {
    try {
      await install(config.dir, root, p)
    } catch (error) {
      installing = null
      throw error
    }
  }

  const executable = async () => {
    if (platform === undefined) {
      throw new Error(`No preview browser for ${process.platform}-${process.arch}`)
    }
    const exe = path.join(root, `chrome-headless-shell-${platform}`, "chrome-headless-shell")
    if (!existsSync(exe)) {
      installing ??= fetchOnce(platform)
      const done = await Promise.race([
        installing.then(() => true),
        Bun.sleep(INSTALL_WAIT_MS).then(() => false),
      ])
      if (!done) {
        throw new Error("The preview browser is still downloading. Try again in a minute.")
      }
    }
    return exe
  }

  /** `page` loaded at `width` in a folder of its own, then `finish`. */
  const loaded = <T>(
    page: string,
    width: number,
    appearance: string,
    finish: Parameters<typeof run<T>>[6],
  ) =>
    Effect.tryPromise({ try: executable, catch: message }).pipe(
      Effect.flatMap((exe) =>
        Effect.tryPromise({
          try: async (signal) => {
            const dir = mkdtempSync(path.join(tmpdir(), "switch-preview-"))
            try {
              const file = path.join(dir, "page.html")
              writeFileSync(file, page)
              return await run(exe, dir, file, width, appearance, signal, finish)
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
          },
          catch: message,
        }).pipe(
          Effect.timeoutOrElse({
            duration: CAPTURE_TIMEOUT,
            orElse: () => Effect.fail(`The page didn't finish loading within ${CAPTURE_TIMEOUT}`),
          }),
        ),
      ),
    )

  return {
    capture: ({ page, width, appearance }) => loaded(page, width, appearance, shoot(width)),
    print: (page) => loaded(page, 816, "light", printPdf),
    rasterize: (svg) =>
      loaded(
        `<!doctype html><html><body style="margin:0;background:#fff"><img style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`,
        1600,
        "light",
        picture,
      ),
  }
}

export class Preview extends Context.Service<Preview, PreviewShape>()("switch/Preview") {
  static readonly layer = (config: { readonly dir: string }) =>
    Layer.sync(Preview, () => make(config))
}
