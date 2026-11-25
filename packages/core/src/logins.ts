// The core's logins: `account.added` and `account.removed` in the brain are the only record of which
// there are. What made them logins before is recorded once, each by an id of its own, so a login
// removed since stays removed: config.json's `logins`, each provider's own sign-in found on this
// machine (as it's found, so a CLI installed later joins), the homes of accounts added here (on
// the first start with none recorded), and the two accounts.json files, each gone once all it
// lists is recorded.
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { AccountAdded, allLogins, atHome, cliDirectory, discover, ownedHomes } from "@switch/agent"
import type { Login } from "@switch/agent"
import { InstalledAgent, installedAgent, registryDirectory } from "@switch/agent/acp-install"
import { Brain, defineRead, EventId } from "@switch/brain"
import { SUBSCRIPTIONS } from "@switch/models"
import { Effect, Option, Schema } from "effect"

import type { CoreConfigShape } from "./config.ts"

/** `account.added`'s payload for a login. */
export const addedOf = (l: Login) => ({
  host: l.id,
  provider: l.provider ?? "claude",
  ...(l.owned === true && { owned: true }),
  ...(l.configDir !== undefined && { configDir: l.configDir }),
  ...(l.keychain !== undefined && { keychain: l.keychain }),
  ...(l.acp !== undefined && { acp: l.acp }),
})

const nativeFile = (dir: string) => path.join(dir, "providers", "accounts.json")
const acpFile = (dir: string) => path.join(registryDirectory(dir), "accounts.json")
const decodeNative = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, provider: Schema.Literals(SUBSCRIPTIONS) })),
  ),
)
const decodeAcp = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, acp: InstalledAgent }))),
)

/** A file's logins, or null when it can't be read: never read as none. */
const fileLogins = (file: string, kind: "native" | "acp"): Login[] | null => {
  if (!existsSync(file)) {
    return []
  }
  const text = readFileSync(file, "utf-8")
  if (kind === "native") {
    return Option.getOrNull(decodeNative(text))?.map((l) => ({ ...l })) ?? null
  }
  return (
    Option.getOrNull(decodeAcp(text))?.map((l) => ({
      id: l.id,
      provider: "acp" as const,
      acp: l.acp,
    })) ?? null
  )
}

/** Whether no login was ever recorded: a brain's first start. */
const firstRead = defineRead(
  "core/logins/first",
  (db) => db.query("SELECT 1 FROM events WHERE type = ? LIMIT 1").get(AccountAdded.type) === null,
)
/** The core's logins, as recorded. */
const loginsRead = defineRead("core/logins/logins", allLogins)

/** The core's logins, as hosts are made of them: what's from before recorded first. */
export const loadLogins = (c: CoreConfigShape) =>
  Effect.gen(function* loading() {
    const brain = yield* Brain
    const first = yield* brain.read(firstRead)
    const files = [
      {
        file: nativeFile(c.dir),
        prefix: "providers",
        found: fileLogins(nativeFile(c.dir), "native"),
      },
      { file: acpFile(c.dir), prefix: "acp", found: fileLogins(acpFile(c.dir), "acp") },
    ]
    const found = [
      ...c.logins.map((l) => ({ id: `account:added:config:${l.id}`, login: l })),
      ...(c.logins.length > 0 ? [] : discover(cliDirectory(c.dir))).map((l) => ({
        id: `account:added:found:${l.id}`,
        login: l,
      })),
      ...(first ? ownedHomes(c.dir) : []).map((l) => ({
        id: `account:added:owned:${l.id}`,
        login: l,
      })),
      ...files.flatMap((f) =>
        (f.found ?? []).map((l) => ({ id: `account:added:${f.prefix}:${l.id}`, login: l })),
      ),
    ]
    yield* brain
      .ingest(
        found.map((f) => ({
          id: EventId.make(f.id),
          type: AccountAdded.type,
          source: "core",
          payload: addedOf(f.login),
        })),
      )
      .pipe(Effect.orDie)
    const recorded = yield* brain.read(loginsRead)
    for (const f of files) {
      if (f.found === null) {
        yield* Effect.logWarning(`${f.file} can't be read; kept`)
      } else if (f.found.length > 0 && f.found.every((l) => recorded.some((r) => r.id === l.id))) {
        rmSync(f.file)
        yield* Effect.logInfo(`${f.file}: its ${f.found.length} logins recorded; removed`)
      }
    }
    // An agent from the registry is a login while what it installed is there.
    const usable = yield* Effect.promise(
      async () =>
        await Promise.all(
          recorded.map(async (l) => {
            if (l.acp === undefined) {
              return l
            }
            const receipt = await installedAgent(c.dir, l.acp)
            return receipt === null ? null : { ...l, acp: receipt }
          }),
        ),
    )
    return atHome(
      c.dir,
      usable.filter((l) => l !== null),
    )
  })
