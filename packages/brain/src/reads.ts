// Reads of the brain, by name, so they can run anywhere the brain's file can be opened: in the
// core's reader threads (readers.ts), off its event loop, where a read of cold pages on a busy disk
// holds only its own caller (Nov 24: 1 to 76 s stalls of the whole core, a read at a time). A read
// is defined once, at a module's top level, and called with its arguments, which cross to the
// reader as structured clones, as its answer does back: plain data, Maps, Sets, arrays, never a
// function or a class's instance.
import type { Database } from "bun:sqlite"

export interface Read<Args extends readonly unknown[], A> {
  readonly name: string
  readonly run: (db: Database, ...args: Args) => A
}

/** A read asked for by name, as it arrives in a reader. */
export interface Asked {
  readonly name: string
  readonly args: readonly unknown[]
}

interface AskedOf<Args extends readonly unknown[]> extends Asked {
  readonly args: Args
}

/** Whether `asked` is for `read`: only its handle sends that name, with the arguments it takes. */
const isAskedOf = <Args extends readonly unknown[]>(
  read: Read<Args, unknown>,
  asked: Asked,
): asked is AskedOf<Args> => asked.name === read.name

const registry = new Map<string, (db: Database, asked: Asked) => unknown>()

/**
 * A read named `name` (its module's, then its own: `triage/open-line`), run as `run(db, ...args)`.
 * A name is defined once: a second definition is a mistake two modules would share.
 */
export const defineRead = <Args extends readonly unknown[], A>(
  name: string,
  run: (db: Database, ...args: Args) => A,
): Read<Args, A> => {
  if (registry.has(name)) {
    throw new Error(`Read ${name} is defined twice`)
  }
  const read = { name, run }
  registry.set(name, (db, asked) => {
    if (!isAskedOf(read, asked)) {
      throw new Error(`${asked.name} isn't ${name}`)
    }
    return run(db, ...asked.args)
  })
  return read
}

/** `asked` run on `db` by the read it names in this thread, or undefined when none has that name. */
export const runAsked = (db: Database, asked: Asked) => {
  const run = registry.get(asked.name)
  return run === undefined ? undefined : { value: run(db, asked) }
}

/** Every read this thread knows, sorted: a reader must know the same as the core it serves. */
export const readNames = () => [...registry.keys()].toSorted()
