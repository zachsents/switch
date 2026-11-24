# switch-ext-plain

plain's native macOS apps as one extension: Images (a viewer and editor in the spirit of Preview) and Recorder (screen and meeting recordings, transcribed).

A [Switch](https://switch.ax) extension: `src/main.ts` serves each app's own MCP server (`<app> mcp`, which relays to the running app and launches it in the background when a tool needs it) as one, on stdio. Tools carry their app's prefix (`images_crop_to`, `recorder_start_recording`), events too (`plain.images.data.changed`). The apps are the Rust workspace here (GPUI): `crates/images` and `crates/recorder` on `crates/kit`, `store`, `imaging` and `ai`. `STANDARDS.md` holds the rules they follow.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/plain`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it on a Mac (`macos`).

## Setup

The apps must be installed on that Mac. With Rust, from the extension's folder:

```sh
bun run apps   # cargo xtask install images and recorder
```

Each builds a release, packages `<Name>.app` and puts it in `~/Applications` (`PLAIN_APPS` in the extension's environment names another folder). An app that isn't installed is left out. Bundles are signed with the keychain's Developer ID Application identity, else Apple Development, else ad hoc; `PLAIN_SIGNING_IDENTITY` picks one. A real identity keeps Recorder's Screen Recording and microphone permissions across rebuilds.

- **Model keys:** Images (sizes and crops in words) and Recorder (transcripts) use the user's own keys, found by the apps themselves: one saved in the login keychain under the service `plain`, else the app's environment, else the login shell (`AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Transcription needs the Vercel AI Gateway key.
- **Data:** each app's state is in `~/Library/Application Support/plain/<app>/`; recordings are in `~/Movies/Recorder`.

## Develop

```sh
bun install
bun run check   # TypeScript, lint, format, cargo clippy
bun start       # serves MCP on stdio
```
