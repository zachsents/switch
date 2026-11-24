// Promises become watches when they're made, as Switchboard's runner kept them (promised.rs).
// Before a turn ends, its closing words (its last text, and what it posted to the user) are read
// for a commitment about later: "I'll", "I will", "I'm going to", in a sentence that isn't a
// question or an offer. When there's one and the turn set nothing that brings its work back (an
// expectation, an action item, a follow, a task), it gets one line back, once. The model that
// made the promise sets the watch, with everything it knows.

/** How many of its commitments the line back quotes, and how much of each. */
const QUOTED = 3
const QUOTE_CHARS = 240

/** What in a sentence says I'll do something later. */
const FUTURE = ["i'll ", "i will ", "i'm going to ", "i am going to ", "i plan to ", "i intend to "]

/**
 * What makes a sentence with one of those an offer, a question to the user, a decision not to
 * act, or what I'm doing this moment, rather than a commitment left for later.
 */
const NOT_A_COMMITMENT = [
  "if you want",
  "if you'd like",
  "if you like",
  "if you prefer",
  "if you say",
  "want me to",
  "should i ",
  "let me know",
  "just say",
  "say the word",
  "happy to",
  "i'll leave",
  "i won't",
  "i will not",
  "i'll stop",
  "i'll hold off",
  "i'll defer",
  "i'll start by",
  "i'll begin by",
  "i'll now ",
  "i'll first",
  "i'll do that now",
  "i'll take a look now",
]

/** The tools that bring a turn's work back on their own. */
const WATCHES = new Set([
  "autonomy_expect",
  "autonomy_action_item",
  "autonomy_follow_item",
  "delegate_task",
  "task_steer",
])

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`)

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A call's tool as the agent named it: through the gateway's `call_tool`, or an MCP tool's own name. */
const toolOf = (name: string, input: unknown) => {
  if (name.endsWith("call_tool")) {
    return isRecord(input) && typeof input.name === "string" ? input.name : ""
  }
  return name.split("__").at(-1) ?? name
}

/** Whether a call brings this work back later on its own. */
export const setsWatch = (name: string, input: unknown) => WATCHES.has(toolOf(name, input))

/**
 * The calls that end a turn on an explicit choice: saying something, reacting, putting up an item,
 * showing something in the chat, or choosing nothing. His words: "I want things said to me to be
 * explicit … if it literally doesn't do anything, it has to use the explicit `do nothing` tool call.
 * Otherwise it gets an automatic error back to it."
 */
const CHOICES = new Set([
  "autonomy_say",
  "autonomy_nothing",
  "brain_react",
  "autonomy_action_item",
  "brain_show_widget",
])

/** Whether a call is an explicit choice to end on (agent-made UI shown in the chat counts too). */
export const choosesEnd = (name: string, input: unknown) => {
  const tool = toolOf(name, input)
  return CHOICES.has(tool) || tool.endsWith("_show")
}

/** The error back to a turn that ended without an explicit choice. */
export const UNCHOSEN =
  "You ended this turn without an explicit choice. End it on one: say what the user should hear (say), react to their message, put up an item, or call nothing if there's nothing for them."

/** The error back to a turn answering the user's words that ended on plain text without a choice. */
export const UNSAID =
  "Your last words reached no one: plain text isn't shown to the user. To answer them, call say with those words now; otherwise react, put up an item, or call nothing."

/** What a call said to the user, if it said anything. */
export const posted = (name: string, input: unknown) => {
  if (toolOf(name, input) !== "autonomy_say" || !isRecord(input)) {
    return ""
  }
  const args = isRecord(input.arguments) ? input.arguments : input
  return typeof args.text === "string" ? args.text : ""
}

/**
 * `text` with what it quotes taken out (code, and words in double quotes), so a command, a query
 * or someone else's words aren't read as mine.
 */
const unquoted = (text: string) => {
  const out: string[] = []
  let fence = false
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fence = !fence
      continue
    }
    if (fence) {
      continue
    }
    let code = false
    let quote = false
    let kept = ""
    for (const c of line) {
      if (c === "`") {
        code = !code
      } else if (!code && (c === '"' || c === "“" || c === "”")) {
        quote = !quote
      } else if (!code && !quote) {
        kept += c
      }
    }
    out.push(kept)
  }
  return out.join("\n")
}

/** Sentences: split at the end of one (". ", "! ", "? ") and at each line, so a list's items stand alone. */
const sentences = (text: string) =>
  text.split("\n").flatMap((raw) => {
    const line = raw
      .trim()
      .replace(/^[-*•>]+/u, "")
      .trim()
    return line
      .split(/(?<=[.!?])\s+/u)
      .map((s) => s.trim())
      .filter((s) => s !== "")
  })

/** The sentences in `text` that commit me to doing something later. */
export const commitments = (text: string) =>
  sentences(unquoted(text.replaceAll(/[‘’]/gu, "'")))
    .filter((s) => {
      // Punctuation as spaces, so "I will." reads as "i will ".
      const lower = ` ${s.toLowerCase()} `.replaceAll(/[.,!;:()]/gu, " ")
      return (
        !s.endsWith("?") &&
        FUTURE.some((f) => lower.includes(` ${f}`)) &&
        !NOT_A_COMMITMENT.some((n) => lower.includes(n))
      )
    })
    .map((s) => clip(s, QUOTE_CHARS))

/** The line a turn gets back for what it said it would do later. */
export const nudge = (said: readonly string[]) =>
  `Before you end: you said ${said
    .slice(0, QUOTED)
    .map((s) => `"${s}"`)
    .join(
      " and ",
    )}. Nothing in this turn brings you back for it. If that's for later, set a watch for it now, so it happens: autonomy expect, with \`when\` (a query that finds it happening) and \`by\` (the latest it may come), or \`promise\` and \`by\` for something you'll do at a time; an action item or a follow if it waits on the user. If it's done already, no longer wanted, or an expectation already open covers it, end now without writing anything.`
