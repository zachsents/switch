// What's this Mac's own, not the user's everywhere: launching at login (a LaunchAgent that opens the
// app) and whether updates go in by themselves (a file beside the app's other state).
import { existsSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"

import type { Local } from "../shared/commands.ts"

/** The app bundle this runs from: …/Name.app/Contents/MacOS/bun. */
const bundle = () => {
  const at = process.execPath.indexOf(".app/")
  return at === -1 ? null : process.execPath.slice(0, at + 4)
}

const app = bundle()
const metadata =
  app === null
    ? null
    : Bun.spawnSync([
        "/usr/bin/plutil",
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        path.join(app, "Contents", "Info.plist"),
      ])
export const ID = metadata?.exitCode === 0 ? metadata.stdout.toString().trim() : "switch.local.dev"
const LABEL = `${ID}.login`
const DOMAIN = `gui/${process.getuid?.()}`
const AGENT = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const FILE = path.join(homedir(), "Library", "Application Support", ID, "local.json")
const registered = () =>
  Bun.spawnSync(["/bin/launchctl", "print", `${DOMAIN}/${LABEL}`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const launch = (args: string[]) => {
  const result = Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "ignore", stderr: "ignore" })
  if (result.exitCode !== 0) {
    throw new Error(
      `macOS login registration failed (${result.exitCode}). Try again in General settings.`,
    )
  }
}

const read = (): { autoUpdate: boolean } => {
  try {
    const raw: unknown = JSON.parse(readFileSync(FILE, "utf-8"))
    return {
      autoUpdate: !(
        typeof raw === "object" &&
        raw !== null &&
        "autoUpdate" in raw &&
        raw.autoUpdate === false
      ),
    }
  } catch {
    return { autoUpdate: true }
  }
}

export const local = (): Local => ({ login: existsSync(AGENT) && registered(), ...read() })

/** Sets what's given; what isn't stays. */
export const setLocal = (ask: { readonly login?: boolean; readonly autoUpdate?: boolean }) => {
  try {
    if (ask.login === true) {
      if (app === null || metadata?.exitCode !== 0) {
        throw new Error("Launch at login requires an installed app bundle.")
      }
      if (!registered()) {
        writeFileAtomic(
          AGENT,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(LABEL)}</string>
<key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>${xml(app)}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`,
        )
        launch(["enable", `${DOMAIN}/${LABEL}`])
        launch(["bootstrap", DOMAIN, AGENT])
        if (!registered()) {
          throw new Error("macOS did not register the login item. Try again in General settings.")
        }
      }
    } else if (ask.login === false) {
      if (registered()) {
        launch(["bootout", `${DOMAIN}/${LABEL}`])
      }
      rmSync(AGENT, { force: true })
    }
    if (ask.autoUpdate !== undefined) {
      writeFileAtomic(FILE, JSON.stringify({ autoUpdate: ask.autoUpdate }))
    }
    return local()
  } catch (error) {
    return {
      ...local(),
      error:
        error instanceof Error ? error.message : "Could not save this Mac's settings. Try again.",
    }
  }
}
