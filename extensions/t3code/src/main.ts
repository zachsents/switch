// The T3 Code watch as a stdio MCP server. State in $T3CODE_EXTENSION_STATE, else t3code.json in
// its folder, with its T3 session beside it.
import path from "node:path"
import { serveStdio } from "switch-ext-kit"

import { t3codeApp, Watch } from "./app.ts"

await serveStdio(
  t3codeApp,
  Watch.layer(
    // T3CODE_SPUR_STATE: its old name, still read.
    process.env.T3CODE_EXTENSION_STATE ??
      process.env.T3CODE_SPUR_STATE ??
      path.resolve("t3code.json"),
  ),
)
