// Provider-specific launch contracts from T3 Code dac6422b (MIT, T3 Tools Inc.).
// Generic ACP owns sessions, tools, history, cancellation and literal argv execution.
import type { Subscription } from "@switch/models"

import { acpAdapter } from "./acp.ts"
import type { AcpFlavor } from "./acp.ts"

export const grokAdapter = (provider: Subscription) =>
  acpAdapter(provider, "grok", () => ["--permission-mode", "default", "agent", "stdio"], {
    resume: true,
    modelSelection: true,
    initializeMeta: { clientType: "extension" },
    cancelMeta: { cancelTrigger: "ctrl_c" },
    authMethod: (s) =>
      (s.host.machine.env.XAI_API_KEY ?? "").trim() === "" ? "cached_token" : "xai.api_key",
  })

export const kiroAdapter = (provider: Subscription) =>
  acpAdapter(provider, "kiro-cli", () => ["acp", "--agent-engine=v3", "--auth-method=cli"], {
    resume: true,
    configOptions: (s) => ({
      autopilot: s.permissions.mode === "bypassPermissions" ? "on" : "off",
      ...(s.model === "default" ? {} : { model: s.model }),
      ...(s.effort === "" ? {} : { effortLevel: s.effort }),
    }),
  })

// OpenCode ships an ACP entry point. One process per thread avoids shared HTTP-server MCP
// registrations while preserving OpenCode's own tools, models, login and native ACP history.
export const opencodeAdapter = (provider: Subscription) =>
  acpAdapter(provider, "opencode", () => ["acp"], { resume: true, modelSelection: true })

/** Registry distributions are installed separately; only explicit local commands execute here. */
export const localAcpAdapter = (
  provider: Subscription,
  command: string,
  args: readonly string[],
  flavor: AcpFlavor = {},
) => acpAdapter(provider, command, () => args, { resume: true, modelSelection: true, ...flavor })
