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
    // The vault's writes and the Keychain's reads go one at a time, in order, on purpose.
    "eslint/no-await-in-loop": "off",
    // A field's checks and a save's many optional parts are one case each, read top to bottom.
    "eslint/complexity": "off",
  },
  overrides: [
    {
      // Base32 and HOTP's dynamic truncation are bit arithmetic (RFC 4648, RFC 4226).
      files: ["src/otp.ts"],
      rules: { "eslint/no-bitwise": "off" },
    },
    {
      // TanStack Virtual's virtualizer is mutable, so the compiler skips memoizing these
      // components, as the rule says; only their rendered rows leave them.
      files: ["app/view/ui/list.tsx", "app/view/ui/panel.tsx"],
      rules: { "react/incompatible-library": "off" },
    },
  ],
})
