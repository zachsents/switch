import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// Temporal where the webview has none yet; native where it does.
import "temporal-polyfill/global"

import { App } from "./app.tsx"
import "./brain.ts"
import { queryClient } from "./query.ts"
import "./index.css"

const root = document.querySelector("#root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
