// Protected folders, ported from Switchboard's tcc-guard (protected.rs): whether a command here can
// touch a path macOS privacy (TCC) guards, before it hangs on a prompt nobody answers. Each path is
// probed in a child killed after its time, so the check never hangs; or, `live` off, decided from
// the grants alone. Grants are read from the privacy databases, which open only with Full Disk
// Access; they're the host app's (ax.switch.host, or $SWITCH_HOST_BUNDLE).
import { Database } from "bun:sqlite"
import { existsSync, lstatSync, openSync, closeSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const SERVICES: Record<string, string> = {
  kTCCServiceSystemPolicyAllFiles: "fullDiskAccess",
  kTCCServiceAccessibility: "accessibility",
  kTCCServiceScreenCapture: "screenRecording",
  kTCCServiceListenEvent: "inputMonitoring",
  kTCCServiceSystemPolicyDesktopFolder: "desktop",
  kTCCServiceSystemPolicyDocumentsFolder: "documents",
  kTCCServiceSystemPolicyDownloadsFolder: "downloads",
  kTCCServiceSystemPolicyRemovableVolumes: "removableVolumes",
  kTCCServiceSystemPolicyNetworkVolumes: "networkVolumes",
  kTCCServiceSystemPolicyAppData: "otherAppsData",
}

/** Folders privacy guards (under home unless absolute), and the grant besides Full Disk Access. */
const GUARDED: readonly (readonly [string, string | null])[] = [
  ["Desktop", "desktop"],
  ["Documents", "documents"],
  ["Downloads", "downloads"],
  ["Library/Mobile Documents", null],
  ["Library/CloudStorage", null],
  ["Library/Mail", null],
  ["Library/Messages", null],
  ["Library/Safari", null],
  ["Library/Cookies", null],
  ["Library/Calendars", null],
  ["Library/HomeKit", null],
  ["Library/Suggestions", null],
  ["Library/Containers", "otherAppsData"],
  ["Library/Group Containers", "otherAppsData"],
  ["Library/Application Support/com.apple.TCC", null],
  ["Library/Application Support/AddressBook", null],
  ["Library/Metadata/CoreSpotlight", null],
  ["Pictures/Photos Library.photoslibrary", null],
  ["/Volumes", "removableVolumes"],
  ["/Library/Application Support/com.apple.TCC", null],
]

const USER_DB = path.join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db")

const readable = () => {
  try {
    closeSync(openSync(USER_DB, "r"))
    return true
  } catch {
    return false
  }
}

/** The host app's grants: Full Disk Access, and with it every other one it's been given. */
export const grants = (): Record<string, boolean> => {
  if (!readable()) {
    return { fullDiskAccess: false }
  }
  const client = process.env.SWITCH_HOST_BUNDLE ?? "ax.switch.host"
  const out: Record<string, boolean> = {}
  for (const file of [USER_DB, "/Library/Application Support/com.apple.TCC/TCC.db"]) {
    try {
      const db = new Database(file, { readonly: true })
      const rows = db
        .query<{ service: string; auth_value: number }, [string]>(
          "SELECT service, auth_value FROM access WHERE client = ?",
        )
        .all(client)
      db.close()
      for (const r of rows) {
        const name = SERVICES[r.service]
        if (name !== undefined) {
          out[name] = (out[name] ?? false) || r.auth_value === 2
        }
      }
    } catch {
      // The system database opens only with Full Disk Access too.
    }
  }
  return { ...out, fullDiskAccess: true }
}

const expand = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

const guardOf = (p: string) => {
  let real = expand(p)
  try {
    real = realpathSync(real)
  } catch {
    // Not there yet: its own path.
  }
  for (const [folder, grant] of GUARDED) {
    const full = folder.startsWith("/") ? folder : path.join(homedir(), folder)
    if (real === full || real.startsWith(`${full}/`)) {
      return { folder: full, grant }
    }
  }
  return null
}

const probe = async (p: string, timeoutMs: number) => {
  try {
    lstatSync(p)
  } catch {
    return { result: "missing", ms: null }
  }
  const dir = existsSync(p) && statSync(p).isDirectory()
  const started = Date.now()
  const child = Bun.spawn(dir ? ["/bin/ls", "-1A", p] : ["/usr/bin/head", "-c", "1", p], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
  }, timeoutMs)
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()])
  clearTimeout(timer)
  const ms = Date.now() - started
  if (child.signalCode === "SIGKILL") {
    return { result: "timeout", ms: null }
  }
  if (code === 0) {
    return { result: "ok", ms }
  }
  return {
    result: err.includes("not permitted") ? "denied" : `error: ${err.trim().slice(0, 200)}`,
    ms,
  }
}

/** What a probe's result says: the verdict, and why when it isn't plain. */
const verdictOf = (result: string, guarded: boolean) => {
  if (result === "ok" || result === "missing") {
    return { verdict: result }
  }
  if (result === "timeout") {
    return {
      verdict: "blocked",
      why: guarded ? "Held by a privacy prompt" : "It hung: a FIFO or a stalled mount",
    }
  }
  if (result === "denied") {
    return { verdict: "blocked", why: "Privacy refused it" }
  }
  return { verdict: "error", why: result }
}

export const check = async (
  p: string,
  timeoutMs: number,
  live: boolean,
  held: Record<string, boolean>,
) => {
  const guarded = guardOf(p)
  const grant = guarded?.grant ?? null
  const known = held.fullDiskAccess === true || (grant !== null && held[grant] === true)
  const fix =
    guarded === null
      ? undefined
      : `Full Disk Access for Switch Host${grant === null ? "" : `, or its ${grant} grant`}`
  const base = { path: p, protectedBy: guarded?.folder ?? null, grant }
  if (guarded !== null && !known && !live) {
    return { ...base, verdict: "blocked", why: "Guarded, with no grant that opens it", fix }
  }
  const { result, ms } = await probe(expand(p), timeoutMs)
  const v = verdictOf(result, guarded !== null)
  return { ...base, ...v, probeMs: ms, ...(v.verdict === "blocked" ? { fix } : {}) }
}
