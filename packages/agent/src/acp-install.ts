// Selected-agent managed installs follow T3 Code's AcpRegistrySupport exact pins and checksums.
import { statSync } from "node:fs"
import { chmod, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Effect, Schema } from "effect"

import { fetchRegistry, registryTarget } from "./acp-registry.ts"
import { acquireInstall } from "./managed-cli.ts"
import type { RegistryAgent } from "./acp-registry.ts"

const agentId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
  Schema.isMaxLength(128),
)
const version = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
  Schema.isMaxLength(128),
)
export const RegistrySelection = Schema.Struct({
  agentId,
  version,
  distribution: Schema.Literals(["binary", "npx", "uvx"]),
})
export type RegistrySelection = typeof RegistrySelection.Type
export const InstalledAgent = Schema.Struct({
  ...RegistrySelection.fields,
  target: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  integrity: Schema.String,
})
export type InstalledAgent = typeof InstalledAgent.Type
const parseReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(InstalledAgent))
const relative = (base: string, file: string) => {
  const value = path.relative(base, file)
  return value !== "" && !value.startsWith("..") && !path.isAbsolute(value)
}
export const registryDirectory = (state: string) => path.join(state, "providers", "acp")
const installDirectory = (state: string, selection: RegistrySelection, target: string) =>
  path.join(
    registryDirectory(state),
    selection.agentId,
    selection.version,
    `${selection.distribution}-${target}`,
  )
export const installedAgent = async (state: string, selection: RegistrySelection) => {
  const target = registryTarget(process.platform, process.arch)
  if (target === null) {
    return null
  }
  const directory = installDirectory(state, selection, target)
  try {
    const receipt = parseReceipt(await readFile(path.join(directory, "receipt.json"), "utf-8"))
    if (
      receipt.agentId !== selection.agentId ||
      receipt.version !== selection.version ||
      receipt.distribution !== selection.distribution ||
      receipt.target !== target ||
      !relative(await realpath(directory), await realpath(receipt.command))
    ) {
      return null
    }
    return receipt
  } catch {
    return null
  }
}
const drain = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    if (text.length > 1024 * 1024) {
      text = text.slice(-1024 * 1024)
    }
  }
  return text
}
const run = async (argv: readonly string[], environment: Record<string, string | undefined>) => {
  const child = Bun.spawn([...argv], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => {
    child.kill()
  }, 20 * 60_000)

  try {
    const [stdout, , code] = await Promise.all([
      drain(child.stdout),
      drain(child.stderr),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error("Registry package installation failed")
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
const extract = String.raw`import os,sys,tarfile,zipfile,shutil,pathlib,stat
archive,dest=sys.argv[1:]
size=0
count=0
links=[]
def target(name):
 global count
 count+=1
 p=pathlib.PurePosixPath(name.replace(chr(92),'/'))
 if count>50000 or p.is_absolute() or '..' in p.parts or ':' in name or chr(0) in name: raise ValueError('Unsafe archive path')
 return os.path.join(dest,*p.parts)
def copy(src,out,length,mode):
 global size
 size+=length
 if size>1024*1024*1024: raise ValueError('Archive exceeds 1 GiB')
 os.makedirs(os.path.dirname(out),exist_ok=True)
 with open(out,'xb') as dst: shutil.copyfileobj(src,dst)
 os.chmod(out,mode & 0o777)
if zipfile.is_zipfile(archive):
 with zipfile.ZipFile(archive) as z:
  for m in z.infolist():
   out=target(m.filename)
   mode=m.external_attr>>16
   if stat.S_ISLNK(mode):
    if m.file_size>4096: raise ValueError('Archive link too long')
    links.append((out,z.read(m).decode('utf8'),False))
    continue
   if m.is_dir(): os.makedirs(out,exist_ok=True)
   else:
    with z.open(m) as src: copy(src,out,m.file_size,mode or 0o644)
else:
 with tarfile.open(archive) as t:
  for m in t:
   out=target(m.name)
   if m.isdir(): os.makedirs(out,exist_ok=True)
   elif m.isfile():
    with t.extractfile(m) as src: copy(src,out,m.size,m.mode)
   elif m.issym(): links.append((out,m.linkname,False))
   elif m.islnk(): links.append((out,m.linkname,True))
   else: raise ValueError('Archive special files rejected')
for out,name,hard in links:
 if os.path.isabs(name) or ':' in name: raise ValueError('Unsafe archive link')
 resolved=os.path.realpath(os.path.join(dest if hard else os.path.dirname(out),name))
 if os.path.commonpath((os.path.realpath(dest),resolved))!=os.path.realpath(dest): raise ValueError('Archive link escaped installation')
 os.makedirs(os.path.dirname(out),exist_ok=True)
 if hard: os.link(resolved,out)
 else: os.symlink(name,out)
`
const binaryInstall = async (agent: RegistryAgent, target: string, directory: string) => {
  const binary = agent.distribution.binary?.[target]
  if (binary === undefined) {
    throw new Error("Registry platform unavailable")
  }
  const archive = path.join(directory, "download")
  const response = await fetch(binary.archive, { signal: AbortSignal.timeout(20 * 60_000) })
  if (!response.ok || response.body === null) {
    throw new Error("Registry download failed")
  }
  const bytes: ReadableStream<Uint8Array> = response.body
  const writer = Bun.file(archive).writer()
  const hash = new Bun.CryptoHasher("sha256")
  let size = 0
  try {
    for await (const chunk of bytes) {
      size += chunk.length
      if (size > 1024 * 1024 * 1024) {
        throw new Error("Registry download exceeds 1 GiB")
      }
      hash.update(chunk)
      void writer.write(chunk)
    }
    await writer.end()
    const digest = hash.digest("hex")
    if (binary.sha256 !== undefined && digest !== binary.sha256.toLowerCase()) {
      throw new Error("Registry checksum mismatch")
    }
    await run(["python3", "-c", extract, archive, directory], process.env)
    const command = await realpath(path.resolve(directory, binary.cmd))
    if (!relative(await realpath(directory), command)) {
      throw new Error("Registry executable escaped installation")
    }
    await chmod(command, 0o755)
    return {
      command,
      args: binary.args ?? [],
      env: binary.env ?? {},
      integrity: binary.sha256 === undefined ? "https" : `sha256:${digest}`,
    }
  } finally {
    await writer.end()
    await rm(archive, { force: true })
  }
}
const npmInstall = async (agent: RegistryAgent, directory: string, runtime: string) => {
  const distribution = agent.distribution.npx
  if (distribution === undefined) {
    throw new Error("Registry npm distribution unavailable")
  }
  const at = distribution.package.lastIndexOf("@")
  const name = distribution.package.slice(0, at)
  const pinned = distribution.package.slice(at + 1).replace(/^v/u, "")
  const node = path.join(runtime, "node")
  await run(
    [
      node,
      path.join(runtime, "npm", "bin", "npm-cli.js"),
      "install",
      "--global",
      "--prefix",
      path.join(directory, "npm"),
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--",
      distribution.package,
    ],
    { ...process.env, PATH: `${runtime}:${process.env.PATH ?? ""}` },
  )
  const root = path.join(directory, "npm", "lib", "node_modules", name)
  const manifest: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf-8"))
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      bin: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
    }),
  )(manifest)
  if (decoded.name !== name || decoded.version !== pinned) {
    throw new Error("Registry npm pin mismatch")
  }
  const bins =
    typeof decoded.bin === "string"
      ? { [name.split("/").at(-1) ?? name]: decoded.bin }
      : decoded.bin
  const candidates = [agent.id, agent.id.replace(/-acp$/u, ""), name.split("/").at(-1) ?? name]
  const bin =
    candidates.find((candidate) => bins[candidate] !== undefined) ??
    (Object.keys(bins).length === 1 ? Object.keys(bins)[0] : undefined)
  if (bin === undefined) {
    throw new Error("Registry npm executable ambiguous")
  }
  const command = await realpath(path.join(directory, "npm", "bin", bin))
  if (!relative(await realpath(directory), command)) {
    throw new Error("Registry npm executable escaped installation")
  }
  return {
    command,
    args: distribution.args ?? [],
    env: { ...distribution.env, PATH: `${runtime}:${process.env.PATH ?? ""}` },
    integrity: `npm:${distribution.package}`,
  }
}
const packageInstall = async (
  agent: RegistryAgent,
  selection: RegistrySelection,
  directory: string,
  runtime: string,
) => {
  if (selection.distribution === "npx") {
    return await npmInstall(agent, directory, runtime)
  }
  const distribution = agent.distribution.uvx
  if (distribution === undefined) {
    throw new Error("Registry Python distribution unavailable")
  }
  const environment = {
    ...process.env,
    UV_TOOL_DIR: path.join(directory, "python"),
    UV_TOOL_BIN_DIR: path.join(directory, "bin"),
  }
  await run(["uv", "tool", "install", "--force", distribution.package], environment)
  const identity = distribution.package.replace("==", "@").split("@")
  const tools = await run(["uv", "tool", "list"], environment)
  if (
    !tools
      .split("\n")
      .some(
        (line) =>
          line.startsWith(`${identity[0]} v${identity[1]} `) ||
          line === `${identity[0]} v${identity[1]}`,
      )
  ) {
    throw new Error("Registry Python pin mismatch")
  }
  const bins = await readdir(environment.UV_TOOL_BIN_DIR)
  const bin =
    [agent.id, agent.id.replace(/-acp$/u, ""), identity[0]].find(
      (name) => name !== undefined && bins.includes(name),
    ) ?? (bins.length === 1 ? bins[0] : undefined)
  if (bin === undefined) {
    throw new Error("Registry Python executable ambiguous")
  }
  const command = path.join(environment.UV_TOOL_BIN_DIR, bin)
  if (!relative(await realpath(directory), await realpath(command))) {
    throw new Error("Registry Python executable escaped installation")
  }
  return {
    command,
    args: distribution.args ?? [],
    env: distribution.env ?? {},
    integrity: `uv:${distribution.package}`,
  }
}
const installing = new Map<string, Promise<InstalledAgent>>()
export const installRegistryAgent = async (
  state: string,
  input: RegistrySelection,
  runtime: string,
) => {
  const selection = Schema.decodeUnknownSync(RegistrySelection)(input)
  const key = JSON.stringify([state, selection])
  const existing = installing.get(key)
  if (existing !== undefined) {
    return await existing
  }
  const install = (async () => {
    const index = await Effect.runPromise(fetchRegistry())
    const agent = index.agents.find((candidate) => candidate.id === selection.agentId)
    if (agent === undefined || agent.version !== selection.version) {
      throw new Error("Registry selection changed; refresh")
    }
    const target = registryTarget(process.platform, process.arch)
    if (target === null) {
      throw new Error("Registry platform unavailable")
    }
    const ready = await installedAgent(state, selection)
    if (ready !== null) {
      return ready
    }
    const directory = installDirectory(state, selection, target)
    await mkdir(path.dirname(directory), { recursive: true })
    const lock = `${directory}.lock`
    // A folder there is a lock from before locks were held by a process: its taker is gone.
    if (statSync(lock, { throwIfNoEntry: false })?.isDirectory() === true) {
      await rm(lock, { recursive: true, force: true })
    }
    const releaseLock = await acquireInstall(
      lock,
      `${selection.agentId} installation already running`,
    )
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      const launch =
        selection.distribution === "binary"
          ? await binaryInstall(agent, target, directory)
          : await packageInstall(agent, selection, directory, runtime)
      const receipt = { ...selection, target, ...launch }
      writeFileAtomic(path.join(directory, "receipt.json"), JSON.stringify(receipt))
      return receipt
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    } finally {
      await releaseLock()
    }
  })()
  installing.set(key, install)
  void install
    .finally(() => {
      installing.delete(key)
    })
    .catch(() => {
      /* empty */
    })
  return await install
}
