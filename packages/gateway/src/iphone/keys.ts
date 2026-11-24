// Where the iPhone extension's secrets are: the APNs key (push.json: key, key_id, team_id) and the
// Pass Type ID's certificate (pass.pem, pass.key, wwdr.pem). Switch's own folder first, else
// Switchboard's, so the keys it already has carry over without a copy. Never logged, never in the
// log.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const SWITCHBOARD = path.join(homedir(), "Library", "Application Support", "Switchboard")

const first = (paths: readonly string[]) => paths.find((p) => existsSync(p)) ?? null

const SWITCH = process.env.SWITCH_DIR ?? path.join(homedir(), ".switch")

/** The APNs key file, if there is one; none while `push-hold` is in Switch's folder. */
export const pushKeyFile = (dir: string) =>
  existsSync(path.join(SWITCH, "push-hold"))
    ? null
    : first([path.join(dir, "push.json"), path.join(SWITCHBOARD, "core", "push.json")])

export interface WalletFiles {
  readonly cert: string
  readonly key: string
  readonly wwdr: string
}

/** The pass certificate, its key and Apple's WWDR intermediate, if all three are here. */
export const walletFiles = (dir: string): WalletFiles | null => {
  const folder = first(
    [
      path.join(dir, "wallet"),
      process.env.WALLET_SECRETS ?? "",
      path.join(SWITCHBOARD, "appendages-secrets", "wallet"),
      path.join(homedir(), ".local", "share", "Switchboard", "appendages-secrets", "wallet"),
    ].filter((p) => p !== ""),
  )
  if (folder === null) {
    return null
  }
  const cert = path.join(folder, "pass.pem")
  const key = path.join(folder, "pass.key")
  const wwdr = first([
    path.join(folder, "wwdr.pem"),
    path.join(SWITCHBOARD, "appendages", "wallet", "code", "wwdr-g4.pem"),
  ])
  return existsSync(cert) && existsSync(key) && wwdr !== null ? { cert, key, wwdr } : null
}
