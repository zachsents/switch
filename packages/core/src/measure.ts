// Reflection's measures (autonomy's measures.ts) read in a child of the core: `switch measure
// <brain>` opens the brain read-only and prints them. A second or more of reading on a busy brain,
// which the core's thread can't give.
import { Database } from "bun:sqlite"
import { yielding } from "@switch/agent"
import { measures } from "@switch/autonomy/measures"
import { Effect } from "effect"

/** This build run again: the compiled `switch`, else bun on its main.ts. */
const self = Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]

/** `switch measure <brain>`. */
export const measure = ([brain = ""]: readonly string[]) => {
  const db = new Database(brain, { readonly: true })
  process.stdout.write(measures(db, Date.now()))
  db.close()
}

/** The measures now, from a child that gives way to the core. */
export const measured = (brain: string) =>
  Effect.tryPromise(async () => {
    const child = Bun.spawn(yielding([...self, "measure", brain]), {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, said] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if ((await child.exited) !== 0) {
      throw new Error(`Measures failed: ${said.trim().split("\n").at(-1) ?? ""}`)
    }
    return out
  })
