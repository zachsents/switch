// What becomes of each kind of Switchboard record: the Switch events it turns into, or why it's
// left behind. Every kind comes over but work leases and credentials. The first rule that matches
// a record's stream and kind decides.

/** Where a record goes: `work` and the read models are converted on their own. */
export type Route =
  | "work"
  | "device"
  | "app"
  | "ui"
  | "owner"
  | { readonly drop: string }
  | { readonly fold: string }

interface Rule {
  readonly stream: RegExp
  readonly kinds?: readonly string[]
  readonly route: Route
  /** The Switch side, for the inventory. */
  readonly as: string
}

const drop = (why: string) => ({ drop: why })
const fold = (into: string) => ({ fold: into })

const WORK = /^work\//u

export const RULES: readonly Rule[] = [
  { stream: WORK, kinds: ["work"], route: "work", as: "thread.opened" },
  { stream: WORK, kinds: ["part"], route: "work", as: "message.posted + message.read" },
  { stream: WORK, kinds: ["message"], route: "work", as: "message.posted" },
  { stream: WORK, kinds: ["turn"], route: "work", as: "turn.started / turn.ended" },
  { stream: WORK, kinds: ["tool"], route: "work", as: "turn.tool + turn.result" },
  { stream: WORK, kinds: ["aside"], route: "work", as: "turn.text" },
  { stream: WORK, kinds: ["injected"], route: "work", as: "turn.injected (steer)" },
  { stream: WORK, kinds: ["noticed"], route: "work", as: "turn.injected (wake)" },
  { stream: WORK, kinds: ["report"], route: "work", as: "task.ended" },
  {
    stream: WORK,
    kinds: ["steer", "woken"],
    route: fold("the text of the turn it started, or of its injection"),
    as: "folded",
  },
  {
    stream: WORK,
    kinds: ["heard", "placed"],
    route: fold("bookkeeping: turns carry steers; a work's space is where it was placed"),
    as: "folded",
  },
  { stream: WORK, route: "app", as: "app.observed" },
  { stream: /^workspaces$/u, route: "app", as: "app.observed (spaces from the read model)" },
  {
    stream: /^memory$/u,
    kinds: ["memory", "attribution"],
    route: fold("memory.imported, from the memories read model"),
    as: "memory.imported",
  },
  {
    stream: /^memory$/u,
    kinds: ["expectation"],
    route: fold("expectation.imported for those still open (watches)"),
    as: "expectation.imported",
  },
  { stream: /^memory$/u, kinds: ["feedback"], route: "ui", as: "ui.observed" },
  { stream: /^memory$/u, route: "app", as: "app.observed" },
  { stream: /^owner$/u, kinds: ["message"], route: "owner", as: "message.posted (unfiled only)" },
  {
    stream: /^claims$/u,
    route: drop("work leases: a work's id and when its lease ends, renewed as it runs"),
    as: "dropped",
  },
  {
    stream: /^(?:secrets|google\/oauth)$/u,
    route: drop("credentials: Switch keeps them in the Keychain, never the brain"),
    as: "dropped",
  },
  {
    stream:
      /^(?:vitals\/|devices$|appendages$|claude\/|load\/|upkeep\/|builds\/|ci\/runners$|archive\/drives$|health$|crashes\/)/u,
    route: "device",
    as: "device.observed",
  },
  {
    stream: /^(?:seen$|moments$|focus\/|attention\/|watching$|search$)/u,
    route: "ui",
    as: "ui.observed",
  },
  { stream: /./u, route: "app", as: "app.observed" },
]

export const ruleOf = (stream: string, kind: string): Rule => {
  for (const r of RULES) {
    if (r.stream.test(stream) && (r.kinds === undefined || r.kinds.includes(kind))) {
      return r
    }
  }
  return { stream: /./u, route: "app", as: "app.observed" }
}

/** Why a record isn't brought in, or "" when it is. */
export const whyOf = (route: Route) => {
  if (typeof route === "string") {
    return ""
  }
  return "drop" in route ? route.drop : route.fold
}

/** Streams in groups, for counting: one line for all of `work/…`, every Mac's vitals, … */
export const groupOf = (stream: string) =>
  stream
    .replace(/^(?<head>work|requests|vitals|summary|thread|screens)\/.*/u, "$<head>/*")
    .replace(/@.*/u, "@*")

/** Streams worth reading at all: work and memory are read on their own, and some are all dropped. */
export const wanted = (stream: string) => {
  if (stream.startsWith("work/") || stream === "memory") {
    return false
  }
  const whole = RULES.find((r) => r.kinds === undefined && r.stream.test(stream))
  return whole === undefined || typeof whole.route === "string"
}
