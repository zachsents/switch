import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"
import react from "ultracite/oxlint/react"

export default defineConfig({
  extends: [core, react],
  options: { typeAware: true },
  rules: {
    // A tab's input goes in order (a press before its release, a step before the next), and its
    // waits poll: these loops await one thing at a time on purpose.
    "eslint/no-await-in-loop": "off",
    // The debugger's modifier keys are bits.
    "eslint/no-bitwise": "off",
    // An op is one case of one switch, as Switchboard's browser had it.
    "eslint/complexity": "off",
  },
  // The scripts that run in the browser are plain JavaScript, ported as they were.
  ignorePatterns: ["**/.hutch/**", "**/dist/**", "**/build/**", "extension/**", "src/page.js"],
})
