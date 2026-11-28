// The old core machine's addresses, once the core has moved to another: each port it served (the
// core's, the pages', the feeds') forwarded to the same port on the new one, byte for byte, so the
// links already out (published pages, the apps' and hosts' configured address) keep working.
//   bun scripts/forward.ts <to host> <listen>=<port> …
// <listen> is host:port (like 0.0.0.0:4871, or 127.0.0.1:4872 behind Tailscale Serve); <port> is
// the one it reaches on <to host>. The new core sees the forwarded connections as from this machine,
// a tailnet peer: a request with no credential keeps only what a peer has, never loopback's.
import type { Socket } from "bun"

const [to, ...pairs] = process.argv.slice(2)
if (to === undefined || pairs.length === 0) {
  console.error("usage: bun scripts/forward.ts <to host> <host:port>=<port> …")
  process.exit(2)
}

/** One side of a forwarded connection: the other side, and what it couldn't take yet. */
interface Side {
  peer: Socket<Side> | null
  /** What came before the other side was open. */
  early: Uint8Array[]
  /** What this side's socket hasn't taken yet, written as it drains. */
  queue: Uint8Array[]
  ending: boolean
}

const side = (): Side => ({ peer: null, early: [], queue: [], ending: false })

/** Written in order, whatever the socket can't take now kept for its drain. */
const send = (s: Socket<Side>, chunk: Uint8Array) => {
  if (s.data.queue.length > 0) {
    s.data.queue.push(chunk)
    return
  }
  const n = s.write(chunk)
  if (n < chunk.byteLength) {
    s.data.queue.push(chunk.subarray(Math.max(n, 0)))
  }
}

const drain = (s: Socket<Side>) => {
  while (s.data.queue.length > 0) {
    const [chunk] = s.data.queue
    if (chunk === undefined) {
      break
    }
    const n = s.write(chunk)
    if (n < chunk.byteLength) {
      s.data.queue[0] = chunk.subarray(Math.max(n, 0))
      return
    }
    s.data.queue.shift()
  }
  if (s.data.ending) {
    s.end()
  }
}

/** Ended once what it still holds is written. */
const finish = (s: Socket<Side> | null) => {
  if (s === null) {
    return
  }
  if (s.data.queue.length === 0) {
    s.end()
  } else {
    s.data.ending = true
  }
}

const relay = {
  data(s: Socket<Side>, chunk: Uint8Array) {
    const copy = new Uint8Array(chunk)
    if (s.data.peer === null) {
      s.data.early.push(copy)
    } else {
      send(s.data.peer, copy)
    }
  },
  drain,
  close(s: Socket<Side>) {
    finish(s.data.peer)
  },
  error(s: Socket<Side>) {
    finish(s.data.peer)
  },
}

for (const pair of pairs) {
  const [listen = "", port = ""] = pair.split("=")
  const at = listen.lastIndexOf(":")
  const hostname = listen.slice(0, at)
  const listenPort = Number(listen.slice(at + 1))
  const toPort = Number(port)
  Bun.listen<Side>({
    hostname,
    port: listenPort,
    socket: {
      ...relay,
      open(client) {
        client.data = side()
        void Bun.connect<Side>({
          hostname: to,
          port: toPort,
          socket: {
            ...relay,
            open(upstream) {
              upstream.data = { ...side(), peer: client }
              client.data.peer = upstream
              for (const chunk of client.data.early) {
                send(upstream, chunk)
              }
              client.data.early = []
            },
            connectError() {
              client.end()
            },
          },
        }).catch(() => client.end())
      },
    },
  })
  console.log(`${hostname}:${listenPort} → ${to}:${toPort}`)
}
