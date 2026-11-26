# Switch

Design: CONCEPTS.md. Read it first.

## Rules
- Switch's codebase knows no one: that's data-space, not code-space. No user, business, account, email, machine, address or name in code, prompts or docs. Personal things are data: in the brain, in an extension the user installs, or connected in the client. Public extensions live in `extensions/`, each on the extension kit (`packages/kit`) and installed alone; core code never names or imports one.
- When in doubt, copy T3 Code (/tmp/t3code, `git pull` first). It's the basis for agent logistics (providers, sessions, accounts, orchestration, server); depart only for a genuine improvement, and say why. Switch's own work is the brain/memory model and the UI.
- Concise: every message, doc and UI label as short as it can be.
- Few concepts: merge into an existing one before adding a new one.
- Grid, not cards: every element fills its grid cell edge to edge, hairline dividers between cells. No rounded cards, floating panels or padding around boxes.
- UI copy is labels, data and a one- or two-word placeholder. No captions, hints, subtitles or text explaining how the app works. Empty states are a word or two ("Nothing new"); errors say what is wrong ("Can't reach the brain"). No dimmed state words or ages beside a name. `bun run check` enforces it (switch-ext-kit's `ui-captions`); its allowlist, `scripts/ui-captions.allow`, is for real information only, such as a permission that's off.
- Run `bun run check` after edits.
- No tests. Formal verification otherwise.
- Plain code: no clever expressions like `n-- > 0`. Lint autofixes mangle them.
- Never create, revoke or delete a certificate, key or profile in the user's Apple Developer account (Xcode, the App Store Connect API, anything): ask the user. A build signs only with an identity already on the Mac (`scripts/ios.sh` stops otherwise).

## Layout
- `apps/desktop-gpui`: the desktop app. Rust, on gpui (Zed's) and UI SDK for gpui; the core it reads stays TypeScript. `sh scripts/bundle.sh` builds it; `PORTING.md` has what each part is and where, `DESIGN.md` its look. The ship's `app` lane builds, signs and publishes it, and every Mac's app updates itself.
- `apps/desktop`: the old Electrobun app, kept only for a rollback (`scripts/ship.sh app-electrobun`). Don't change it: a change to the desktop goes in `apps/desktop-gpui`.
- `packages/brain`: Effect.
- `packages/core/skills`: the agent's skills (Claude Code's SKILL.md), listed in every turn, read with `skills_read`.
- `packages/kit`: switch-ext-kit, the extension kit, published to npm; an installed extension resolves it there.
- `extensions/<name>`: the public extensions, each a package with its own `bun run check`, installed alone (`github:zachsents/switch` with `path`). Root lint and format skip them and the kit.
- Public: `sh scripts/publish.sh` puts main on GitHub as one commit, its tree only; history and messages stay on the core machine. `sh scripts/take.sh <n>` takes a public pull request in, crediting its author; the publish that carries it closes it.

## Rust (`apps/desktop-gpui`)
- Proven crates over hand-rolled code; UI SDK for gpui's components and behaviors before anything of the app's own.
- Build with one shared target (`CARGO_TARGET_DIR`) across worktrees, debug builds unless a release is needed; the Swift helpers build with it (`build.rs`).
- The same UI rules: one background, grid not cards, the copy rules above. `ui-captions` reads TypeScript and Swift, not Rust yet: hold the Rust app's copy to them by hand.

## Web, React and TypeScript
- **TanStack by default:** Query, Form, Router, Table, Virtual, Pacer.
  - All async and server state goes through TanStack Query: brain data is query cache fed by sync, and commands are mutations. Never hand-track promise state (`const [error, setError] = useState()`, loading flags and the like).
  - Every form uses TanStack Form, without exception.
- **React Compiler is on:** no `useMemo`, `useCallback` or `React.memo`. Use `ref` as a prop; ref callbacks return their cleanup; `useEffectEvent` for effect handlers; `use()` for promises and context; error boundaries per section. Avoid `useEffect`, keep components small, one per file, logic in hooks.
- **TypeScript:** never `any`, `as unknown as`, `@ts-expect-error`, `@ts-ignore` or lint-silencing comments (ask first). Cast only when strictly needed. Don't annotate what infers. Import types rather than redefining them. Validate untrusted input at runtime with Effect Schema.
- **Modern TS:** `erasableSyntaxOnly` and `exactOptionalPropertyTypes` on (no enums, namespaces or parameter properties). One validation library, Effect Schema, used through Standard Schema wherever a library accepts it (TanStack Form, Router). Brand IDs (`SpaceId`, `ThreadId`). `satisfies` over annotations; `satisfies never` for exhaustive switches. No barrel files except each package's public entry. Published packages (switch-ext-kit): `isolatedDeclarations`, an `exports` map, `publint` and `arethetypeswrong` clean.
- **Current tooling (Nov 2026):** TypeScript 7 (stable `tsc`), with `types` and `rootDir` explicit; oxlint type-aware, with `--type-check` if it matches tsc; Temporal for all time math, not Date.
- **React 19.2:** `<Activity>` keeps recently visited spaces alive; `<ViewTransition>` for navigation; `useOptimistic` only where Query's optimistic updates don't fit.
- **Values:** no needless spreads, defaults, `??`, `?.` or conditions. Prefer truthy checks, and `!= null` when nullish matters.
- **Dependencies:** `bun add`, never hand-edited versions. Prefer official CLIs and generators.
