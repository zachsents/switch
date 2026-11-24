import { QueryClientProvider } from "@tanstack/react-query"
import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
// Temporal where the webview has none yet; native where it does.
import "temporal-polyfill/global"

import { queryClient } from "./query.ts"
import "./index.css"
import { QueryDevtoolsPanel } from "./ui/query-devtools.tsx"
import { startTheme } from "./ui/theme.ts"

/**
 * A window of one thing holds every such page (an ask, a reply's words, a widget, Settings), loaded
 * before it's opened; the main one, the app and its brain.
 */
const page = () => {
  if (/^#(?:window|widget=|settings=)/u.test(location.hash)) {
    return lazy(async () => {
      const { WindowPage } = await import("./ui/window-page.tsx")
      return { default: WindowPage }
    })
  }
  if (import.meta.env.DEV && location.hash === "#gallery") {
    return lazy(async () => {
      const { Gallery } = await import("./ui/gallery.tsx")
      return { default: Gallery }
    })
  }
  return lazy(async () => {
    const [{ App }] = await Promise.all([import("./app.tsx"), import("./drive.ts")])
    return { default: App }
  })
}
// The theme on the first frame, in every window.
startTheme()
const Page = page()

const root = document.querySelector("#root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Suspense>
          <Page />
        </Suspense>
        {import.meta.env.DEV && <QueryDevtoolsPanel />}
      </QueryClientProvider>
    </StrictMode>,
  )
}
