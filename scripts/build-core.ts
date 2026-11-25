// Cursor is filesystem-loaded, as in T3 Code's cli-external-packages and platform staging.
// Stage the installed dependency closure with its real versions and package boundaries intact.
import { cp, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { stageNode } from "./node-runtime.ts"

const root = path.resolve(import.meta.dir, "..")
const destination = path.resolve(process.argv[2] ?? path.join(root, "dist"))
const target = process.argv.at(3)
const runtime = path.join(destination, "provider-runtime")
await mkdir(destination, { recursive: true })
// The commit it's built from is its release (packages/core/src/release.ts): a host takes the core's.
const commit = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stderr: "ignore" })
const release = commit.success ? commit.stdout.toString().trim() : ""
const compiler = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    path.join(root, "packages/core/src/main.ts"),
    // Its brain reader threads' entry, started as a Worker from inside the binary.
    path.join(root, "packages/core/src/reader.ts"),
    "--outfile",
    path.join(destination, "switch"),
    ...(target === undefined ? [] : ["--target", target]),
    ...(release === "" ? [] : ["--define", `SWITCH_RELEASE=${JSON.stringify(release)}`]),
  ],
  { stdout: "ignore", stderr: "inherit" },
)
if ((await compiler.exited) !== 0) {
  throw new Error("Core build failed")
}
await rm(runtime, { recursive: true, force: true })
await mkdir(path.join(runtime, "node_modules"), { recursive: true })
const built = await Bun.build({
  entrypoints: [path.join(root, "packages/agent/src/cursor-worker.ts")],
  outdir: runtime,
  naming: "cursor-worker.mjs",
  target: "node",
  format: "esm",
  external: ["@cursor/sdk", "@cursor/sdk/*"],
})
if (!built.success) {
  throw new AggregateError(built.logs, "Cursor worker build failed")
}
const packageOf = async (entry: string): Promise<string> => {
  const directory = path.dirname(entry)
  if (directory === path.dirname(directory)) {
    throw new Error("Runtime package manifest missing")
  }
  const manifestFile = Bun.file(path.join(directory, "package.json"))
  if (await manifestFile.exists()) {
    const manifest: unknown = await manifestFile.json()
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      "version" in manifest
    ) {
      return directory
    }
  }
  return await packageOf(directory)
}
const staged = new Map<string, string>()
const stage = async (directory: string): Promise<string> => {
  const source = await realpath(directory)
  const previous = staged.get(source)
  if (previous !== undefined) {
    return previous
  }
  const manifest: unknown = JSON.parse(await readFile(path.join(source, "package.json"), "utf-8"))
  // The file is an installed package-manager manifest, but still validate at this disk boundary.
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    !("version" in manifest) ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("Invalid runtime manifest")
  }
  const output = path.join(
    runtime,
    "node_modules",
    ".store",
    `${manifest.name.replaceAll("/", "+")}@${manifest.version}`,
  )
  staged.set(source, output)
  await cp(source, output, {
    recursive: true,
    dereference: true,
    filter: (file) => path.basename(file) !== "node_modules",
  })
  const require = createRequire(path.join(source, "package.json"))
  const dependencies = new Map<string, boolean>()
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const values: unknown = Reflect.get(manifest, field)
    if (typeof values !== "object" || values === null) {
      continue
    }
    for (const name of Object.keys(values)) {
      dependencies.set(name, field !== "dependencies")
    }
  }
  await Promise.all(
    [...dependencies].map(async ([name, optional]) => {
      let resolved: string
      try {
        resolved = await packageOf(require.resolve(name))
      } catch (error) {
        // Packages may export only binaries (Cursor's platform helpers do).
        try {
          resolved = path.dirname(require.resolve(`${name}/package.json`))
        } catch {
          if (optional) {
            return
          }
          throw error
        }
      }
      const dependency = await stage(resolved)
      const link = path.join(output, "node_modules", name)
      await mkdir(path.dirname(link), { recursive: true })
      await symlink(path.relative(path.dirname(link), dependency), link)
    }),
  )
  return output
}
const agentRequire = createRequire(path.join(root, "packages/agent/package.json"))
const sdkRoot = await packageOf(agentRequire.resolve("@cursor/sdk"))
const sdk = await stage(sdkRoot)
const link = path.join(runtime, "node_modules", "@cursor", "sdk")
await mkdir(path.dirname(link), { recursive: true })
await symlink(path.relative(path.dirname(link), sdk), link)
const platform = target === undefined ? process.platform : target.split("-")[1]
const architecture = target === undefined ? process.arch : target.split("-")[2]
// The SDK finds sdk-* siblings by name, in addition to normal Node resolution. Only the target's:
// the server installs every target's platform packages, to build each one (scripts/ship.sh).
const entries = await readdir(path.dirname(sdkRoot))
const helpers = entries.filter((name) => name === `sdk-${platform}-${architecture}`)
await Promise.all(
  helpers.map(async (name) => {
    const output = await stage(path.join(path.dirname(sdkRoot), name))
    const helper = path.join(runtime, "node_modules", "@cursor", name)
    await symlink(path.relative(path.dirname(helper), output), helper)
    const sibling = path.join(path.dirname(sdk), name)
    await symlink(path.relative(path.dirname(sibling), output), sibling)
  }),
)
if (!helpers.includes(`sdk-${platform}-${architecture}`)) {
  throw new Error(
    `Cursor platform runtime missing: ${platform}-${architecture}; build on the target platform`,
  )
}
await Bun.write(
  path.join(runtime, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
)
await stageNode(runtime, platform ?? process.platform, architecture ?? process.arch)
console.log(`Built ${destination}`)
