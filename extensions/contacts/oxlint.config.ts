import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"
import react from "ultracite/oxlint/react"

export default defineConfig({
  extends: [core, react],
  options: { typeAware: true },
  ignorePatterns: ["**/.hutch/**", "**/dist/**", "**/build/**", "**/artifacts/**"],
  rules: {
    // TypeScript reports real redeclarations; this flags a schema and its type sharing a name.
    "no-redeclare": "off",
  },
  overrides: [
    {
      // TanStack Virtual's virtualizer is mutable, so the compiler skips memoizing this one
      // component, as the rule says; only its rendered rows leave it.
      files: ["app/view/ui/side.tsx"],
      rules: { "react/incompatible-library": "off" },
    },
  ],
})
