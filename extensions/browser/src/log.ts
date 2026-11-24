// What a tab's debugger reports, kept as it arrives: the document's generation and loading, its
// console, its requests, and the dialogs and file pickers it opened.
import type { Json } from "./chrome.ts"

const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : null)

export interface Request {
  readonly id: string
  readonly method: string
  readonly url: string
  readonly kind: string | null
  status: number | null
  mime: string | null
  bytes: number | null
  failed: string | null
}

/** What the tab's debugger reported, as it arrives. */
export class Log {
  /** Bumped whenever the document (or the debugger session) changes, so the page script goes in again. */
  generation = 0
  mainFrame: string | null = null
  /** Since when the main frame has been loading a new document, until its DOM is in. */
  loadingSince: number | null = null
  /** When the main frame last stopped loading. */
  stopped: number | null = null
  console: string[] = []
  network: Request[] = []
  /** Document, XHR and fetch requests not finished yet, with when they started. */
  inflight = new Map<string, number>()
  /** A JavaScript dialog waiting for an answer (it blocks the page's scripts). */
  dialog: Json | null = null
  /** A file picker the page opened, held back. */
  chooser: Json | null = null
  /** The session moved to a tab the page opened. */
  moved = false

  apply(method: string, params: Json) {
    const text = (name: string) => str(params[name])
    const main = () => this.mainFrame === null || this.mainFrame === text("frameId")
    if (
      method === "Page.frameNavigated" &&
      (params.parentId === undefined || params.parentId === null)
    ) {
      this.mainFrame = text("frameId")
      this.generation += 1
    } else if (
      method === "Runtime.executionContextsCleared" ||
      method === "detached" ||
      method === "Inspector.targetCrashed"
    ) {
      this.generation += 1
      this.inflight.clear()
      this.loadingSince = null
      if (method === "Inspector.targetCrashed") {
        this.console.push("[crash] the page crashed")
      }
    } else if (method === "moved") {
      this.generation += 1
      this.mainFrame = null
      this.inflight.clear()
      this.moved = true
    } else if (method === "Page.frameStartedLoading" && main()) {
      this.loadingSince = Date.now()
    } else if (method === "Page.frameStoppedLoading" && main()) {
      this.loadingSince = null
      this.stopped = Date.now()
    } else if (method === "Page.domContentEventFired" || method === "Page.loadEventFired") {
      this.loadingSince = null
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = params
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null
    } else if (method === "Page.fileChooserOpened") {
      this.chooser = params
    } else if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
      const args = Array.isArray(params.args) ? params.args : []
      const line =
        method === "Runtime.exceptionThrown"
          ? `[exception] ${text("text")}`
          : `[${text("type") || "log"}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`
      this.console.push(line.slice(0, 600))
      this.console.splice(0, Math.max(0, this.console.length - 300))
    } else if (method === "Network.requestWillBeSent") {
      const id = text("requestId")
      const kind = text("type") || null
      if (kind === "Document" || kind === "XHR" || kind === "Fetch") {
        this.inflight.set(id, Date.now())
      }
      this.network.push({
        id,
        method: text("method"),
        url: text("url"),
        kind,
        status: null,
        mime: null,
        bytes: null,
        failed: null,
      })
      this.network.splice(0, Math.max(0, this.network.length - 500))
    } else if (
      method === "Network.responseReceived" ||
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      const id = text("requestId")
      if (method !== "Network.responseReceived") {
        this.inflight.delete(id)
      }
      const request = this.network.findLast((r) => r.id === id)
      if (request) {
        if (method === "Network.responseReceived") {
          request.status = num(params.status)
          request.mime = text("mimeType") || null
        } else if (method === "Network.loadingFinished") {
          request.bytes = num(params.bytes)
        } else {
          request.failed = text("error") || null
        }
      }
    }
  }
}
