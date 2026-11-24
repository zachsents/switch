import type { ElectrobunConfig } from "electrobun"

// A release (scripts/ship.sh) names the app's identity, version and update feed from the server's
// ~/.switch/deploy.json: a separate id beside the old client until cutover, then the old client's.
const { env } = process

export default {
  app: {
    // A test build beside the live one takes its own name and id (SWITCH_APP_NAME, SWITCH_APP_ID).
    name: env.SWITCH_APP_NAME ?? "Switchboard",
    identifier: env.SWITCH_APP_ID ?? "switch.local.dev",
    version: env.SWITCH_APP_VERSION ?? "0.0.1",
    // switchboard://space/<id> and the old forms (shared/links.ts).
    urlSchemes: ["switchboard"],
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "dist/a2ui-sandbox": "views/mainview/a2ui-sandbox",
      // Dictation's and Quick Look's helpers (src/native), which the bun process runs, and the
      // window's picture, which it loads.
      "dist/switch-dictation": "bin/switch-dictation",
      "dist/switch-quicklook": "bin/switch-quicklook",
      "dist/libswitch-snapshot.dylib": "bin/libswitch-snapshot.dylib",
    },
    watchIgnore: ["dist/**", "src/mainview/**"],
    mac: {
      bundleCEF: false,
      icons: "assets/brand/icon.iconset",
      createDmg: false,
      // Dictation: the microphone, asked for in the app's name (its line: src/native/post-build.ts).
      entitlements: { "com.apple.security.device.audio-input": true },
      // Signed and notarized when a release has the Developer ID (ELECTROBUN_DEVELOPER_ID).
      codesign: Boolean(env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(env.ELECTROBUN_APPLEAPIKEY),
    },
  },
  // Closing the window hides it; the Dock brings it back (src/bun/index.ts).
  runtime: { exitOnLastWindowClosed: false },
  scripts: { postBuild: "src/native/post-build.ts" },
  release: {
    baseUrl: env.SWITCH_UPDATES ?? "",
    generatePatch: false,
  },
} satisfies ElectrobunConfig
