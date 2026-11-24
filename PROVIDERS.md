# Providers

Settings → Models adds a provider's default account or installs one selected ACP Registry agent.
Profiles select a provider, model and optional account. Adding a provider does not sign it in.
Credentials remain in its CLI or SDK store; installation never starts paid authentication.

- Claude and Codex use their native streaming protocols; Antigravity, FX, Grok, Kiro and OpenCode use ACP.
- Cursor uses `@cursor/sdk` 1.4.2 in an isolated Node worker. Its SDK sign-in is separate from the CLI's:
  `~/.cursor/sdk/auth.json`, or `<configDir>/sdk/auth.json` for a configured account. The default
  account can also use an existing `CURSOR_API_KEY`. A configured account never inherits that key.
- Muse uses `@muse-code/sdk` 1.4.6 over MSP. Run `muse login` on the host. Its instances share the
  CLI's login, as upstream does. Pi uses native RPC and an injected HTTP MCP bridge.
- ACP initialization proves the transport, not the login. Settings shows **Sign-in unchecked**
  until the provider can supply stronger evidence. The first turn reports native authentication
  failures. Providers without a discoverable catalog offer their native default model.

`bun run build` stages the compiled core plus `provider-runtime`: the real Cursor package,
its dependency closure and platform helpers, a separate worker, and official Node 22.23.5/npm.
Node downloads are pinned and SHA-256 checked. SDK runtime files are not inlined into the daemon.
Release bundles include and sign native runtime files. Build on the target platform; a missing
Cursor platform helper fails the build rather than shipping a mismatched runtime.

Registry installation re-reads the official catalog and checks the selected version. Binary
archives use the catalog's SHA-256 when provided; entries without a checksum retain HTTPS
integrity. Extraction rejects escaping paths and links. npm and uv use exact registry package
pins in per-agent directories. npm uses the bundled runtime; Python packages require `uv`.
Only server-derived commands, arguments and environment are persisted. Installed receipts and
selected accounts live under `~/.switch/providers`; existing versions stay intact for running
sessions. Native CLI installation and paid sign-in remain separate from adding an account.
