// The watch face as a stdio MCP server.
import { serveStdio } from "switch-ext-kit"

import { Face, watchApp } from "./app.ts"

await serveStdio(watchApp, Face)
