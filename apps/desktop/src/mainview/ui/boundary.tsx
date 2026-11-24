// A section that fails alone: its own fallback, and Retry asks its queries again.
import { QueryErrorResetBoundary } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { ErrorBoundary } from "react-error-boundary"
import type { FallbackProps } from "react-error-boundary"

import { Stop } from "./marks.tsx"
import { failed } from "./reports.ts"
import { Button } from "./kit/button.tsx"

const Fallback = ({ resetErrorBoundary }: FallbackProps) => (
  <div className="flex h-line items-center gap-2.5 px-inset text-small text-ink line-2-b">
    <Stop size={12} />
    <span className="min-w-0 flex-1 truncate">Can&apos;t show this</span>
    <Button look="key" onClick={resetErrorBoundary}>
      Retry
    </Button>
  </div>
)

export const Boundary = ({ children }: { children: ReactNode }) => (
  <QueryErrorResetBoundary>
    {({ reset }) => (
      <ErrorBoundary onReset={reset} onError={failed} FallbackComponent={Fallback}>
        {children}
      </ErrorBoundary>
    )}
  </QueryErrorResetBoundary>
)
