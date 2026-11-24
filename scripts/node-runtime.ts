// An official, checksum-verified Node runtime makes SDK workers independent of the host's PATH.
import { chmod, mkdir, rm } from "node:fs/promises"
import path from "node:path"

const VERSION = "v22.23.5"
export const stageNode = async (destination: string, platform: string, architecture: string) => {
  const os = platform === "win32" ? "win" : platform
  if (!["darwin", "linux", "win"].includes(os) || !["arm64", "x64"].includes(architecture)) {
    throw new Error("Unsupported SDK runtime platform")
  }
  const stem = `node-${VERSION}-${os}-${architecture}`
  const filename = `${stem}.${os === "win" ? "zip" : "tar.gz"}`
  const base = `https://nodejs.org/dist/${VERSION}`
  const sums = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) })
  if (!sums.ok) {
    throw new Error("Node checksums unavailable")
  }
  const text = await sums.text()
  const expected = text
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === filename)?.[0]
  if (expected === undefined || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error("Node checksum missing")
  }
  const archive = path.join(destination, filename)
  await mkdir(destination, { recursive: true })
  const response = await fetch(`${base}/${filename}`, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || response.body === null) {
    throw new Error("Node download failed")
  }
  const bytes: ReadableStream<Uint8Array> = response.body
  const writer = Bun.file(archive).writer()
  const hash = new Bun.CryptoHasher("sha256")
  let size = 0
  try {
    for await (const chunk of bytes) {
      size += chunk.length
      if (size > 128 * 1024 * 1024) {
        throw new Error("Node archive exceeds 128 MiB")
      }
      hash.update(chunk)
      void writer.write(chunk)
    }
    await writer.end()
    if (hash.digest("hex") !== expected) {
      throw new Error("Node archive checksum mismatch")
    }
    const binary = path.join(destination, os === "win" ? "node.exe" : "node")
    const member = `${stem}/${os === "win" ? "node.exe" : "bin/node"}`
    const child = Bun.spawn(
      [
        "python3",
        "-c",
        `import sys,tarfile,zipfile,shutil,os,pathlib
archive,member,target=sys.argv[1:]
if archive.endswith('.zip'):
 with zipfile.ZipFile(archive) as z, z.open(member) as src, open(target,'wb') as dst: shutil.copyfileobj(src,dst)
else:
 with tarfile.open(archive) as t:
  m=t.getmember(member)
  if not m.isfile() or m.size > 128*1024*1024: raise ValueError('Invalid Node binary')
  with t.extractfile(m) as src, open(target,'wb') as dst: shutil.copyfileobj(src,dst)
  prefix=member.split('/')[0]+'/lib/node_modules/npm/'
  for entry in t:
   if not entry.name.startswith(prefix): continue
   suffix=pathlib.PurePosixPath(entry.name[len(prefix):])
   if '..' in suffix.parts or suffix.is_absolute(): raise ValueError('Unsafe npm runtime')
   output=os.path.join(os.path.dirname(target),'npm',*suffix.parts)
   if entry.isdir(): os.makedirs(output,exist_ok=True)
   elif entry.isfile():
    os.makedirs(os.path.dirname(output),exist_ok=True)
    with t.extractfile(entry) as src, open(output,'wb') as dst: shutil.copyfileobj(src,dst)
   else: raise ValueError('Unexpected npm runtime link')
`,
        archive,
        member,
        binary,
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    if ((await child.exited) !== 0) {
      throw new Error("Node extraction failed")
    }
    await chmod(binary, 0o755)
    await Bun.write(path.join(destination, "node-version"), VERSION)
  } finally {
    await writer.end()
    await rm(archive, { force: true })
  }
}
