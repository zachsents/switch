import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"
import react from "ultracite/oxlint/react"

export default defineConfig({
  extends: [core, react],
  options: { typeAware: true },
  ignorePatterns: ["**/.hutch/**", "**/dist/**", "**/build/**", "extensions/**", "packages/kit/**"],
  rules: {
    // Effect's TaggedErrors and Schema classes sit together, one module per concern.
    "max-classes-per-file": "off",
    // It reads `Schema.TaggedError<X>()(...)`, a class factory, as an `Error` thrown without `new`.
    "unicorn/throw-new-error": "off",
    // SDK hooks like MCP's `onclose` are plain properties, not DOM event targets.
    "unicorn/prefer-add-event-listener": "off",
    // TypeScript reports real redeclarations; this flags a schema and its type sharing a name.
    "no-redeclare": "off",
  },
  overrides: [
    {
      // TanStack Virtual's virtualizer is mutable, so the compiler skips memoizing this one
      // component, as the rule says; only its rendered rows leave it.
      files: ["apps/desktop/src/mainview/ui/scroll.tsx"],
      rules: { "react/incompatible-library": "off" },
    },
    {
      // A2UI's Video and AudioPlayer carry no captions to give a <track>.
      files: [
        "apps/desktop/src/mainview/widgets/basic/video.tsx",
        "apps/desktop/src/mainview/widgets/basic/audio-player.tsx",
      ],
      rules: { "jsx-a11y/media-has-caption": "off" },
    },
  ],
})
