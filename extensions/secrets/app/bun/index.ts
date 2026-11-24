// The Secrets app: one window over the vault.
// This process is the vault's device: it holds the keys and opens items, the views ask it.
import { existsSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import Electrobun, { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/main"

import { generate } from "../../src/values.ts"
import { Command } from "../shared/rpc.ts"
import type { AppRPC } from "../shared/rpc.ts"
import { watchChanges } from "./core.ts"
import { onHelper } from "./helper.ts"
import { menuBar } from "./menu.ts"
import { confirmImport, exportTo, pickImport, previewImport } from "./transfer.ts"
import * as vault from "./vault.ts"

const dev = (await Updater.localInfo.channel()) === "dev"
// Testing on a Mac where nobody can pass Touch ID or its password: a dev build only.
if (dev && process.env.SECRETS_SKIP_CHECKS === "1") {
  vault.skipChecksInDev()
}

/** Where the built view sits in the app bundle: Resources/app/views/mainview. */
const VIEWS = [
  path.resolve(import.meta.dir, "..", "views", "mainview"),
  path.resolve(process.cwd(), "..", "Resources", "app", "views", "mainview"),
].find((dir) => existsSync(path.join(dir, "index.html")))

/** The built view, over http on this machine only, so the page has a real origin. */
const serveViews = (dir: string) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url)
      const file = path.resolve(
        dir,
        `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`,
      )
      if (!file.startsWith(dir + path.sep) || !existsSync(file)) {
        return new Response("Not found", { status: 404 })
      }
      return new Response(Bun.file(file))
    },
  })

const devServer = process.env.SECRETS_VIEW ?? "http://localhost:5184"

const viewBase = async () => {
  if (dev) {
    const up = await fetch(devServer, { method: "HEAD" })
      .then(() => true)
      .catch(() => false)
    if (up) {
      return `${devServer}/`
    }
  }
  if (VIEWS === undefined) {
    return "views://mainview/index.html"
  }
  return `http://127.0.0.1:${serveViews(VIEWS).port}/index.html`
}

const BASE = await viewBase()

type Rpc = ReturnType<typeof makeRpc>
const views = new Set<Rpc>()

const changed = () => {
  for (const v of views) {
    v.send.changed({})
  }
}

const status = () => vault.currentStatus()

type Asked = AppRPC["bun"]["requests"]
type Answers = {
  readonly [K in keyof Asked]: (
    params: Asked[K]["params"],
  ) => Asked[K]["response"] | Promise<Asked[K]["response"]>
}

/** What the views ask, answered from the vault. */
const requests: Answers = {
  status,
  unlock: async () => {
    await vault.unlock()
    return status()
  },
  lock: () => {
    vault.lock()
    return status()
  },
  retry: async () => {
    await vault.retry()
    return status()
  },
  items: vault.items,
  item: ({ id }) => vault.itemOf(id),
  reveal: async ({ id, field, at }) => await vault.reveal(id, field, at),
  copy: async ({ id, field, at }) => {
    await vault.copy(id, field, at)
    return null
  },
  copyText: async ({ text }) => {
    await vault.copyText(text)
    return null
  },
  code: ({ id, field }) => vault.code(id, field),
  history: async ({ id }) => await vault.history(id),
  restore: async ({ id, at, field }) => {
    await vault.restore(id, at, field)
    return null
  },
  save: async ({ draft }) => await vault.save(draft),
  generate: (g) => generate(g),
  trash: async ({ id, restore }) => {
    await vault.trash(id, restore)
    return null
  },
  purge: async ({ id }) => {
    await vault.purge(id)
    return null
  },
  audit: async ({ item }) => await vault.audit(item),
  members: vault.members,
  approveDevice: async ({ id }) => {
    await vault.approveDevice(id)
    return null
  },
  revokeDevice: async ({ id }) => {
    await vault.revokeDevice(id)
    return null
  },
  approveExtension: async ({ name }) => {
    await vault.approveExtension(name)
    return null
  },
  revokeExtension: async ({ name }) => {
    await vault.revokeExtension(name)
    return null
  },
  grant: async ({ op, grant }) => {
    await vault.grant(op, grant)
    return null
  },
  importPick: pickImport,
  importPreview: async ({ source, file }) => await previewImport(source, file),
  importConfirm: confirmImport,
  export: async ({ format }) => await exportTo(format),
  openUrl: ({ url }) => {
    if (/^https?:\/\//u.test(url)) {
      Utils.openExternal(url)
    }
    return null
  },
}

const makeRpc = () =>
  BrowserView.defineRPC<AppRPC>({
    maxRequestTime: 120_000,
    handlers: { requests, messages: {} },
  })

let mainRpc: Rpc

/** The window; closing it leaves the app running, and the Dock brings it back. */
const makeMain = () => {
  const rpc = makeRpc()
  const win = new BrowserWindow({
    title: "Secrets",
    url: BASE,
    frame: { width: 1180, height: 780, x: 180, y: 120 },
    // The band is the titlebar: the window's buttons sit in it.
    titleBarStyle: "hiddenInset",
    rpc,
  })
  views.add(rpc)
  win.on("close", () => {
    views.delete(rpc)
    mainOpen = false
  })
  mainRpc = rpc
  mainOpen = true
  return win
}

let mainOpen = false
let mainWin = makeMain()

const send = (c: Command) => {
  if (!mainOpen) {
    mainWin = makeMain()
  }
  mainRpc.send.command(c)
}

Electrobun.events.on("reopen", () => {
  if (mainOpen) {
    mainWin.show()
  } else {
    mainWin = makeMain()
  }
})

menuBar(send)

vault.onChange(changed)

// Testing where nobody can click (a Mac reached over ssh): a dev build only, on this Mac only,
// answers what the views ask (POST /<request>) and takes their commands (POST /command).
const devPort = process.env.SECRETS_DEV_PORT
if (dev && devPort !== undefined && devPort !== "") {
  Bun.serve({
    hostname: "127.0.0.1",
    port: Number(devPort),
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1)
      const body: unknown = await request.json().catch(() => ({}))
      if (name === "command") {
        send(Schema.decodeUnknownSync(Command)(body))
        return Response.json(null)
      }
      const handler = Object.entries(requests).find(([key]) => key === name)?.[1]
      if (!handler) {
        return new Response("No such request", { status: 404 })
      }
      // Test-only, from this Mac's own shell: the body is taken as that request's params.
      const answer: unknown = await Reflect.apply(handler, undefined, [body])
      return Response.json(answer)
    },
  })
}
onHelper((e) => {
  if (e.event === "lock" || e.event === "idle") {
    vault.lock()
  }
})

watchChanges(() => {
  void vault.sync()
})
await vault.start()
// While it waits to be approved, ask again every few seconds; after, once a minute.
setInterval(() => {
  const { stage } = vault.currentStatus()
  if (stage === "pending" || stage === "failed") {
    void (stage === "failed" ? vault.retry() : vault.sync())
  }
}, 3000)
setInterval(() => {
  void vault.sync()
}, 60_000)

// A link opens in the browser, not in the window.
Electrobun.events.on("new-window-open", (e: { readonly data: { readonly detail: unknown } }) => {
  const { detail } = e.data
  const url =
    typeof detail === "object" && detail !== null && "url" in detail
      ? String(detail.url)
      : String(detail)
  if (/^https?:/u.test(url)) {
    Utils.openExternal(url)
  }
})
