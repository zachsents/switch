// Import and export, both on this Mac. An import reads another manager's file here with the
// extension's own parsers (src/imports.ts), shows what it would add, and on confirm seals each item
// here. An export opens every item here, after the check, and writes the file the user picks.
import { writeFileSync } from "node:fs"
import { Utils } from "electrobun/main"

import { counts, read } from "../../src/imports.ts"
import type { Source } from "../../src/imports.ts"
import type { Draft, Item } from "../../src/model.ts"
import type { Preview } from "../shared/rpc.ts"
import { add, exportAll, find, items } from "./vault.ts"

let pending: { readonly source: Source; readonly drafts: readonly Draft[] } | null = null

export const pickImport = async () => {
  const [file] = await Utils.openFileDialog({
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
    allowedFileTypes: "csv,json",
  })
  return file ?? null
}

const username = (fields: readonly { id: string; value: string }[]) =>
  fields.find((f) => f.id === "username")?.value ?? ""

/** What the file would add: drafts already in the vault by title and username are left out. */
export const previewImport = async (source: Source, file: string): Promise<Preview> => {
  const all = read(source, await Bun.file(file).text())
  const have = new Set(items().map((i) => `${i.title}\0${username(i.fields)}`))
  const drafts = all.filter((d) => !have.has(`${d.title}\0${username(d.fields)}`))
  pending = { source, drafts }
  return {
    file,
    total: drafts.length,
    kinds: Object.entries(counts(drafts)).map(([kind, count]) => ({ kind, count: count ?? 0 })),
    skipped: all.length - drafts.length,
  }
}

/** Adds what was previewed; how many. */
export const confirmImport = async () => {
  if (!pending) {
    throw new Error("Nothing to import")
  }
  const { source, drafts } = pending
  pending = null
  await add(
    drafts.map((d) => ({
      kind: d.kind,
      title: d.title,
      // A name the file gives, unless it's taken; else one from the title.
      name: d.name !== undefined && !find(d.name) ? d.name : "",
      fields: d.fields,
      urls: d.urls ?? [],
      notes: d.notes ?? "",
      tags: d.tags ?? [],
      folder: d.folder ?? "",
      spaces: [],
      favorite: false,
    })),
    `import:${source}`,
  )
  return drafts.length
}

/** The save panel, from AppleScript: Electrobun has none. */
const pickSave = async (name: string) => {
  const proc = Bun.spawn(
    [
      "osascript",
      "-e",
      "tell me to activate",
      "-e",
      `POSIX path of (choose file name with prompt "Export" default name "${name}")`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  return code === 0 ? out.trim() : null
}

const cell = (text: string) => (/[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text)

const MAIN = new Set(["username", "password", "totp"])

const csvOf = (all: readonly Item[]) => {
  const head = [
    "title",
    "kind",
    "name",
    "url",
    "username",
    "password",
    "otp",
    "notes",
    "folder",
    "tags",
    "fields",
  ]
  const rows = all.map((i) => {
    const value = (id: string) => i.fields.find((f) => f.id === id)?.value ?? ""
    const rest = i.fields.filter((f) => !MAIN.has(f.id))
    return [
      i.title,
      i.kind,
      i.name,
      i.urls.map((u) => u.url).join(" "),
      value("username"),
      value("password"),
      value("totp"),
      i.notes,
      i.folder,
      i.tags.join(","),
      rest.length > 0 ? JSON.stringify(rest) : "",
    ]
  })
  return `${[head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`
}

/** Writes every item, in the clear, where the user picks; the file's path, or null if they didn't. */
export const exportTo = async (format: "csv" | "json") => {
  const file = await pickSave(`secrets.${format}`)
  if (file === null) {
    return null
  }
  const all = await exportAll("export your secrets")
  const text = format === "json" ? JSON.stringify(all, null, 2) : csvOf(all)
  writeFileSync(file, text, { mode: 0o600 })
  return file
}
