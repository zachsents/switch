# switch-ext-t3code

[T3 Code](https://github.com/pingdotgg/t3code)'s threads: an event when an agent's turn ends
(`t3code.turn_finished`, with its last reply) or a thread waits on an answer or an approval
(`t3code.needs_input`), and tools to list threads under way and read one. It also sends into a
thread and starts new ones, each message saying it's from Switch and which space to answer in.
`t3code.heartbeat`, every five minutes and at once when it changes, says whether the watch works.

It reads the T3 Code server on its own machine through T3's MCP endpoint, with a read-only session
it mints with T3's `t3` CLI (`t3 auth session issue`), kept beside its state and renewed before it
expires; writes go through `t3 thread`. Place it on the machine T3 Code runs on.

A [Switch](https://switch.ax) extension, built on
[switch-ext-kit](../../packages/kit).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/t3code`, or add it in the desktop's
Extensions view (⌘K, Extensions).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
