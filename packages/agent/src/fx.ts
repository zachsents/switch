// fx's ACP flavor follows T3 Code's provider-fx adapter. Its own Gateway login stays with fx.
import { fxCompletion } from "./fx-completion.ts"
import type { Adapter, Start } from "./provider.ts"
import { acpAdapter } from "./acp.ts"

const interactive = acpAdapter(
  "fx",
  "fx",
  (s) => [
    "acp",
    "--provider",
    "gateway",
    "--permission-mode",
    s.permissions.mode === "bypassPermissions" ? "full-access" : "ask",
    ...(s.model === "default" ? [] : ["--model", s.model]),
  ],
  {
    resume: true,
    effortConfigId: "effort",
    configOptions: (s) => ({ effort: s.effort }),
    steering: true,
    systemPrompt: true,
    env: (s) => (s.host.configDir === undefined ? {} : { FX_HOME: s.host.configDir }),
  },
)

/**
 * A machine's environment for an fx login in a home of its own (FX_HOME): without the Gateway key,
 * which would make it the machine's own login.
 */
export const homeEnv = (env: Readonly<Record<string, string>>) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (!/^(?:AI_GATEWAY_|VERCEL_OIDC)/u.test(k)) {
      out[k] = v
    }
  }
  return out
}

const own = (s: Start): Start =>
  s.host.configDir === undefined
    ? s
    : {
        ...s,
        host: { ...s.host, machine: { ...s.host.machine, env: homeEnv(s.host.machine.env) } },
      }

export const fxAdapter: Adapter = {
  ...interactive,
  start: (s) =>
    s.permissions.tools.length === 0 ? fxCompletion(own(s)) : interactive.start(own(s)),
}
