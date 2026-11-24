// The Contacts app: one window over the contacts extension, reached through the core as a client.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import Electrobun, { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/main"
import { Option, Schema } from "effect"

import type { AppRPC, Command } from "../shared/commands.ts"
import { menuBar } from "./menu.ts"
import { dialCore, saw } from "./extension.ts"

const settings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ core: Schema.optionalKey(Schema.String) })),
)

/** The core: $SWITCH_CORE, else the one this machine's host reports to, else this machine's. */
const coreUrl = () => {
  const given = process.env.SWITCH_CORE
  if (given !== undefined && given !== "") {
    return given
  }
  const file = process.env.SWITCH_CONFIG ?? path.join(homedir(), ".switch", "config.json")
  const read = existsSync(file) ? settings(readFileSync(file, "utf-8")) : Option.none()
  return Option.getOrUndefined(read)?.core ?? "http://127.0.0.1:4871"
}

const CORE = coreUrl()

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

const devServer = process.env.CONTACTS_VIEW ?? "http://localhost:5183"

const viewUrl = async () => {
  const query = `?core=${encodeURIComponent(CORE)}`
  if ((await Updater.localInfo.channel()) === "dev") {
    const up = await fetch(devServer, { method: "HEAD" })
      .then(() => true)
      .catch(() => false)
    if (up) {
      return `${devServer}/${query}`
    }
  }
  if (VIEWS === undefined) {
    return `views://mainview/index.html${query}`
  }
  return `http://127.0.0.1:${serveViews(VIEWS).port}/index.html${query}`
}

const rpc = BrowserView.defineRPC<AppRPC>({
  maxRequestTime: 5000,
  handlers: {
    messages: {
      seen: saw,
      left: saw,
    },
  },
})

const win = new BrowserWindow({
  title: "Contacts",
  url: await viewUrl(),
  frame: { width: 1120, height: 760, x: 200, y: 140 },
  // The band is the titlebar: the window's buttons sit in it.
  titleBarStyle: "hiddenInset",
  rpc,
})

const send = (c: Command) => {
  rpc.send.command(c)
}

menuBar(send)
dialCore({ win, send, shown: async () => await rpc.request.shown({}) }, CORE)

const urlOf = (detail: unknown): string => {
  if (typeof detail === "string") {
    return detail
  }
  if (typeof detail === "object" && detail !== null && "url" in detail) {
    return String(detail.url)
  }
  return ""
}

// A link (a source's page, a card in Contacts, an email) opens in the browser or mail, not in the window.
Electrobun.events.on("new-window-open", (e: { readonly data: { readonly detail: unknown } }) => {
  const url = urlOf(e.data.detail)
  if (/^(?:https?|mailto|tel|sms|addressbook):/u.test(url)) {
    Utils.openExternal(url)
  }
})
