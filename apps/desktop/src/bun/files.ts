// A chat's files on this Mac: fetched from the core into Downloads (Open, Download, Show in Finder)
// or a cache (Quick Look), once each, never over a file already there. Right-click gives them as a
// native menu. A 3D file opens in Preview, a 3MF as an STL of its build, as Preview opens no 3MF.
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { Subprocess } from "bun"
import { ContextMenu, Utils } from "electrobun/main"
import { Schema } from "effect"

import { FileAsk } from "../shared/commands.ts"
import { nativeHelper } from "./native.ts"
import type { PicturesAsk } from "../shared/commands.ts"
import { threeMfToStl } from "./mesh.ts"

const DOWNLOADS = path.join(homedir(), "Downloads")
const CACHE = path.join(tmpdir(), "switch-files")

const saved = new Map<string, string>()

const free = (dir: string, name: string) => {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let at = path.join(dir, name)
  let n = 1
  while (existsSync(at)) {
    n += 1
    at = path.join(dir, `${stem} ${n}${ext}`)
  }
  return at
}

const plain = (name: string) => path.basename(name).replace(/^\.+/u, "") || "file"

const fetching = new Map<string, Promise<string>>()

/**
 * Fetched into `dir` once; the same file asked again is where it went, or, while it's still coming,
 * the fetch under way: a model of 100 MB can take minutes, and each click again is the same one.
 */
const fetchTo = async (ask: FileAsk, dir: string) => {
  const key = `${dir}\n${ask.url}`
  const had = saved.get(key)
  if (had !== undefined && existsSync(had)) {
    return had
  }
  const coming = fetching.get(key)
  if (coming !== undefined) {
    return await coming
  }
  const fetched = (async () => {
    mkdirSync(dir, { recursive: true })
    const res = await fetch(ask.url)
    if (!res.ok) {
      throw new Error(`Can't fetch ${ask.name}`)
    }
    const at =
      dir === CACHE
        ? path.join(dir, Bun.hash(ask.url).toString(36), plain(ask.name))
        : free(dir, plain(ask.name))
    // Written beside itself and moved in whole, so no half a file is ever opened or kept.
    const part = `${at}.part`
    await Bun.write(part, res)
    renameSync(part, at)
    saved.set(key, at)
    return at
  })().finally(() => {
    fetching.delete(key)
  })
  fetching.set(key, fetched)
  return await fetched
}

const QUICK_LOOK = nativeHelper("switch-quicklook")

let quickLook: Subprocess<"pipe", "ignore", "ignore"> | null = null

/**
 * Files in the Quick Look panel at the one numbered `at`, the arrow keys moving through them. One
 * helper (src/native/quicklook.swift) shows them all for as long as the app runs, with no Dock icon
 * or app switcher entry; a new look replaces what it shows. It exits when the app does: its stdin
 * closes.
 */
const quickLookAt = (files: readonly string[], at: number) => {
  if (QUICK_LOOK === undefined) {
    throw new Error("No Quick Look helper")
  }
  if (quickLook === null || quickLook.exitCode !== null || quickLook.signalCode !== null) {
    quickLook = Bun.spawn([QUICK_LOOK], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  }
  void quickLook.stdin.write(`${JSON.stringify({ files, at })}\n`)
  void quickLook.stdin.flush()
}

const look = async (ask: FileAsk) => {
  quickLookAt([await fetchTo(ask, CACHE)], 0)
}

/** What Preview opens of 3D files (tried on macOS 26: STL and OBJ, not 3MF). */
const PREVIEW_OPENS = new Set([".stl", ".obj"])

const open = async (ask: FileAsk) => {
  const at = await fetchTo(ask, DOWNLOADS)
  const ext = path.extname(at).toLowerCase()
  if (ext === ".3mf") {
    const stl = threeMfToStl(new Uint8Array(await Bun.file(at).arrayBuffer()))
    if (stl !== null) {
      const out = path.join(CACHE, Bun.hash(ask.url).toString(36), `${path.basename(at, ext)}.stl`)
      await Bun.write(out, stl)
      Bun.spawn(["/usr/bin/open", "-a", "Preview", out])
      return
    }
  }
  Bun.spawn(PREVIEW_OPENS.has(ext) ? ["/usr/bin/open", "-a", "Preview", at] : ["/usr/bin/open", at])
}

const run = async (ask: FileAsk) => {
  if (ask.do === "open") {
    await open(ask)
  } else if (ask.do === "look") {
    await look(ask)
  } else if (ask.do === "show") {
    Utils.showItemInFolder(await fetchTo(ask, DOWNLOADS))
  } else if (ask.do === "download") {
    await fetchTo(ask, DOWNLOADS)
  } else {
    ContextMenu.showContextMenu([
      { label: "Open", action: JSON.stringify({ ...ask, do: "open" }) },
      { label: "Quick Look", action: JSON.stringify({ ...ask, do: "look" }) },
      { label: "Show in Finder", action: JSON.stringify({ ...ask, do: "show" }) },
      { label: "Download", action: JSON.stringify({ ...ask, do: "download" }) },
    ])
  }
}

/** A gallery's pictures in Quick Look, in their order, at the one clicked. */
export const onPictures = async (ask: PicturesAsk) => {
  try {
    const files = await Promise.all(
      ask.pictures.map(async (p) => await fetchTo({ ...p, do: "look" }, CACHE)),
    )
    quickLookAt(files, ask.at)
  } catch (error) {
    console.warn("Pictures", error)
  }
}

/** Runs a file's ask; true once it's done, false when it couldn't be. */
export const onFile = async (ask: FileAsk) =>
  await run(ask)
    .then(() => true)
    .catch((error: unknown) => {
      console.warn("File", ask.name, error)
      return false
    })

// The item's action is the ask, as JSON: Electrobun sends an item's `data` only on its first click.
const decode = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Struct({ action: Schema.fromJsonString(FileAsk) }) }),
)

ContextMenu.on("context-menu-clicked", (e) => {
  const chosen = decode(e)
  if (chosen._tag === "Some") {
    void onFile(chosen.value.data.action)
  }
})
