// The app's Swift helpers (src/native), beside the bun code in the bundle: Resources/app/bin.
import { existsSync } from "node:fs"
import path from "node:path"

export const nativeHelper = (name: string) =>
  [
    path.resolve(import.meta.dir, "..", "bin", name),
    path.resolve(process.cwd(), "..", "Resources", "app", "bin", name),
  ].find((f) => existsSync(f))
