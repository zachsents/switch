// Registry boundary from T3 Code's AcpRegistrySupport.ts (MIT, T3 Tools Inc.).
// Installation remains explicit: registry metadata never runs a package manager or login.
import type { Subscription } from "@switch/models"
import { Effect, Schema } from "effect"

import { localAcpAdapter } from "./acp-providers.ts"

const argument = Schema.String.check(Schema.isMaxLength(1024))
const args = Schema.optionalKey(Schema.Array(argument).check(Schema.isMaxLength(64)))
const env = Schema.optionalKey(Schema.Record(Schema.String, argument))
const https = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "https:" && url.username === "" && url.password === ""
    } catch {
      return false
    }
  }),
)
const version = "v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?"
const npmPackage = Schema.String.check(
  Schema.isPattern(new RegExp(`^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${version}$`, "iu")),
)
const pythonPackage = Schema.String.check(
  Schema.isPattern(new RegExp(`^[a-z0-9][a-z0-9._-]*(?:@|==)${version}$`, "iu")),
)

const registryAgent = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u), Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMaxLength(160)),
  version: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)),
  description: Schema.String.check(Schema.isMaxLength(1024)),
  repository: Schema.optionalKey(https),
  website: Schema.optionalKey(https),
  license: Schema.optionalKey(Schema.String),
  distribution: Schema.Struct({
    binary: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          archive: https,
          cmd: argument,
          sha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/iu))),
          args,
          env,
        }),
      ),
    ),
    npx: Schema.optionalKey(Schema.Struct({ package: npmPackage, args, env })),
    uvx: Schema.optionalKey(Schema.Struct({ package: pythonPackage, args, env })),
  }),
})
export type RegistryAgent = typeof registryAgent.Type
export type RegistryDistribution = "binary" | "npx" | "uvx"
const envelope = Schema.Struct({
  version: Schema.String,
  agents: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1000)),
})
const decodeAgent = Schema.decodeUnknownOption(registryAgent)

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
}) {}

/** Skip malformed entries individually, as T3 does, so one agent cannot hide the whole catalog. */
export const parseRegistry = (value: unknown) =>
  Schema.decodeUnknownEffect(envelope)(value).pipe(
    Effect.map((index) => ({
      version: index.version,
      agents: index.agents.flatMap((entry) => {
        const parsed = decodeAgent(entry)
        return parsed._tag === "Some" ? [parsed.value] : []
      }),
    })),
  )

export const fetchRegistry = () =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
        {
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (!response.ok) {
        throw new Error(`ACP Registry: ${response.status}`)
      }
      if (response.body === null) {
        throw new Error("ACP Registry body missing")
      }
      const readable: ReadableStream<Uint8Array> = response.body
      const decoder = new TextDecoder()
      let size = 0
      let body = ""
      try {
        for await (const chunk of readable) {
          size += chunk.length
          if (size > 1024 * 1024) {
            throw new Error("ACP Registry exceeds 1 MiB")
          }
          body += decoder.decode(chunk, { stream: true })
        }
        body += decoder.decode()
        const value: unknown = JSON.parse(body)
        return value
      } finally {
        await readable.cancel()
      }
    },
    catch: (error) =>
      new RegistryError({
        message: error instanceof Error ? error.message : "ACP Registry unavailable",
      }),
  }).pipe(Effect.flatMap(parseRegistry))

export const registryTarget = (platform: NodeJS.Platform, architecture: NodeJS.Architecture) => {
  const platforms: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  }
  const architectures: Partial<Record<NodeJS.Architecture, string>> = {
    arm64: "aarch64",
    x64: "x86_64",
  }
  const os = platforms[platform]
  const arch = architectures[architecture]
  return os === undefined || arch === undefined ? null : `${os}-${arch}`
}

/** The explicitly installed executable retains the selected distribution's args and environment. */
export const registryAcpAdapter = (
  provider: Subscription,
  agent: RegistryAgent,
  command: string,
  distribution: RegistryDistribution,
  target: string,
  authMethod?: string,
) => {
  const selected =
    distribution === "binary"
      ? agent.distribution.binary?.[target]
      : agent.distribution[distribution]
  if (selected === undefined || command.trim() === "") {
    throw new Error("ACP distribution unavailable")
  }
  return localAcpAdapter(provider, command, selected.args ?? [], {
    env: () => selected.env ?? {},
    ...(authMethod === undefined ? {} : { authMethod: () => authMethod }),
  })
}
