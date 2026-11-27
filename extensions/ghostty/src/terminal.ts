// Terminal, where Ghostty isn't: a `.command` file Terminal opens in a window of its own, which
// asks for no Automation. It goes to the folder, then runs the command, or (without `run`) puts it
// at a prompt to edit, waiting for ↵; either way a login shell stays open there after it.
import { mkdtemp, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Effect } from "effect"

/** A value as one single-quoted word for zsh. */
const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** The script Terminal runs: it removes itself first, then does the rest. */
export const commandFile = (command: string, cwd: string | undefined, run: boolean) =>
  [
    "#!/bin/zsh",
    'rm -f -- "$0"; rmdir -- "$0:h" 2>/dev/null; print -n "\\e[H\\e[2J\\e[3J"',
    cwd !== undefined && cwd !== ""
      ? `cd -- ${cwd === "~" || cwd.startsWith("~/") ? `"$HOME"${quoted(cwd.slice(1))}` : quoted(cwd)} || exit 1`
      : "",
    `cmd=${quoted(command)}`,
    run ? 'print -r -- "% $cmd"' : 'vared -p "%~ %# " cmd || exec "$SHELL" -l',
    'eval "$cmd"',
    'exec "$SHELL" -l',
    "",
  ]
    .filter((l, i, all) => l !== "" || i === all.length - 1)
    .join("\n")

/** Opens the command in a new Terminal window. */
export const open = (command: string, cwd: string | undefined, run: boolean) =>
  Effect.tryPromise({
    try: async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "switch-ghostty-"))
      const file = path.join(dir, "Switch.command")
      await writeFile(file, commandFile(command, cwd, run))
      await chmod(file, 0o700)
      const proc = Bun.spawn(["/usr/bin/open", "-a", "Terminal", file], {
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
      })
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      if (code !== 0) {
        throw new Error(err.trim() || `open ${code}`)
      }
      return { terminal: null, app: "Terminal" }
    },
    catch: (e) => (e instanceof Error ? e.message : String(e)),
  })
