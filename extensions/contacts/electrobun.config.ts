import type { ElectrobunConfig } from "electrobun"

// The app's identity and signing come from the machine (scripts/app.sh reads them from Switch's
// deploy settings), never from here.
const { env } = process

export default {
  app: {
    name: "Contacts",
    identifier: env.CONTACTS_APP_ID ?? "switch.local.contacts",
    version: env.CONTACTS_APP_VERSION ?? "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "app/bun/index.ts" },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    watchIgnore: ["dist/**", "app/view/**"],
    mac: {
      bundleCEF: false,
      icons: "app/icon.iconset",
      createDmg: false,
      // Signed and notarized when the machine has a Developer ID (ELECTROBUN_DEVELOPER_ID).
      codesign: Boolean(env.ELECTROBUN_DEVELOPER_ID),
      notarize: Boolean(env.ELECTROBUN_APPLEAPIKEY),
    },
  },
  release: { baseUrl: "", generatePatch: false },
} satisfies ElectrobunConfig
