/** Launch contracts ported from T3 Code dac6422b's builtInDrivers and provider packages.
 * This describes upstream transports, not whether a configured Switch account is ready.
 */
export const PROVIDER_LAUNCHES = {
  claude: {
    label: "Claude",
    transport: "claude",
    command: "claude",
    args: [],
    loginArgs: ["auth", "login"],
  },
  codex: {
    label: "Codex",
    transport: "codex",
    command: "codex",
    args: ["app-server"],
    loginArgs: ["login", "--device-auth"],
  },
  cursor: {
    label: "Cursor",
    transport: "cursor-sdk",
    command: "cursor-agent",
    args: [],
    loginArgs: ["login"],
  },
  opencode: {
    label: "OpenCode",
    transport: "opencode-http",
    command: "opencode",
    args: ["serve"],
    loginArgs: ["auth", "login"],
  },
  antigravity: {
    label: "Antigravity",
    transport: "acp",
    command: "agy",
    args: ["acp"],
    loginArgs: ["acp", "--login"],
  },
  grok: {
    label: "Grok",
    transport: "acp",
    command: "grok",
    args: ["--permission-mode", "default", "agent", "stdio"],
    loginArgs: ["login", "--device-auth"],
  },
  fx: {
    label: "FX",
    transport: "acp",
    command: "fx",
    args: ["acp"],
    loginArgs: ["login"],
  },
  kiro: {
    label: "Kiro",
    transport: "acp",
    command: "kiro-cli",
    args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    loginArgs: ["login"],
  },
  pi: {
    label: "Pi",
    transport: "pi-rpc",
    command: "pi",
    args: ["--mode", "rpc"],
    loginArgs: [],
  },
  muse: {
    label: "Muse",
    transport: "muse-msp",
    command: "muse",
    args: ["serve"],
    loginArgs: ["login"],
  },
  acp: {
    label: "ACP",
    transport: "acp",
    command: "",
    args: [],
    loginArgs: [],
  },
} as const

export type ProviderDriver = keyof typeof PROVIDER_LAUNCHES

/**
 * The providers whose accounts Switch adds, any number, each in a home of its own (T3 Code's
 * provider instances), and signs in and out there.
 */
export const LOGIN_PROVIDERS = [
  "claude",
  "codex",
  "fx",
] as const satisfies readonly ProviderDriver[]
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number]

/** Whether accounts of `provider` can be added. */
export const isLoginProvider = (provider: string): provider is LoginProvider =>
  LOGIN_PROVIDERS.some((p) => p === provider)
