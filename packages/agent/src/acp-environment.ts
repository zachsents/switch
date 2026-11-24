import type { Machine } from "./hosts.ts"
import { childEnv } from "./provider.ts"

/** Chat and discovery must resolve the same installed runtime and registry environment. */
export const acpEnvironment = (
  machine: Pick<Machine, "env" | "guard">,
  overrides: Readonly<Record<string, string>> = {},
) =>
  childEnv(
    machine,
    /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|CODEX_HOME|FX_HOME)$/u,
    { ...overrides, FX_AUTO_UPGRADE: "0", FX_SOUND: "off" },
  )
