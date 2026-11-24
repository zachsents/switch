// A core's health, for the deploy (scripts/ship.sh): the sync snapshot, the widgets, and with
// --turn a real message turn in a space of its own. No imports, so any bun runs it from a release.
//   bun health.ts <core url> [--turn]
// Prints what it checked and exits 0, or says what failed and exits 1.
const [base = "http://127.0.0.1:4871", ...flags] = process.argv.slice(2)
const withTurn = flags.includes("--turn")
// A core just started on a full brain can stall its loop for 10-15 s as it catches up.
const SNAPSHOT_MS = 45_000
const TURN_MS = 180_000

type Frame = Record<string, unknown>

const fail = (why: string): never => {
  console.error(`unhealthy: ${why}`)
  process.exit(1)
}

const isFrame = (v: unknown): v is Frame => typeof v === "object" && v !== null
const parse: (text: string) => unknown = JSON.parse
/** Fails after `ms` unless the returned function is called first. */
const after = (ms: number, why: string) => {
  const timer = setTimeout(() => {
    fail(why)
  }, ms)
  return () => {
    clearTimeout(timer)
  }
}

const receipts = new Map<string, (f: Frame) => void>()
const listeners: ((e: Frame) => void)[] = []
const snapshot = Promise.withResolvers<number>()

const url = new URL(base)
url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
url.searchParams.set("source", "health")
const ws = new WebSocket(url)
ws.addEventListener("error", () => {
  fail("sync: socket error")
})
ws.addEventListener("message", (m) => {
  const f = parse(String(m.data))
  if (!isFrame(f)) {
    return
  }
  if (f.type === "snapshot" && typeof f.seq === "number" && isFrame(f.state)) {
    snapshot.resolve(f.seq)
  }
  if ((f.type === "receipt" || f.type === "rejected") && typeof f.id === "string") {
    receipts.get(f.id)?.(f)
  }
  if (f.type === "events" && Array.isArray(f.events)) {
    for (const e of f.events) {
      if (isFrame(e)) {
        for (const listen of listeners) {
          listen(e)
        }
      }
    }
  }
})

const started = Date.now()
const settled = after(SNAPSHOT_MS, "sync: no snapshot")
const seq = await snapshot.promise
settled()
console.log(`snapshot at seq ${seq} in ${Date.now() - started} ms`)

const getJson = async (path: string): Promise<unknown> => {
  const r = await fetch(new URL(path, base)).catch(() => null)
  if (r === null) {
    return fail(`${path}: unreachable`)
  }
  if (!r.ok) {
    return fail(`${path}: HTTP ${r.status}`)
  }
  const body: unknown = await r.json()
  return body
}

const list = await getJson("/widgets")
const widgets = Array.isArray(list) ? list.filter(isFrame) : fail("widgets: not a list")
const [first] = widgets
if (first !== undefined) {
  await getJson(`/widgets/${String(first.app)}/${String(first.name)}`)
}
console.log(`${widgets.length} widgets`)

const command = async (type: string, payload: unknown) => {
  const id = crypto.randomUUID()
  const done = Promise.withResolvers<Frame>()
  receipts.set(id, done.resolve)
  ws.send(JSON.stringify({ type: "command", id, command: type, payload }))
  const f = await done.promise
  if (f.type !== "receipt") {
    fail(`${type}: ${String(f.reason)}`)
  }
}

if (withTurn) {
  // Its own space, so the turn starts a fresh session and touches no other thread.
  const space = `canary-${Date.now()}`
  const reply = Promise.withResolvers<string>()
  listeners.push((e) => {
    const p = isFrame(e.payload) ? e.payload : {}
    if (e.type === "message.posted" && e.source === "agent" && p.space === space) {
      reply.resolve(String(p.text))
    }
  })
  await command("space.create", { id: space, name: "Canary", parent: null })
  const asked = Date.now()
  after(TURN_MS, `no reply in ${TURN_MS / 1000} s`)
  // A question with a real answer: a bare "reply ok" reads as an acknowledgement, which the agent
  // may answer with a reaction or nothing, and no message comes back.
  await command("message.post", { space, text: "What is 2 + 2? Answer with just the number." })
  const text = await reply.promise
  console.log(`turn replied "${text.slice(0, 40)}" in ${Date.now() - asked} ms`)
}

ws.close()
process.exit(0)
