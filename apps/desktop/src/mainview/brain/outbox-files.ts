// The bytes of files in the outbox (outbox.ts), kept in IndexedDB under each file's id until the
// message they're on is answered: a relaunch mid-upload uploads them again.

const opening = async () => {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
  const r = indexedDB.open("switch.outbox", 1)
  r.addEventListener("upgradeneeded", () => {
    r.result.createObjectStore("files")
  })
  r.addEventListener("success", () => {
    resolve(r.result)
  })
  r.addEventListener("error", () => {
    reject(r.error ?? new Error("No IndexedDB"))
  })
  return await promise
}
const opened = opening()

const run = async <T>(
  mode: IDBTransactionMode,
  ask: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await opened
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const r = ask(db.transaction("files", mode).objectStore("files"))
  r.addEventListener("success", () => {
    resolve(r.result)
  })
  r.addEventListener("error", () => {
    reject(r.error ?? new Error("Didn't keep it"))
  })
  return await promise
}

/** Writes still going, so a read waits on its own window's write. */
const storing = new Map<string, Promise<unknown>>()

export const putFile = async (id: string, file: File) => {
  const p = run("readwrite", (s) => s.put(file, id))
  storing.set(id, p)
  try {
    await p
  } finally {
    if (storing.get(id) === p) {
      storing.delete(id)
    }
  }
}

/** A kept file, or null when it's gone. */
export const getFile = async (id: string) => {
  await storing.get(id)?.catch(() => null)
  const got: unknown = await run("readonly", (s) => s.get(id))
  if (got instanceof File) {
    return got
  }
  return got instanceof Blob ? new File([got], id) : null
}

export const dropFile = async (id: string) => {
  await storing.get(id)?.catch(() => null)
  await run("readwrite", (s) => s.delete(id)).catch(() => null)
}
