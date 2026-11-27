// Ghostty as a stdio MCP server.
import { serveStdio } from "switch-ext-kit"

import { ghosttyApp, Health } from "./app.ts"

await serveStdio(ghosttyApp, Health.layer)
