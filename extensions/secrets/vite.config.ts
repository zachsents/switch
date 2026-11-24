import path from "node:path"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  root: "app/view",
  // The devkit projects Electrobun's view SDK here, outside node_modules.
  resolve: {
    alias: {
      "electrobun/view": path.join(import.meta.dirname, ".hutch/devkit/api/browser/index.ts"),
    },
  },
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { port: 5184, strictPort: true },
})
