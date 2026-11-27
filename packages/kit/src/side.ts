// An extension's side thread: a real thread of the agent's in a space, which the extension asks in
// (`Switch.ask`) and its words go back to, never into the space's chat. Its id says whose it is, the
// space it's in and the extension's own key for it, `side:<extension>:<space>:<key>`, so nothing
// else records them. An event of the extension's about one names it in `side`: the thread's own
// record speaks for it, so the event has no line of its own in the agent's context.

export const SIDE = "side:"

const KEY = /^[\w.-]{1,64}$/u
const ID = /^side:(?<app>[\w-]+):(?<space>[^:\s]+):(?<key>[\w.-]{1,64})$/u

/**
 * The side thread of `app`'s `key` in `space` (a space's id: Home's is `home`), or null when the key
 * can't name one: 1 to 64 letters, digits, `_`, `.` or `-`.
 */
export const sideThread = (app: string, space: string, key: string): string | null =>
  KEY.test(key) ? `${SIDE}${app}:${space}:${key}` : null

/** Whose side thread a thread is, its space and its key; null for any other thread. */
export const sideOfThread = (
  thread: string,
): { readonly app: string; readonly space: string; readonly key: string } | null => {
  const m = ID.exec(thread)?.groups
  return m?.app === undefined || m.space === undefined || m.key === undefined
    ? null
    : { app: m.app, space: m.space, key: m.key }
}
