// Electrobun's postBuild hook: the built app's microphone prompt says what it's for. The
// entitlement alone (electrobun.config.ts) gives it a generic line. It runs before the app is signed.
import path from "node:path"

const dir = process.env.ELECTROBUN_BUILD_DIR ?? "build"
for (const plist of new Bun.Glob("*.app/Contents/Info.plist").scanSync(dir)) {
  Bun.spawnSync([
    "plutil",
    "-replace",
    "NSMicrophoneUsageDescription",
    "-string",
    "For dictation.",
    path.join(dir, plist),
  ])
}
