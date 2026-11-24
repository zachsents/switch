// These services belong to every window, including Settings, not just the menu's main view.
import { Utils } from "electrobun/main"

import type { Local, PicturesAsk, Update } from "../shared/commands.ts"
import { onPictures } from "./files.ts"
import { setLocal } from "./local.ts"
import { answer } from "./update.ts"

export interface WindowSender {
  readonly local: (value: Local) => void
  readonly update: (value: Update) => void
}

const clients = new Set<WindowSender>()

export const registerWindowState = (send: WindowSender) => {
  clients.add(send)
  return () => {
    clients.delete(send)
  }
}

export const windowMessages = (send: () => WindowSender, zoom: (factor: number) => void) => ({
  local: (ask: { readonly login?: boolean; readonly autoUpdate?: boolean }) => {
    const value = setLocal(ask)
    for (const client of clients) {
      client.local(value)
    }
  },
  update: (ask: { readonly apply: boolean }) => {
    answer(ask, send().update)
  },
  zoom: (ask: { readonly factor: number }) => {
    zoom(ask.factor)
  },
  copy: (text: string) => {
    Utils.clipboardWriteText(text)
  },
  pictures: (ask: PicturesAsk) => {
    void onPictures(ask)
  },
})
