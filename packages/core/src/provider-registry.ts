import path from "node:path"
import { AccountAdded, allLogins, Hosts } from "@switch/agent"
import type { Login } from "@switch/agent"
import { RegistrySelection, installRegistryAgent } from "@switch/agent/acp-install"
import { fetchRegistry, registryTarget } from "@switch/agent/acp-registry"
import { Brain, defineRead, EventId } from "@switch/brain"
import { SUBSCRIPTIONS } from "@switch/models"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"

import { CoreConfig } from "./config.ts"
import { addedOf } from "./logins.ts"
import { Profiles } from "./model-catalog.ts"
import { web } from "./web.ts"

/** The core's logins, as recorded: which agents are installed. */
const loginsRead = defineRead("core/provider-registry/logins", allLogins)

export const registryRoutes = Layer.unwrap(
  Effect.gen(function* routes() {
    const config = yield* CoreConfig
    const hosts = yield* Hosts
    const profiles = yield* Profiles
    const brain = yield* Brain
    // Recorded first, then a host: a login is the brain's (logins.ts).
    const addLogin = async (login: Login) => {
      const machine = hosts.all.find((host) => host.machine.id === config.machine)?.machine
      if (machine === undefined) {
        throw new Error("Local host unavailable")
      }
      await Effect.runPromise(
        brain.ingest([
          {
            id: EventId.make(`account:${crypto.randomUUID()}`),
            type: AccountAdded.type,
            source: "agent",
            payload: addedOf(login),
          },
        ]),
      )
      await Effect.runPromise(
        hosts.add({
          id: login.id,
          provider: login.provider ?? "claude",
          machine,
          ...(login.acp !== undefined && { acp: login.acp }),
        }),
      )
    }
    const fetch = async (request: Request) => {
      if (new URL(request.url).pathname === "/providers/add") {
        const decoded = Schema.decodeUnknownOption(
          Schema.Struct({ provider: Schema.Literals(SUBSCRIPTIONS) }),
        )(await request.json())
        if (decoded._tag !== "Some" || decoded.value.provider === "acp") {
          return Response.json({ error: "Choose a provider" }, { status: 400 })
        }
        const { provider } = decoded.value
        if (hosts.get(provider) !== undefined) {
          return new Response(null, { status: 204 })
        }
        await addLogin({ id: provider, provider })
        await Effect.runPromise(profiles.refresh)
        return new Response(null, { status: 204 })
      }
      if (request.method === "GET") {
        const index = await Effect.runPromise(fetchRegistry())
        const target = registryTarget(process.platform, process.arch)
        const query = (new URL(request.url).searchParams.get("search") ?? "").toLowerCase()
        const installed = await Effect.runPromise(brain.read(loginsRead))
        return Response.json({
          agents: index.agents
            .filter((agent) => `${agent.name} ${agent.id}`.toLowerCase().includes(query))
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              version: agent.version,
              description: agent.description,
              distributions: [
                ...(target !== null && agent.distribution.binary?.[target] !== undefined
                  ? ["binary"]
                  : []),
                ...(agent.distribution.npx === undefined ? [] : ["npx"]),
                ...(agent.distribution.uvx === undefined ? [] : ["uvx"]),
              ],
              installed: installed.some(
                (login) => login.acp?.agentId === agent.id && login.acp.version === agent.version,
              ),
            })),
        })
      }
      const decoded = Schema.decodeUnknownOption(RegistrySelection)(await request.json())
      if (decoded._tag !== "Some") {
        return Response.json({ error: "Invalid registry selection" }, { status: 400 })
      }
      const runtime = process.env.SWITCH_PROVIDER_RUNTIME ?? path.resolve("dist/provider-runtime")
      try {
        const receipt = await installRegistryAgent(config.dir, decoded.value, runtime)
        await addLogin({ id: `acp-${receipt.agentId}`, provider: "acp", acp: receipt })
        await Effect.runPromise(profiles.refresh)
        return new Response(null, { status: 204 })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Registry installation failed"
        // Error text here is fixed by the installer; package-manager output is never retained.
        return Response.json(
          { error: message },
          { status: message.includes("selection changed") ? 409 : 503 },
        )
      }
    }
    // Settings calls these from the desktop view's own origin, as it does /models: every answer,
    // a failure's too (a registry that can't be read, a login that can't be saved), says so.
    const open = (failure: string) => async (request: Request) => {
      const response = await fetch(request).catch(() =>
        Response.json({ error: failure }, { status: 503 }),
      )
      response.headers.set("access-control-allow-origin", "*")
      return response
    }
    return Layer.mergeAll(
      HttpRouter.add("POST", "/providers/add", web(open("Can't add the provider"))),
      HttpRouter.add("GET", "/providers/registry", web(open("ACP Registry unavailable"))),
      HttpRouter.add("POST", "/providers/registry/install", web(open("Can't install the agent"))),
    )
  }),
)
