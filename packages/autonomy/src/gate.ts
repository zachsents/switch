// The checks: one decision model reading what the agent does, with criteria for each. Each check is
// declared once below (CHECKS): where it reads, its questions, whether it blocks or comes after,
// and its models. A blocking check reads a reply, an action item, a memory or a call that speaks
// for the user before it goes, one probability per criterion. When none passes its threshold, it
// goes. When one does, it goes back with the reason; sent again with `bypass`, a line on why the
// check is wrong this time, it goes on with the objection (brain's bypass.ts), so a check never
// stalls work. What a withholding criterion catches (a secret) never goes. An after check reads a
// message once it's in the user's chat, so it never slows a reply; when one of its criteria passes,
// a fix turn revises the message in place (after.ts). Each decision is kept, and scored later by
// what came of it; thresholds stay where code, the agent or the user put them: the user, Nov 23,
// let the tuner that lowered them go ("as you wish"), since nearly every bounce came back changed
// and so read as heeded. A bypass answers a refusal of the same work in the
// last hour, and is judged before it goes (bypass.ts). The checks stay in code; the user's rules reach
// every one. An expectation is read before it's set, for what a plain rule in code can't tell:
// expect (app.ts) refuses a wait with no watch, no ask of theirs to hang on and no cited time
// before it gets here. One rule needs no model: a blocking check refuses an em dash in the agent's
// own words before it reads them (brain's dashes.ts).
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  ANSWERS_MS,
  Brain,
  bypassEvent,
  bypassOf,
  defineEvent,
  EARLY,
  emDashRefusal,
  EventId,
  on,
  SpaceId,
  TurnId,
} from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Models } from "@switch/models"
import type { Question, Role, Tier } from "@switch/models"
import { Context, Effect, Layer, Option, Schema } from "effect"

import { judge } from "./bypass.ts"
import type { Judgment } from "./bypass.ts"
import { storedDial } from "./dial-values.ts"
import { field, jsonOf, list, text as said } from "./json.ts"

export const EXIT_NAMES = [
  "reply",
  "report",
  "item",
  "memory",
  "outbound",
  "links",
  "expect",
] as const
export type Exit = (typeof EXIT_NAMES)[number]

interface Criterion {
  readonly name: string
  readonly ask: string
  /** Acts at or above this probability, unless a dial moves it. */
  readonly at: number
  readonly reason: string
  readonly withholds?: boolean
  /** A question what it reads must pass: it acts below `at`, on a no. */
  readonly must?: boolean
  /** Asked of one of the user's rules: acts only when a second look quotes the words that break it. */
  readonly rule?: string
  /** A dial of the user's (settings.ts, `gate.<exit>.<name>`): its name to them. */
  readonly dial?: string
}

const GUIDE =
  "You are the gate of Switch, the user's personal agent. Before something leaves (a reply to the user, an action item " +
  "put in their queue, a memory kept for good, a tool call that sends something in their name, an expectation that parks work until later) you answer a few questions about it from what's shown. " +
  "The user's rules and preferences, when listed, say how they want these questions read. Be " +
  "calibrated: say a question is true only as far as what's shown supports it. When unclear, lean to false: " +
  "a wrong objection costs a round trip."

// Switchboard's, word for word (monologue/src/kernels/builtin.rs:88-95). It names the lesson: asked
// of "it", with the memories already held shown beside it, it read those too, and refused harmless
// lessons beside a held one with an order or product number (0.94 on Luna; 0.06 named).
const SECRET: Criterion = {
  name: "secret",
  ask: "Does this lesson contain a secret's value itself (the characters of a password, an API key or token, a one-time code, a card number, or a passport or identity number), rather than only saying that a secret exists or where it's kept?",
  at: 0.5,
  reason: "It holds a secret, which is never kept.",
  withholds: true,
}

/**
 * Asked of what a turn the agent started itself would say: his words, "as long as we have a rule …
 * that just makes sure that it's not just saying meaningless nothing (just because it feels like it
 * should), then I think we're good." Measured on Luna over what woken turns said Nov 20-22 (122
 * messages, 67 opening "Nothing…"): at .7 it stops 60 of the 67 (the 7 it lets by go on to news
 * after their opening) and 3 of the other 55 (a "no reply this time, the watch is still set"; a
 * task restarted after a host restart; a send scope set up); at .5 it would also stop a real printer
 * alarm.
 */
export const FILLER: Criterion = {
  name: "filler",
  ask: 'Is this filler rather than something the user needs or would want to hear now: "nothing needs you", status narration or an acknowledgement, rather than a result, a decision or a real question?',
  at: 0.7,
  reason: "Nothing here needs saying: end with `nothing`.",
}

/**
 * Asked of what work the senses woke would say. Switchboard ran that work apart, and its say refused
 * every word of it (core/context.rs:811-815, sb/mcp.rs:472-481: "what needs them goes in their queue,
 * prepared, and when nothing does, end without a word"); here only news they need now goes. Measured
 * on Luna with the reply's own questions over every say from a sensed turn since say was let in there
 * (Nov 22-23: 5 posted, 5 of their bounced drafts), all of which Switchboard refused: it lets 1 of the
 * 10 by (a client's weekly call series cancelled, 0.89), the other 9 at 0.11 or under. Alone, over the
 * 122 messages turns the agent started said Nov 20-22: 0 of 67 "Nothing…" and 0 of the other 55
 * reach 0.5. Made-up news that needs them now: a flight tonight cancelled .99, a client's reply
 * moving a meeting .96, a card frozen .90; a print that can't make its pickup .44 (an ask).
 */
export const NEWS: Criterion = {
  name: "news",
  ask: 'Is this news the user needs to hear now, from work they did not start: something of theirs failed, was cancelled, is at risk or changed in a way that changes what they do today, or someone they deal with just answered or asked them something? Not a result or progress of the agent\'s own work, a fix or problem in Switch or its apps, a note about an item already in their queue, a step for them to take (that goes in their queue), or "nothing needs you".',
  at: 0.5,
  must: true,
  reason:
    "This turn your senses woke isn't part of your conversation with the user, so only news they need now reaches them: what needs them goes in their queue, prepared, and when nothing does, end with `nothing`.",
}

interface Check {
  /**
   * Where it reads: a reply before it ends its turn (hooks.ts), an action item before it opens, a
   * memory before it's kept, a call that speaks for the user before it runs, or a message of the
   * agent's once it's in the user's chat (after.ts).
   */
  readonly point: "reply" | "report" | "item" | "memory" | "outbound" | "message" | "expect"
  /**
   * "block": what it reads waits for its answer and goes back with its objections; "after": what it
   * reads is out already, and a fix turn revises it in place when a criterion passes.
   */
  readonly mode: "block" | "after"
  readonly what: string
  /** The role that answers its questions; an after check's fix turn runs on `fix`, a tier. */
  readonly models: { readonly questions: Role; readonly fix?: Tier }
  readonly criteria: readonly Criterion[]
  /** An after check's fix turn: what it's asked to do. */
  readonly fix?: string
}

/** What an after check's fix turn is told; the message and what it needs follow (after.ts). */
const LINK_FIX = `A message of mine is in the user's chat already (below). It names things it doesn't link. Link each one whose page you can find, as a Wikipedia article links what it names: the words in the message that name it become the link.
- Take each link from what I read when I wrote it (listed below, when there's any), or look it up with your tools: the record it comes from in the brain (its link or url, or a link in its source, like an order email's own links), or a space, task or action item here (a row's link). Never make one up.
- The user's rules, when listed, say what they want linked.
- You only look things up: never send, change or open anything.

Reply with JSON only: {"links": [{"words": "<words in the message that name it, exactly as they are there>", "url": "<its link>"}]}, or {"links": []} when you found none.`

// What needs their hands is an ask, in the turn that finds it (Switchboard's context.rs:768,
// "What needs their hands is an ask"; sb/mcp.rs:2567, "not a report"). The user, Nov 22, on a
// setting to turn on said in one line of a status message: "it just put the request in a message
// that got buried in chat rather than putting it in my queue."
const HANDS: Criterion = {
  name: "hands",
  ask: "Does it leave the user a step that my work waits on (a setting to change or turn on, a code or a login to enter, something to do at a device, an answer, an approval or a decision) that none of their open items (listed) is for? Not how-to steps or advice they asked for, to do on their own, and not a step an open item already covers.",
  // On 497 of the agent's messages (Nov 19-22), each with the items open then and the user's
  // message before it: 25 at 0.85 and up, mostly a step left to them with no card (a permission
  // prompt, a bot token, a file to AirDrop); the Nov 22 Liveview lines 0.86 and 0.92.
  at: 0.85,
  reason:
    "What needs their hands is an ask: put it in their queue now (action_item), prepared down to the one step left to them, or follow the open item that covers it; then say only what they should hear.",
}

// A cause or an absence said with nothing looked up for it (Switchboard's context.rs:794-795: "A
// search you report as done covers all of the history, not a window you picked, and you say exactly
// what you searched: where, for which words, over what span"). The user, Nov 23, on "no note" about a
// cancelled meeting, "nothing records how" they reach a contact they had thousands of texts with, a
// customer "hasn't replied" said after reading only ads and orders, and "usage limits paused work" with no
// limit in the record. Read against what the turn looked up (`lookedUp`).
export const UNSUPPORTED: Criterion = {
  name: "unsupported",
  ask: "Does it state as found that something in the world or the records doesn't exist or didn't happen (no note, no reply, no way to reach someone, nothing found, none left), or why something happened (what caused it, stopped it, or made it fail or go quiet), when nothing this turn looked up or that came in (listed) shows it: no call read that very thing, or the one that did looked at less than it claims (one channel of several, a window of time, other words)? Not what I am or did myself, and not what the user just told me.",
  // On the four (each with its turn's lookups and what woke it): 0.96 "no note", 0.90 "usage limits
  // paused work", 0.76 the customer "hasn't replied", 0.75 the unreachable contact (a bypass reason,
  // read as a reply). On 60 other says of Nov 21-23, 5 at 0.75 and up: four a cause or absence with no lookup
  // for it, one that said where it had looked (0.80).
  at: 0.75,
  reason:
    "Look it up first (every channel, all of the history, or the thing's own record, logs or status), then say what you searched: where, for which words, over what span. Or say what you saw and that you don't know yet.",
}

const flat = (text: string, n: number) => {
  const one = text.replaceAll(/\s+/gu, " ").trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))

/** A call's line: what it was given, then what came back, or that it failed. */
const callLine = (call: unknown, result: unknown) => {
  const input = field(call, "input")
  const app = said(field(input, "name"))
  const named = said(field(call, "name")).endsWith("call_tool") && app !== ""
  const head = `· ${named ? app : said(field(call, "name"))} ${flat(asText(named ? field(input, "arguments") : input), 160)}`
  if (result === undefined) {
    return head
  }
  return `${head}${field(result, "error") === true ? " failed " : " → "}${flat(asText(field(result, "output")), 300)}`
}

/**
 * What a turn looked up so far, a line per call with what came back, as Switchboard's work view
 * showed a turn's tools (core/context.rs:1081-1086): input cut at 160, what came back at 300. An
 * app's tool reads under its own name. What woke it or joined it (a task's end, a watch, what the
 * senses let through) reads as there (1094: cut at 2,000).
 */
export const lookedUp = (db: Database, turn: string) => {
  const rows = db
    .query<{ body: string }, [string]>(
      `SELECT i.body FROM turn_spans s JOIN thread_items i ON i.thread = s.thread
         AND i.seq BETWEEN s.first AND s.last AND i.turn = s.turn
       WHERE s.turn = ? AND (json_extract(i.body, '$.kind') IN ('tool', 'result', 'wake')
         OR json_extract(i.body, '$.wake') IS NOT NULL) ORDER BY i.seq`,
    )
    .all(turn)
    .map((r): unknown => JSON.parse(r.body))
  const results = new Map(
    rows.filter((b) => field(b, "kind") === "result").map((b) => [said(field(b, "id")), b]),
  )
  return rows
    .filter((b) => field(b, "kind") !== "result")
    .map((b) =>
      field(b, "kind") === "tool"
        ? callLine(b, results.get(said(field(b, "id"))))
        : `· came in: ${flat(said(field(b, field(b, "kind") === "wake" ? "text" : "wake")), 2000)}`,
    )
}

/** Every check, declared once. Only code adds or changes one; the user's rules reach each. */
const CHECKS: Readonly<Record<Exit, Check>> = {
  reply: {
    point: "reply",
    mode: "block",
    models: { questions: "decision" },
    what: "a reply to the user",
    criteria: [
      {
        name: "long",
        // Bypassed 14 times on Nov 23 ("already one sentence"). On 107 replies of Nov 21-23 (all 17
        // bypassed, 60 others it objected to, 30 it passed), labeled blind: at the tuned 0.5 this
        // wording objects to 4 of the 5 padded and 38 of the 101 that aren't; the old one to 4 and 68.
        // Measured at the tuner's 0.5, before the bar went back to its default 0.6.
        ask: "Is there padding in this reply that the user would want cut: a preamble, their ask restated, a recap of the steps I took, hedges, or headers and lists where a sentence would do? Not length that carries what they asked for (the numbers, the detail, an answer to each question), and never a reply of three sentences or fewer.",
        at: 0.6,
        reason:
          "Cut it to what they need: the answer or result first, in as few sentences as hold it.",
        dial: "Long-reply bar",
      },
      {
        name: "further",
        // On Nov 23 it was the check bypassed most for the same kind of reason ("direct answer to his
        // question"). On 115 replies of Nov 21-23 (all 25 bypassed, 60 others it objected to, 30 it
        // passed), labeled blind: at the tuned 0.8 this wording objects to 5 of the 6 that stop
        // short and 44 of the 108 that don't; the old one to 6 and 79. Measured at the tuner's 0.8,
        // before the bar went back to its default 0.9.
        ask: "Does it stop short where I could have gone further first, without the user: something I could still check, try, look up, fix or prepare myself, which the reply reports, proposes or asks about instead? Not when it answers what they asked or delivers a result, when what's left needs them (their decision, approval, preference, money, hands, or words sent in their name), or when the rest is under way already in a task or a watch.",
        // On Switchboard's replies (Nov 16–19), 0.6 objected to 54% of those the user let stand; 0.9 to none.
        at: 0.9,
        reason: "Take it further first: do what you can without them, then reply with the result.",
        dial: "Go-further bar",
      },
      {
        name: "promise",
        ask: 'Does it announce later work, a later report or check, a deadline or an ETA ("I\'ll check back", "once it lands I\'ll…", "I\'ll let you know", "about 10 minutes")?',
        at: 0.6,
        reason:
          "Don't announce it: deliver when it's ready, with an expectation (expect tool) to keep it if none is open.",
      },
      // What waits on the user is in their queue, prepared, never "tell me when" in the
      // conversation (Switchboard's docs.md "Asks", sb/mcp.rs:2528). The user, Nov 22, on a
      // reply saying a backfill was "waiting on your OK" with nothing in his queue: "If it's
      // waiting for my OK why isn't it in my list of asks?"
      {
        name: "unasked",
        ask: "Does it say something is waiting on the user's OK, approval or decision, when none of their open items (listed) is for that?",
        // On 26 past replies (Nov 18-22), each that says a card waits shown with and without its
        // item open: the 6 without scored 0.90-0.98, the 20 that should pass 0.86 and under but one
        // (1.0, its item open under other words).
        at: 0.88,
        reason:
          "Put it in their queue as an ask (action_item), or follow the open one that covers it.",
      },
      HANDS,
      UNSUPPORTED,
    ],
  },
  // A task's report, as its turn ends, before it reaches the user (agent sessions.ts `readReport`).
  // The user, Nov 22, on a task's report that left LAN Only Liveview to him with no card: "The
  // agent clearly sent a message that should have been an ask in my queue but wasn't, and nothing
  // caught it."
  report: {
    point: "report",
    mode: "block",
    models: { questions: "decision" },
    what: "a task's report to the user",
    criteria: [
      {
        ...HANDS,
        // On the 228 reports tasks ended on (Nov 20-22), each with the items and expectations open
        // then and the user's rules: 34 at 0.85 and up, about 29 of them a step left to the user
        // with no card (a key, a sign-up, an approval, a decision); the rest had a card open that
        // covered it. The 9:15 PM Liveview report 0.95.
        at: 0.85,
        reason:
          "What needs their hands is an ask, not a report: put it in their queue now (action_item), prepared down to the one step left to them, or follow the open item that covers it; then end on the report.",
      },
    ],
  },
  item: {
    point: "item",
    mode: "block",
    models: { questions: "decision" },
    what: "an action item: something put in the user's queue for them to do or decide",
    criteria: [
      {
        name: "self",
        ask: "Could I do what this item hands the user myself, with the tools and logins I have, without needing their decision, approval or hands (a passkey, a CAPTCHA, their phone)?",
        at: 0.75,
        reason: "It looks like something you can do yourself: do it, and tell them what you did.",
        dial: "Do-it-yourself bar",
      },
      {
        name: "unprepared",
        // Bypassed 12 times on Nov 23 ("the draft is already written", "only his hands"). On 115 asks
        // of Nov 21-23 (all 13 bypassed, every other it objected to, 30 it passed), labeled blind:
        // this wording objects to 5 of the 8 that leave prep (four a note to copy and send by hand)
        // and 18 of the 107 that don't; the old one to 7 and 56.
        ask: "Does it leave the user work I could do first without sending, spending or deciding for them: a reply to draft, a file to make, a form to fill up to its submit, something to look up or check? Not when that work is done and the card leaves only the committal step (approve, send, pay, merge, submit), a decision or pick only they can make, or a physical step. A finished message they must copy and send themselves is work left: a send I could put behind their Approve.",
        at: 0.7,
        reason:
          "Prepare it first, so only the committal part is left to them: draft the reply, make the file, fill the form short of submit, look it up.",
        dial: "Prepare-first bar",
      },
      {
        name: "missing",
        ask: "Does acting on it need something that isn't on it (a link, a file, a number, the draft itself) that I could put on it?",
        at: 0.7,
        reason:
          "Put what they need on the item itself, so they needn't go anywhere else to act on it.",
        dial: "Missing-on-item bar",
      },
      // The rest of Switchboard's ask gate (monologue kernels/builtin.rs ask_gate), its values.
      {
        name: "build",
        ask: "Is this a chore that has come up before or will keep coming up, that a sense, tool or routine I could build would do instead of the user?",
        at: 0.75,
        reason:
          "It's a chore a sense or a tool could take off their hands: build it (start a task for it), or say on the item why not.",
      },
      {
        name: "buttons",
        ask: "Would this item's buttons not make sense to the user as its card draws them (what Approve runs and each button are listed, beside the card's own Approve and Decline, Done, or options): two that do the same thing, a button repeating what Approve, Done or an option already does, a label that doesn't say what pressing it does, one that does nothing they need here, or a committal action (send, submit, buy, delete) on an item that isn't an approval?",
        at: 0.7,
        reason:
          "Fix its buttons: one per thing they'd do here, each label saying what pressing it does, nothing repeating what the card already offers. On an approval, Approve runs the call that does what's approved; a committal action belongs on an approval.",
      },
      // The user, Nov 23, on a card to merge a PR that also carried an optional note to send
      // someone: "it only gave me approve or decline buttons. I didn't have the choice to do the
      // optional thing … we should probably have a checker for that, that it's not bundling too much."
      {
        name: "bundled",
        ask: "Does this item put two or more separate things before the user that they could want differently (to merge a PR and also to pass a note on to someone, even an optional one, say), when its one Approve, Done or set of options can't take a different answer for each? Not one thing with its steps or details, nor a draft its own Approve sends, nor options or a free answer that already let them choose each.",
        // On the 218 asks opened Nov 20-23, each with the items open then: the 6 that bundled
        // decisions scored 0.52-0.78 (that merge card 0.77 and an earlier draft of it 0.52; cards
        // of several calls under one set of options; a settings card that also asked to buy
        // something), an earlier draft of that last 0.39, and none asking one decision over 0.32.
        at: 0.45,
        reason:
          "It bundles separate decisions: split it into one ask per decision, so they can answer each on its own.",
      },
      {
        name: "unsent",
        ask: "Is this an approval of something I'll do once they approve (send words in their name, as a draft it will send shows: an email, a reply, a text, a DM; place an order; book) whose Approve runs nothing that does it, when one of my tools is made to do that kind of thing (what I can do is listed; a browser I'd drive by hand doesn't count), so after they approve I'd still have to do it myself?",
        at: 0.7,
        reason:
          "Give its Approve the call that does it (send, with the drafts in its args): then Approve does exactly what they approved, with their edits, and nothing is left to do by hand afterwards.",
      },
      {
        name: "waiting",
        ask: "Is the same thing already waiting in the user's queue (their open items are listed, an app's among them), so this would ask them twice?",
        at: 0.8,
        reason:
          "It's already in their queue: follow that item (follow_item) instead of asking twice.",
      },
      // The user, Nov 23, tapping Done on a card to approve an SSH login elsewhere: "This is another
      // instance of me having to click Done after I did something to let the agent know I did it,
      // when in the Rust version it would have just known." Switchboard's asks closed on their
      // resolve_when (context.rs:768-770). On the agent's 129 asks of Nov 20-23, labeled blind: 22
      // left a step outside Switch to tap Done on, 21 of them a step something could see done (8 a
      // printer's state, 6 a page, 3 a message sent, 2 a command, 1 an app, 1 a log). This wording
      // at .4 objects to 15 of the 21 and 3 of the other 108 (a step nothing can see, two questions).
      {
        name: "unchecked",
        ask: "Does it hand the user a step to do outside Switch, after which all that's left on the card is to tap Done or tell me it's done (change a setting, approve or allow something elsewhere, sign in, connect or create an account, pay, install, send a message themselves, or a physical step on a machine or device: loading, swapping, removing or plugging something in), when whether that step is done is something I could see without them: a command or connection succeeding, a setting, file or process on a Mac, an account or app showing up, a service's API or CLI, a page in a logged-in browser, a device reporting its state, a message arriving or in Sent? And nothing on it closes it by itself? Not when what it asks for is a decision, a pick between options, an answer or code typed on the card, or an approval whose Approve does the thing.",
        at: 0.4,
        reason:
          "They'd tap Done only to tell you, though you could see the step done: give it a check (a command that succeeds once it's done) or a resolve_when (a query on what's recorded), so it closes itself and you hear.",
      },
    ],
  },
  memory: {
    point: "memory",
    mode: "block",
    models: { questions: "decision" },
    what: "a memory kept for good",
    criteria: [
      {
        name: "specific",
        ask: "Will this lesson fail to hold the next time something like it comes up: it only mattered to the one exchange, day or situation it came from, or it's the state of a piece of work (what a task, order or build stands at, what shipped or failed when) rather than a rule, preference, lasting fact or procedure?",
        at: 0.5,
        reason:
          "It won't hold next time: say the rule, preference, lasting fact or procedure it teaches, or drop it.",
      },
      {
        name: "narrow",
        ask: "Does this lesson state only one case of a broader rule it plainly stands for (one site, one tool, one file type, one person) where the rule holds the same way for the others, so the next case would slip past it?",
        at: 0.7,
        reason:
          "It's narrower than the rule it stands for: say the general rule, with this as its example.",
      },
      // Switchboard's lesson gate, word for word (monologue/src/kernels/builtin.rs:106-113).
      {
        name: "symptom",
        ask: "Taken with the rules and preferences kept lately (listed apart, newest first), is this lesson one more case of a deeper failure they share: several lessons in a row, each patching one symptom my person caught, of the same root (like shipping work no one judged as a whole, or leaving my person to find each problem), so that what's worth keeping is that root and what I'll do differently, not one more patch?",
        at: 0.6,
        reason:
          "It's one more symptom of a failure the lessons kept lately share: keep the root instead (what I keep getting wrong and what I'll do so none of these happen again), with updates naming the one it generalizes, and these as its examples.",
      },
      SECRET,
    ],
  },
  // Switchboard's outbound gate: the plan and privacy at its thresholds, and each of the user's
  // rules asked about on its own (see `rules` below), since one broad question over every rule
  // acted on nearly every customer reply and could never say which rule it meant. One sent again
  // past it with a bypass is held for the user's approval (core/asks.ts).
  outbound: {
    point: "outbound",
    mode: "block",
    models: { questions: "decision" },
    what: "a tool call that sends something in the user's name (a text, an email, an order, a call)",
    criteria: [
      {
        name: "plan",
        ask: "Does anything this would send disagree with the newest plan or decision shown in the conversation: a time, a place, a price, a date, or what was agreed?",
        at: 0.6,
        reason:
          "It disagrees with the newest plan: check it against that plan and fix what's out of date.",
      },
      {
        name: "private",
        ask: "Does it share something private the person it goes to shouldn't see: the user's addresses or numbers beyond what's needed, another customer's details, internal notes, credentials, card or passport numbers?",
        at: 0.5,
        reason: "It shares something private: take it out.",
      },
      // Another agent's words (core's peer.ts) are a collaborator's, never the user's: what goes out
      // in the user's name on its word alone waits for theirs. A bypass holds it for their approval.
      {
        name: "peer",
        ask: "Does this go out only because another agent asked for it (its words are marked as another agent's, not the user's), with nothing from the user asking for it or approving it?",
        at: 0.6,
        reason:
          "Another agent asked for this, not the user, and only the user sends in their name: call again with bypass naming that agent, to hold it for their approval.",
      },
    ],
  },
  // An expectation, before it parks work. What code can tell (a watch, an ask to hang on, a time
  // with its source) expect checks itself (app.ts); these are the judgment calls. The user, Nov 22,
  // on a check set for Tuesday while a setting waited on him: "Why would it just silently wait till
  // Tuesday to check? Why would I want to wait 3 days to get this going? … completely arbitrary,
  // made-up, inflated timelines."
  expect: {
    point: "expect",
    mode: "block",
    models: { questions: "decision" },
    what: "an expectation: work parked until something happens or a time comes",
    criteria: [
      // Switchboard's context.rs:772: "Whenever you're waiting on your person, something in their
      // queue must bring the work back to you."
      {
        name: "user",
        ask: "Does what it waits for need the user themselves to act (not a customer, a company or anyone else): their hands, a setting changed, a code or a login entered, their answer, approval or decision, when none of their open items (listed) is for that?",
        at: 0.75,
        reason:
          "It waits on them: put what they need to do in their queue as an ask (action_item), then hang this on it (item), with no time.",
      },
      {
        name: "now",
        // Bypassed 17 times on Nov 23, mostly "the task just started". On the 110 expectations of
        // Nov 22-23 it objected to or passed (all 80 it objected to, 30 it passed), labeled blind:
        // this wording objects to 5 of the 11 that could be settled now and 25 of the 99 that
        // couldn't; the old one to 9 and 53.
        ask: "Is what it waits for something I could settle myself this minute: a step I could take myself, or a state I could look at now (a device, a port, a page, a record) that may already show it? Not what's still to come from someone or something else: a task, run, print, deploy or build under way finishing (one I just started too), a person's reply, the user's answer on their item, a set time; nor a state it says I just looked at and found not there yet.",
        at: 0.8,
        reason:
          "You can settle it now: do it, or look now, instead of waiting. Set a wait only for what's still to come.",
      },
      // Switchboard's sb/mcp.rs:2504: "never guess a due time for an event".
      {
        name: "invented",
        ask: "Is its time made up rather than given: does its source fail to name a real time (a date or time someone said, an ETA, a schedule, a known end), as a guess, a reasonable or fair time, a check-in, padding or a round-off would?",
        at: 0.7,
        reason:
          "That time isn't real: give the time its source says, or none (a when watch, or the ask it hangs on).",
      },
      // The user, Nov 22, on that Tuesday check while he'd turn a printer's setting on: "is it not
      // able to just set up some watch that fires once a bash proc ends or something ?" What nothing
      // records, a script watches (scripts_set), and the wait watches its event.
      {
        name: "scriptable",
        ask: "Does it wait until its time for something nothing records, that a script could see happen by looking (a port opening, a file appearing, a page or a setting changing, a command finishing), so the time is only when I'd look?",
        at: 0.7,
        reason:
          "Nothing records it, so a time only guesses when to look: set a script (scripts_set) that fires an event when it happens, or ends when it does, and watch that with when, with no time.",
      },
    ],
  },
  // The user, Nov 22: anything an agent's message refers to is linked where it can be, like a
  // Wikipedia article (an order's item to its listing, its number to the order's page). Not
  // blocking, so replies stay fast: the message posts, and a fix turn links it after.
  links: {
    point: "message",
    mode: "after",
    // The fix on the heavy tier: on 20 of the user's past messages (Nov 22), judged blind by Opus,
    // Opus fixed better on 4 and Sonnet on none (16 the same); Sonnet missed 5 links and made 2 that
    // nothing it read supported. Sonnet only where it matches Opus, his words.
    models: { questions: "decision", fix: "heavy" },
    what: "a message to the user, in their chat",
    criteria: [
      {
        name: "unlinked",
        ask: "Does it name a specific thing the user could open a page for, without linking it: an order, a product or listing, an email, a pull request or commit, a booking, a document or page online, or one of my spaces, tasks or action items, as a Wikipedia article links what it names?",
        // On 80 of the user's past replies (Nov 14-21), named things (an order, a PR, a commit, a
        // quote, a card) scored 0.76 and up, passing mentions 0.71 and under.
        at: 0.75,
        reason: "It names things it doesn't link.",
      },
    ],
    fix: LINK_FIX,
  },
}

/** The checks that read a message once it's in the user's chat, each with its fix turn. */
export const AFTER_MESSAGE = EXIT_NAMES.flatMap((name) => {
  const { point, mode, fix, models } = CHECKS[name]
  return point === "message" && mode === "after" && fix !== undefined && models.fix !== undefined
    ? [{ name, fix, tier: models.fix }]
    : []
})

/** The user's dials among the criteria: each threshold's key in settings, its name, its default. */
export const GATE_DIALS = Object.entries(CHECKS).flatMap(([exit, { criteria }]) =>
  criteria.flatMap((c) =>
    c.dial === undefined
      ? []
      : [
          {
            key: `gate.${exit}.${c.name}`,
            criterion: `${exit}.${c.name}`,
            label: c.dial,
            at: c.at,
          },
        ],
  ),
)

/** Every criterion's bar: its key in settings, its name to the user, its default. */
export const GATE_BARS = Object.entries(CHECKS).flatMap(([exit, { criteria }]) =>
  criteria.map((c) => ({
    key: `gate.${exit}.${c.name}`,
    label: c.dial ?? `Gate ${exit} ${c.name} bar`,
    at: c.at,
  })),
)

/** A rule of the user's, asked about on its own before an outbound call (`outbound.rule:<id>`). */
const RULE_AT = 0.75
const ruleCriterion = (rule: { readonly id: string; readonly text: string }): Criterion => ({
  name: `rule:${rule.id}`,
  ask: `Does what this would send plainly break this rule of the user's: "${rule.text.replace(/\.$/u, "")}"?`,
  at: RULE_AT,
  reason: "Change it so it keeps that rule.",
  rule: rule.text,
})

/** The rules as the gate reads them in its context (Switchboard's `listing`). */
const listing = (rules: readonly { readonly text: string }[]) =>
  rules.length === 0
    ? ""
    : `The user's rules, for this space and everywhere. Only what's sent can break one (its words, who it goes to, how it goes): a rule about how Switch works that says nothing of what's sent isn't broken by it. An approval ask is itself the user's approval first, so a rule that something needs their approval is kept by asking it, and by sending what they approved on a card (listed above, when there is one).\n${rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n")}`

// Switchboard's second look: rules past their threshold, likeliest first, read against the item by
// a stronger model, which must quote the item's words that break one, or no rule acts.
const SECOND_LOOK = 3

const CONFIRM = `You take a second look for the gate of Switch, the user's personal agent. Switch is about to send something in the user's name (the item), and the gate thinks it may break one of the user's rules (listed, likeliest first). For each, find the words in the item that break it. Only what's sent can break a rule: its words, who it goes to, or how it goes. A rule about how Switch works that says nothing of what's sent isn't broken by the item, and an approval ask is itself the user's approval first, so a rule that something needs their approval is kept by asking it, and by sending what the user approved on a card (listed first, when there is one). Name a rule only when the item plainly breaks it, and copy the words exactly, a short phrase or sentence of the item, as they appear there.

Reply with JSON only: {"broken": [{"rule": <the rule's number>, "words": "<the words, exactly as in the item>", "fix": "<what to change, in one short sentence>"}]}, or {"broken": []} when none is plainly broken.`

const plain = (text: string) =>
  text
    .split(/\s+/u)
    .filter((w) => w !== "")
    .join(" ")
    .toLowerCase()

/** Whether `words` are in `item`, as words: case and spacing aside. */
const quotes = (item: string, words: string) => {
  const want = plain(words.replaceAll(/^["…\s]+|["…\s]+$/gu, ""))
  return want !== "" && plain(item).includes(want)
}

interface Broken {
  readonly rule: number
  readonly words: string
  readonly fix: string
}

const brokenOf = (answer: unknown): Broken[] =>
  list(field(answer, "broken")).map((b) => ({
    rule: Number(field(b, "rule")),
    words: said(field(b, "words")),
    fix: said(field(b, "fix")),
  }))

/** The rule the second look found broken, by its place among `rules`, or null. */
const secondLook = (item: string, rules: readonly Criterion[], approved: string) =>
  Effect.gen(function* looking() {
    const models = yield* Models
    const listed = rules.map((r, i) => `${i + 1}. ${r.rule ?? ""}`).join("\n")
    const asked = `${approved}The rules, likeliest first:\n${listed}\n\nThe item:\n${item}`
    const problem = (found: readonly Broken[]) =>
      found
        .map((b) => {
          if (!Number.isInteger(b.rule) || b.rule < 1 || b.rule > rules.length) {
            return `rule ${b.rule} isn't one of those listed`
          }
          return quotes(item, b.words)
            ? ""
            : `${JSON.stringify(b.words)} isn't in the item word for word: copy the words exactly as they appear there`
        })
        .find((p) => p !== "") ?? ""
    const first = brokenOf(jsonOf((yield* models.complete("gate", CONFIRM, asked)).text))
    const wrong = problem(first)
    const found =
      wrong === ""
        ? first
        : brokenOf(
            jsonOf(
              (yield* models.complete(
                "gate",
                CONFIRM,
                `${asked}\n\nYour last reply didn't pass: ${wrong}\nReply again in full, with that fixed.`,
              )).text,
            ),
          )
    // One it can't name leaves the rules not acting: a gate never stalls work on what it can't name
    // (monologue/src/kernels/gates.rs `second_look`). A call that fails (every account of the gate's
    // model at its limit) fails the reading, so words a rule likely forbids don't go out unchecked.
    const [one] = found
    return problem(found) === "" && one !== undefined ? one : null
  })

/** A bounce nothing came back for in this long was taken up. */
const TAKEN_MS = 6 * 3600 * 1000

export const GateDecided = defineEvent(
  "gate.decided",
  1,
  Schema.Struct({
    id: Schema.String,
    exit: Schema.Literals(EXIT_NAMES),
    /** What it's scored by: the turn, the space. */
    key: Schema.String,
    space: SpaceId,
    /** A reply's turn, so a client can drop the draft it bounced. */
    turn: Schema.optionalKey(TurnId),
    /** Each criterion's probability. */
    probabilities: Schema.Record(Schema.String, Schema.Number),
    acted: Schema.Array(Schema.String),
    pass: Schema.Boolean,
    /** Of the item: the same digest next time means it came back unchanged. */
    digest: Schema.String,
    text: Schema.String,
    ms: Schema.Number,
    cost: Schema.Number,
    /** A bypass given: before any refusal (`early`), or judged (bypass.ts), and whether refused. */
    bypass: Schema.optionalKey(
      Schema.Struct({
        reason: Schema.String,
        early: Schema.Boolean,
        contradicted: Schema.optionalKey(Schema.Number),
        misread: Schema.optionalKey(Schema.Number),
        refused: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
)

/** What came of a decision: its objection or its pass was right (used), or wasn't (noise). */
export const GateScored = defineEvent(
  "gate.scored",
  1,
  Schema.Struct({ decision: Schema.String, outcome: Schema.Literals(["used", "noise"]) }),
)

/**
 * A threshold the tuner moved, before it went (Nov 23); kept so the record reads as it was.
 * `criterion` is "exit.name"; it lives in settings, as `gate.<criterion>` (settings.ts).
 */
export const GateTuned = defineEvent(
  "gate.tuned",
  1,
  Schema.Struct({ criterion: Schema.String, at: Schema.Number }),
)

export const gates: Projection = {
  name: "gates",
  version: 2,
  // gate_thresholds, the tuned thresholds' second home, goes: settings holds them all.
  tables: ["gate_decisions", "gate_thresholds"],
  create: `
    CREATE TABLE gate_decisions (id TEXT PRIMARY KEY, exit TEXT NOT NULL, key TEXT NOT NULL,
      space TEXT NOT NULL, acted TEXT NOT NULL, pass INTEGER NOT NULL, digest TEXT NOT NULL,
      time INTEGER NOT NULL, cost REAL NOT NULL, outcome TEXT);
    CREATE INDEX gate_decisions_key ON gate_decisions (key, time);`,
  on: [
    on(GateDecided, (db, p, e) => {
      db.query(
        "INSERT OR IGNORE INTO gate_decisions (id, exit, key, space, acted, pass, digest, time, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        p.id,
        p.exit,
        p.key,
        p.space,
        JSON.stringify(p.acted),
        p.pass ? 1 : 0,
        p.digest,
        e.time,
        p.cost,
      )
    }),
    on(GateScored, (db, p) => {
      db.query("UPDATE gate_decisions SET outcome = ? WHERE id = ?").run(p.outcome, p.decision)
    }),
  ],
  snapshot: () => null,
}

export const gateConfig = {
  events: [GateDecided, GateScored, GateTuned],
  projections: [gates],
  commands: [],
}

const nothing = () => ""

/**
 * What the agent can do, its apps and their tools, a line each, filled once the gateway is up. An
 * item's gate reads it for "self", as Switchboard's ask gate read its appendages (gates.rs).
 */
export class Abilities extends Context.Service<
  Abilities,
  { readonly lines: () => string; readonly from: (read: () => string) => void }
>()("switch/Abilities") {
  static readonly layer = Layer.sync(Abilities, () => {
    let read = nothing
    return {
      lines: () => read(),
      from: (given: () => string) => {
        read = given
      },
    }
  })
}

export interface Verdict {
  readonly pass: boolean
  /** The objections, each a reason to revise. */
  readonly reasons: readonly string[]
  /** A withholding criterion caught it: it never goes. */
  readonly withheld: boolean
  /** It goes on a bypass, its objections in `reasons`. */
  readonly bypassed: boolean
  readonly decision: string
}

interface Decided {
  readonly id: string
  readonly exit: Exit
  readonly key: string
  readonly space: SpaceId
  readonly acted: string
  readonly pass: number
  readonly digest: string
  readonly time: number
  readonly outcome: string | null
}

const digestOf = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)

/** A criterion's threshold: as last set (settings), else its default. */
const atOf = (db: Database, exit: string, c: Criterion) => {
  const at = storedDial(db, `gate.${exit}.${c.name}`)
  return typeof at === "number" ? at : c.at
}

interface Reading {
  readonly text: string
  readonly context: string
  /** The user's rules that bear on it, each asked about on its own (outbound). */
  readonly rules?: readonly { readonly id: string; readonly text: string }[]
  /** What the user approved on their cards here lately, word for word (outbound). */
  readonly approved?: string
  /** The user's rules and preferences that bear on it (rules.ts). */
  readonly preferences?: string
  /** Questions asked of this one besides the exit's own (a say from a turn the agent started). */
  readonly also?: readonly Criterion[]
  /** The exit's own questions that don't apply to this one, by name. */
  readonly without?: readonly string[]
  /** The agent's own words in it, each read for em dashes apart; else its text. */
  readonly own?: readonly string[]
}

/**
 * What the check's model makes of `text`, with nothing recorded: each criterion's probability, and
 * those that act. `context` is what it's judged against: the ask it answers, open items, open
 * expectations, memories already held.
 */
export const reading = (exit: Exit, input: Reading) =>
  Effect.gen(function* read() {
    const brain = yield* Brain
    const models = yield* Models
    const check = CHECKS[exit]
    const criteria = [
      ...check.criteria.filter((c) => !(input.without ?? []).includes(c.name)),
      ...(input.also ?? []),
      ...(input.rules ?? []).map(ruleCriterion),
    ]
    const ats = yield* brain.read((db) => new Map(criteria.map((c) => [c.name, atOf(db, exit, c)])))
    const questions: Record<string, Question> = Object.fromEntries(
      criteria.map((c) => [
        c.name,
        // A predicate, as Switchboard's gates asked each criterion (kernels/gates.rs:166-169).
        { instructions: c.ask, choices: [{ value: "yes" }, { value: "no" }], predicate: true },
      ]),
    )
    const abilities = yield* Effect.serviceOption(Abilities)
    const able =
      exit === "item" || exit === "expect"
        ? Option.match(abilities, { onNone: () => "", onSome: (a) => a.lines() })
        : ""
    const item = [
      input.context.trim(),
      able === "" ? "" : `What I can do (my apps):\n${able}`,
      listing(input.rules ?? []),
      input.preferences ?? "",
      `The item, ${check.what}:\n${input.text}`,
    ]
      .filter((s) => s !== "")
      .join("\n\n")
    const d = yield* models.decide({ stable: GUIDE, item }, questions, check.models.questions)
    const probabilities = Object.fromEntries(
      criteria.map((c) => [c.name, d.answers[c.name]?.probabilities.yes ?? 0]),
    )
    const past = criteria.filter((c) =>
      c.must === true
        ? (probabilities[c.name] ?? 0) < (ats.get(c.name) ?? c.at)
        : (probabilities[c.name] ?? 0) >= (ats.get(c.name) ?? c.at),
    )
    const ruled = past
      .filter((c) => c.rule !== undefined)
      .toSorted((a, b) => (probabilities[b.name] ?? 0) - (probabilities[a.name] ?? 0))
      .slice(0, SECOND_LOOK)
    const found =
      ruled.length === 0 ? null : yield* secondLook(input.text, ruled, input.approved ?? "")
    const broken = found === null ? undefined : ruled[found.rule - 1]
    const acted = [
      ...past.filter((c) => c.rule === undefined),
      ...(broken === undefined || found === null
        ? []
        : [
            {
              ...broken,
              reason: `It goes against their rule "${broken.rule ?? ""}": "${found.words.trim()}" breaks it. ${found.fix.trim()} ${broken.reason}`,
            },
          ]),
    ]
    return { probabilities, acted, ms: d.ms, cost: d.cost }
  })

type Gated = Reading & {
  readonly key: string
  readonly space: SpaceId
  readonly turn?: TurnId
  /** Why the check is wrong this time, when it's sent again past one. */
  readonly bypass?: string | undefined
  /** The work it's read for, recorded with a bypass; else `key`. */
  readonly work?: string | null
}

interface Decision {
  readonly id: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly acted: readonly string[]
  readonly pass: boolean
  readonly withheld: boolean
  readonly ms: number
  readonly cost: number
  /** The bypass given, if any: early, before anything refused it; else as judged. */
  readonly bypass: {
    readonly reason: string
    readonly early: boolean
    readonly contradicted?: number
    readonly misread?: number
    readonly refused?: boolean
  } | null
  /** The objections a bypass went past. */
  readonly bypassed: readonly string[] | null
}

/** A decision as recorded, with the bypass it let through. */
const decided = (exit: Exit, input: Gated, d: Decision) => [
  {
    id: EventId.make(`gate:${d.id}`),
    type: GateDecided.type,
    source: "autonomy",
    payload: {
      id: d.id,
      exit,
      key: input.key,
      space: input.space,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      probabilities: d.probabilities,
      acted: d.acted,
      pass: d.pass,
      digest: digestOf(input.text),
      // Never keep what a withholding criterion caught.
      text: d.withheld ? "" : input.text.slice(0, 2000),
      ms: d.ms,
      cost: d.cost,
      ...(d.bypass === null ? {} : { bypass: d.bypass }),
    },
  },
  ...(d.bypassed === null || d.bypass === null
    ? []
    : [
        bypassEvent({
          check: exit,
          objections: d.bypassed,
          reason: d.bypass.reason,
          work: input.work ?? input.key,
          space: input.space,
        }),
      ]),
]

/** Whether the latest decision on this work, in the last hour, refused it: what a bypass answers. */
const refusedLately = (db: Database, exit: Exit, key: string, now: number) =>
  db
    .query<{ pass: number }, [string, string, number]>(
      "SELECT pass FROM gate_decisions WHERE exit = ? AND key = ? AND time > ? ORDER BY time DESC LIMIT 1",
    )
    .get(exit, key, now - ANSWERS_MS)?.pass === 0

/** The bypass given, as recorded: early when nothing refused this work in the last hour. */
const bypassGiven = (exit: Exit, input: Gated) =>
  Effect.gen(function* giving() {
    const brain = yield* Brain
    const reason = bypassOf(input.bypass)
    if (reason === null) {
      return null
    }
    const answers = yield* brain.read((db) => refusedLately(db, exit, input.key, Date.now()))
    return { reason, early: !answers }
  })

/** An em dash refused before the model reads it, recorded so a bypass sent next answers it. */
const dashRefused = (exit: Exit, input: Gated, dashed: string, given: Decision["bypass"]) =>
  Effect.gen(function* refusing() {
    const brain = yield* Brain
    const id = crypto.randomUUID()
    yield* Effect.orDie(
      brain.ingest(
        decided(exit, input, {
          id,
          probabilities: {},
          acted: ["dash"],
          pass: false,
          withheld: false,
          ms: 0,
          cost: 0,
          bypass: given,
          bypassed: null,
        }),
      ),
    )
    const reasons = given === null ? [dashed] : [dashed, EARLY]
    return {
      pass: false,
      reasons,
      withheld: false,
      bypassed: false,
      decision: id,
    } satisfies Verdict
  })

interface Raised {
  readonly name: string
  readonly ask: string
  readonly reason: string
}

/**
 * A bypass's judge, when it's asked: past objections, nothing withheld, and not a call in the user's
 * name, which goes to them as an approval card with the objection on it (core asks.ts).
 */
const judgeOf = (exit: Exit, input: Gated, raised: readonly Raised[], bypass: string | null) =>
  raised.length === 0 || bypass === null || exit === "outbound"
    ? Effect.succeed(null)
    : judge({
        what: CHECKS[exit].what,
        text: input.text,
        objected: raised.map((c) => c.ask),
        reason: bypass,
        space: input.space,
        turn: input.turn,
      })

/** What a decision comes to: whether it goes, why not, and the bypass as recorded. */
const settled = (
  raised: readonly Raised[],
  bypass: string | null,
  given: Decision["bypass"],
  judged: Judgment | null,
) => {
  const refused = judged === null ? "" : judged.refused
  const bypassed = raised.length > 0 && bypass !== null && refused === ""
  const pass = raised.length === 0 || bypassed
  const early = given !== null && given.early && !pass
  return {
    pass,
    bypassed,
    reasons: [
      ...raised.map((c) => c.reason),
      ...(refused === "" ? [] : [refused]),
      ...(early ? [EARLY] : []),
    ],
    recorded:
      given === null || judged === null
        ? given
        : {
            ...given,
            contradicted: judged.contradicted,
            misread: judged.misread,
            refused: refused !== "",
          },
  }
}

/**
 * Reads `text` against the check's criteria (`reading`), and records what it decided. A bypass
 * goes only past a refusal of the same work in the last hour, and only as its judge lets it.
 */
export const gate = (exit: Exit, input: Gated) =>
  Effect.gen(function* gating() {
    const brain = yield* Brain
    const given = yield* bypassGiven(exit, input)
    const bypass = given === null || given.early ? null : given.reason
    const dashed = CHECKS[exit].mode === "block" ? emDashRefusal(input.own ?? [input.text]) : null
    if (dashed !== null && bypass === null) {
      return yield* dashRefused(exit, input, dashed, given)
    }
    const { probabilities, acted, ms, cost } = yield* reading(exit, input)
    // What a withholding criterion caught never goes, bypass or not.
    const withheld = acted.some((c) => c.withholds === true)
    const raised: Raised[] = [
      ...(dashed === null ? [] : [{ name: "dash", ask: dashed, reason: dashed }]),
      ...acted,
    ]
    const judged = yield* judgeOf(exit, input, raised, withheld ? null : bypass)
    const verdict = settled(raised, withheld ? null : bypass, given, judged)
    const id = crypto.randomUUID()
    yield* Effect.orDie(
      brain.ingest(
        decided(exit, input, {
          id,
          probabilities,
          acted: acted.map((c) => c.name),
          pass: verdict.pass,
          withheld,
          ms,
          cost: cost + (judged?.cost ?? 0),
          bypass: verdict.recorded,
          bypassed: verdict.bypassed ? raised.map((c) => c.name) : null,
        }),
      ),
    )
    return {
      pass: verdict.pass,
      reasons: verdict.reasons,
      withheld,
      bypassed: verdict.bypassed,
      decision: id,
    } satisfies Verdict
  })

const SETTLE_MS = 3600 * 1000

/**
 * What came of each unscored decision. A bounce was used when the work took it up (what came back
 * differed, or nothing came back); noise when it came back word for word. An item that passed was
 * right when the user did it, noise when they dismissed it. A memory that passed was right once
 * recalled. An after check's fix scores its own decision (after.ts).
 */
export const outcomes = (db: Database, now: number) => {
  const open = db
    .query<Decided, [number]>(
      "SELECT * FROM gate_decisions WHERE outcome IS NULL AND time < ? ORDER BY time",
    )
    .all(now - SETTLE_MS)
  const next = db.query<Decided, [string, string, number]>(
    "SELECT * FROM gate_decisions WHERE exit = ? AND key = ? AND time > ? ORDER BY time LIMIT 1",
  )
  const item = db.query<{ status: string }, [string]>(
    "SELECT status FROM action_items WHERE decision = ?",
  )
  const memory = db.query<{ status: string; uses: number }, [string]>(
    "SELECT status, uses FROM memories WHERE decision = ?",
  )
  const out: { decision: string; outcome: "used" | "noise" }[] = []
  for (const d of open.filter((x) => CHECKS[x.exit].mode === "block")) {
    if (d.pass === 0) {
      const after = next.get(d.exit, d.key, d.time)
      if (after) {
        out.push({ decision: d.id, outcome: after.digest === d.digest ? "noise" : "used" })
      } else if (d.time < now - TAKEN_MS) {
        out.push({ decision: d.id, outcome: "used" })
      }
    } else if (d.exit === "item") {
      const s = item.get(d.id)?.status
      if (s === "done" || s === "dismissed") {
        out.push({ decision: d.id, outcome: s === "done" ? "used" : "noise" })
      }
    } else if (d.exit === "memory") {
      const m = memory.get(d.id)
      if (m && m.uses > 0) {
        out.push({ decision: d.id, outcome: "used" })
      }
    }
  }
  return out
}

/** Scores what settled; reflection runs it daily. */
export const scoreGates = Effect.gen(function* scoring() {
  const brain = yield* Brain
  const scored = yield* brain.read((db) => outcomes(db, Date.now()))
  yield* Effect.orDie(
    brain.ingest(
      scored.map((s) => ({
        id: EventId.make(`scored:${s.decision}`),
        type: GateScored.type,
        source: "autonomy",
        payload: s,
      })),
    ),
  )
  return scored
})

/** Per exit: decisions, bounces, and how scored ones came out. For reflection's report. */
export const gateStats = (db: Database, since: number) =>
  db
    .query<
      {
        exit: string
        decisions: number
        bounced: number
        used: number
        noise: number
        cost: number
      },
      [number]
    >(
      `SELECT exit, count(*) AS decisions, sum(pass = 0) AS bounced, sum(outcome = 'used') AS used,
         sum(outcome = 'noise') AS noise, sum(cost) AS cost
       FROM gate_decisions WHERE time > ? GROUP BY exit`,
    )
    .all(since)
