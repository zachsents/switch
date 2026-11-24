// The Chrome extension's native messaging host, started by the browser: says which browser it is
// (and which process of it), then relays between the browser's stdio (a 4-byte native-endian
// length, then JSON) and the browser extension's socket, a JSON message a line.
import { connect } from "node:net"

import { CHROMIUM, SOCKET } from "./chrome.ts"

const parent = process.ppid
const exe = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(parent)])
  .stdout.toString()
  .trim()
const found = CHROMIUM.find((b) => exe.includes(`/${b.name}.app/`))

const socket = connect(SOCKET)
socket.setEncoding("utf-8")
socket.on("error", () => process.exit(1))
socket.on("close", () => process.exit(0))

let rest = ""
socket.on("data", (data: string) => {
  const all = (rest + data).split("\n")
  rest = all.pop() ?? ""
  for (const line of all) {
    const body = Buffer.from(line)
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length)
    process.stdout.write(Buffer.concat([head, body]))
  }
})

if (found) {
  socket.write(
    `${JSON.stringify({ type: "browser", name: found.name, bundle: found.bundle, pid: parent })}\n`,
  )
}

let held = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  held = Buffer.concat([held, chunk])
  while (held.length >= 4) {
    const length = held.readUInt32LE(0)
    if (held.length < 4 + length) {
      break
    }
    socket.write(`${held.subarray(4, 4 + length).toString()}\n`)
    held = held.subarray(4 + length)
  }
})
// The browser closed the port: the relay is done.
process.stdin.on("end", () => process.exit(0))
