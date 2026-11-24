// Native Claude release recipe from https://claude.ai/install.sh and the official setup docs.
// ACP registry packages have their own registry installer; native CLIs never impersonate entries.
import { link, chmod, mkdir, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

const RELEASES = "https://downloads.claude.ai/claude-code-releases"
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u))
const Manifest = Schema.Struct({
  platforms: Schema.Record(
    Schema.String,
    Schema.Struct({ checksum: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)) }),
  ),
})
const Receipt = Schema.Struct({
  version: Version,
  checksum: Schema.String,
  platform: Schema.String,
})
export const cliDirectory = (state: string) => path.join(state, "providers", "cli", "bin")
export const cliCommand = (state: string, provider: string) =>
  Bun.which(provider, { PATH: `${process.env.PATH ?? ""}:${cliDirectory(state)}` })

const run = async (argv: readonly string[]) => {
  const child = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FX_SOUND: "off" },
  })
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
  }, 15_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error("CLI verification failed")
    }
    return stdout + stderr
  } finally {
    clearTimeout(timer)
  }
}
export const cliVersion = async (command: string) => {
  const reported = await run([command, "--version"])
  return reported.trim().slice(0, 160)
}
const get = async (url: string) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    throw new Error("Claude release unavailable")
  }
  return response
}
export const canInstallClaude = () =>
  process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")

// The helper holds a kernel lock while stdin is open. A killed core closes its pipe, so
// installation can be retried after a crash; the lock file itself is intentionally persistent.
/** Holds `file` locked until released: by a process the kernel ends with this one, so a crash
 * never leaves it held. */
export const acquireInstall = async (file: string, busy: string) => {
  const child = Bun.spawn(["/usr/bin/lockf", "-k", "-t", "0", file, "/bin/cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  await child.stdin.write("locked\n")
  await child.stdin.flush()
  const reply = await reader.read()
  reader.releaseLock()
  if (reply.done || new TextDecoder().decode(reply.value) !== "locked\n") {
    await child.exited
    throw new Error(busy)
  }
  return async () => {
    await child.stdin.end()
    await child.exited
  }
}

/** Installs only the fixed official native recipe, without touching the user's launcher or login. */
export const installClaude = async (state: string) => {
  if (!canInstallClaude()) {
    throw new Error("Managed Claude installation unavailable on this platform")
  }
  if (cliCommand(state, "claude") !== null) {
    return
  }
  const latest = await get(`${RELEASES}/latest`)
  const latestVersion = await latest.text()
  const version = Schema.decodeUnknownSync(Version)(latestVersion.trim())
  const platform = `${process.platform}-${process.arch}`
  const manifestResponse = await get(`${RELEASES}/${version}/manifest.json`)
  const manifest = Schema.decodeUnknownSync(Manifest)(await manifestResponse.json())
  const release = manifest.platforms[platform]
  if (release === undefined) {
    throw new Error("Claude platform unavailable")
  }
  const root = path.join(state, "providers", "cli")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const canonical = path.join(await realpath(state), "providers", "cli")
  if ((await realpath(root)) !== canonical) {
    throw new Error("Unsafe CLI directory")
  }
  const releaseLock = await acquireInstall(
    path.join(root, "claude.install.lock"),
    "Claude installation already running",
  )
  const directory = path.join(root, `claude-${version}-${platform}-${crypto.randomUUID()}`)
  const scratch = path.join(root, `.claude-${crypto.randomUUID()}`)
  try {
    await mkdir(scratch, { mode: 0o700 })
    const response = await get(`${RELEASES}/${version}/${platform}/claude`)
    if (response.body === null) {
      throw new Error("Claude download empty")
    }
    const file = path.join(scratch, "claude")
    const writer = Bun.file(file).writer()
    const hash = new Bun.CryptoHasher("sha256")
    let size = 0
    try {
      const bytes: ReadableStream<Uint8Array> = response.body
      for await (const chunk of bytes) {
        size += chunk.length
        if (size > 512 * 1024 * 1024) {
          throw new Error("Claude download too large")
        }
        hash.update(chunk)
        void writer.write(chunk)
      }
    } finally {
      await writer.end()
    }
    if (hash.digest("hex") !== release.checksum) {
      throw new Error("Claude checksum mismatch")
    }
    await chmod(file, 0o755)
    await run(["/usr/bin/codesign", "--verify", "--strict", file])
    const signature = await run(["/usr/bin/codesign", "--display", "--verbose=2", file])
    if (
      !/^Authority=Developer ID Application: Anthropic(?: PBC|, PBC) \([A-Z0-9]+\)$/mu.test(
        signature,
      )
    ) {
      throw new Error("Claude publisher mismatch")
    }
    const reported = await cliVersion(file)
    if (!reported.startsWith(`${version} `)) {
      throw new Error("Claude version mismatch")
    }
    await Bun.write(
      path.join(scratch, "receipt.json"),
      JSON.stringify({
        version,
        platform,
        checksum: release.checksum,
      } satisfies typeof Receipt.Type),
    )
    await rename(scratch, directory)
    const bin = cliDirectory(state)
    await mkdir(bin, { recursive: true, mode: 0o700 })
    if ((await realpath(bin)) !== path.join(canonical, "bin")) {
      throw new Error("Unsafe CLI launcher directory")
    }
    const launcher = path.join(bin, "claude")
    // Hard link only inside the managed root; never replace an existing executable.
    await link(path.join(directory, "claude"), launcher)
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await releaseLock()
  }
}
