// Ghostty through its AppleScript dictionary (Ghostty 1.3+; `sdef /Applications/Ghostty.app`):
// windows, tabs and terminals, `new surface configuration` (working directory, initial input),
// `new window`, `new tab`, `split`, `input text`, `send key`, `focus`. The dictionary has no way to
// read what a terminal shows, so neither has this. Each script takes its values as `argv`, never
// spliced into its text. macOS asks the user once whether Switch may control Ghostty (Automation).
import { Effect } from "effect"

/** Ghostty's bundle id. */
const BUNDLE = "com.mitchellh.ghostty"
/** The first version with the dictionary. */
const FIRST = { major: 1, minor: 3 }

/** A field and line apart, in what a script prints. */
const FS = "\u001F"
const RS = "\u001E"

const run = (argv: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { out: out.replace(/\n$/u, ""), err: err.trim(), code }
    },
    catch: String,
  })

/** Where Ghostty is installed, and its version; null when it isn't. */
export const installed = Effect.gen(function* finding() {
  const found = yield* run(["mdfind", `kMDItemCFBundleIdentifier == '${BUNDLE}'`])
  const home = process.env.HOME ?? ""
  const paths = [
    ...found.out.split("\n").filter((p) => p.endsWith(".app")),
    "/Applications/Ghostty.app",
    `${home}/Applications/Ghostty.app`,
  ]
  for (const app of paths) {
    const v = yield* run([
      "/usr/bin/defaults",
      "read",
      `${app}/Contents/Info.plist`,
      "CFBundleShortVersionString",
    ])
    if (v.code === 0 && v.out !== "") {
      return { app, version: v.out }
    }
  }
  return null
})

/** Whether a version has the dictionary. */
export const scriptable = (version: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > FIRST.major || (major === FIRST.major && minor >= FIRST.minor)
}

/** Automation turned down: what to tell. */
export const DENIED =
  "Switch may not control Ghostty: allow it in System Settings › Privacy & Security › Automation"

/** Runs an AppleScript with its values: what it printed, or why it failed. */
const script = (text: string, argv: readonly string[]) =>
  Effect.flatMap(run(["/usr/bin/osascript", "-e", text, "--", ...argv]), (r) => {
    if (r.code === 0) {
      return Effect.succeed(r.out)
    }
    // -1743: not authorized to send Apple events; -1744: the user would be asked, and wasn't.
    if (r.err.includes("-1743") || r.err.includes("-1744")) {
      return Effect.fail(DENIED)
    }
    return Effect.fail(r.err.replace(/^\d+:\d+: execution error: /u, "") || `osascript ${r.code}`)
  })

export type Place = "window" | "tab" | "split"
export type Direction = "right" | "left" | "down" | "up"

export interface Open {
  readonly place: Place
  /** Typed at the prompt; with `run`, run. */
  readonly command?: string | undefined
  readonly run?: boolean | undefined
  readonly cwd?: string | undefined
  /** A tab's window, by id (the front one by default). */
  readonly window?: string | undefined
  /** A split's terminal, by id (the front window's focused one by default). */
  readonly terminal?: string | undefined
  readonly direction?: Direction | undefined
}

const OPEN = `on run argv
  set {place, dir, input, winId, termId, dirName} to argv
  tell application id "${BUNDLE}"
    set cfg to new surface configuration
    if dir is not "" then set initial working directory of cfg to dir
    if input is not "" then set initial input of cfg to input
    if place is "window" or (count windows) is 0 then
      set w to new window with configuration cfg
      set t to focused terminal of selected tab of w
    else if place is "tab" then
      if winId is "" then
        set w to front window
      else
        set w to first window whose id is winId
      end if
      set tb to new tab in w with configuration cfg
      set t to focused terminal of tb
    else
      if termId is "" then
        set base to focused terminal of selected tab of front window
      else
        set base to first terminal whose id is termId
      end if
      if dirName is "left" then
        set t to split base direction left with configuration cfg
      else if dirName is "down" then
        set t to split base direction down with configuration cfg
      else if dirName is "up" then
        set t to split base direction up with configuration cfg
      else
        set t to split base direction right with configuration cfg
      end if
    end if
    focus t
    activate
    return id of t
  end tell
end run`

/**
 * Typed first: what's typed before the shell reads it is echoed above the login line, so ⌃L, read
 * by the shell's line editor as its first key, clears that away before the command.
 */
const CLEAR = "\u000C"

/** A home-relative folder as the terminal takes it: whole. */
const expand = (dir: string) => {
  const home = process.env.HOME ?? ""
  if (dir === "~") {
    return home
  }
  return dir.startsWith("~/") ? `${home}${dir.slice(1)}` : dir
}

/** A window, tab or split with a command typed (and run, with `run`), in front: its terminal's id. */
export const open = (o: Open) =>
  Effect.map(
    script(OPEN, [
      o.place,
      o.cwd === undefined ? "" : expand(o.cwd),
      o.command === undefined ? "" : `${CLEAR}${o.command}${o.run === true ? "\n" : ""}`,
      o.window ?? "",
      o.terminal ?? "",
      o.direction ?? "right",
    ]),
    (terminal) => ({ terminal }),
  )

const TYPE = `on run argv
  set {termId, typed, enter} to argv
  tell application id "${BUNDLE}"
    set t to first terminal whose id is termId
    if typed is not "" then input text typed to t
    if enter is "1" then send key "enter" to t
  end tell
end run`

/** Text into a terminal, as pasted, then ↵ with `enter`. */
export const type = (terminal: string, text: string, enter: boolean) =>
  script(TYPE, [terminal, text, enter ? "1" : "0"])

const LIST = `on run argv
  set FS to ASCII character 31
  set RS to ASCII character 30
  set out to ""
  if not (application id "${BUNDLE}" is running) then return out
  tell application id "${BUNDLE}"
    repeat with w in windows
      set out to out & "w" & FS & (id of w) & FS & (name of w) & RS
      repeat with tb in tabs of w
        set focusedId to id of focused terminal of tb
        set out to out & "t" & FS & (id of tb) & FS & (name of tb) & FS & (index of tb) & FS & (selected of tb) & RS
        repeat with t in terminals of tb
          set out to out & "s" & FS & (id of t) & FS & (name of t) & FS & (working directory of t) & FS & ((id of t) is focusedId) & RS
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run`

export interface Terminal {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly focused: boolean
}
export interface Tab {
  readonly id: string
  readonly title: string
  readonly index: number
  readonly selected: boolean
  readonly terminals: Terminal[]
}
export interface Window {
  readonly id: string
  readonly title: string
  readonly tabs: Tab[]
}

/** Every window, its tabs and their terminals, front window first. */
export const list = Effect.map(script(LIST, []), (out) => {
  const windows: Window[] = []
  for (const line of out.split(RS)) {
    const [kind, id = "", title = "", a = "", b = ""] = line.split(FS)
    if (kind === "w") {
      windows.push({ id, title, tabs: [] })
    }
    const tabs = windows.at(-1)?.tabs
    if (kind === "t" && tabs) {
      tabs.push({ id, title, index: Number(a), selected: b === "true", terminals: [] })
    }
    const terminals = tabs?.at(-1)?.terminals
    if (kind === "s" && terminals) {
      terminals.push({ id, title, cwd: a, focused: b === "true" })
    }
  }
  return windows
})
