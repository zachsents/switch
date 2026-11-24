import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import type { Plugin } from "vite"

// A2UI's MCP App sandbox proxy, served at /a2ui-sandbox/ on the app's own origin, as McpApp expects.
const SANDBOX = path.join(import.meta.dirname, "node_modules/@a2ui/catalog-mcp/sandbox")
// Its page never scrolls, and the app's frame in it takes any size, even under an iframe's own
// least (150 px tall): the frame is as tall as the app says it draws, nothing past it.
const FIT = "<style>html,body{overflow:hidden}iframe{min-width:0;min-height:0}</style>"
const served = (file: string) => {
  const raw = readFileSync(path.join(SANDBOX, file))
  return file.endsWith(".html") ? raw.toString().replace("</head>", `${FIT}</head>`) : raw
}
const sandbox = (): Plugin => ({
  name: "a2ui-sandbox",
  configureServer(server) {
    server.middlewares.use("/a2ui-sandbox", (req, res, next) => {
      const file = path.basename(new URL(req.url ?? "/", "http://x").pathname)
      if (!readdirSync(SANDBOX).includes(file)) {
        next()
        return
      }
      res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html")
      res.end(served(file))
    })
  },
  generateBundle() {
    for (const file of readdirSync(SANDBOX)) {
      this.emitFile({
        type: "asset",
        fileName: `a2ui-sandbox/${file}`,
        source: served(file),
      })
    }
  },
})

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), sandbox()],
  root: "src/mainview",
  // The devkit projects Electrobun's view SDK here, outside node_modules.
  resolve: {
    alias: {
      "electrobun/view": path.join(import.meta.dirname, ".hutch/devkit/api/browser/index.ts"),
    },
  },
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
})
