// Dictation: the helper (src/native/dictation.swift) listens to the microphone and turns it into
// text with Apple's SpeechAnalyzer, one helper per dictation. It reports how loud the user is and
// the phrases it hears as JSON lines, and finishes the last phrase when its stdin closes. One runs
// at a time: there's one microphone.
import type { Subprocess } from "bun"
import { Option, Schema } from "effect"
import { Utils } from "electrobun/main"

import type { Dictate, Heard, Stopped } from "../shared/dictation.ts"
import { nativeHelper } from "./native.ts"

const HELPER = nativeHelper("switch-dictation")

const SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"

const Line = Schema.Union([
  Schema.Struct({ event: Schema.Literal("ready") }),
  Schema.Struct({ event: Schema.Literal("level"), level: Schema.Number }),
  Schema.Struct({ event: Schema.Literals(["volatile", "final"]), text: Schema.String }),
  Schema.Struct({ event: Schema.Literal("error"), kind: Schema.String, message: Schema.String }),
])
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))

const FAILURES = ["denied", "no-input"] as const
const failure = (kind: string): Stopped => FAILURES.find((k) => k === kind) ?? "failed"

/** `text` spaced from the phrases finished before it: the helper reports them bare. */
const spaced = (before: string, text: string) => {
  const last = before.at(-1)
  const first = text.at(0)
  const apart =
    last !== undefined &&
    first !== undefined &&
    !/\s/u.test(last) &&
    !/\s/u.test(first) &&
    !",.?!;:)".includes(first)
  return apart ? ` ${text}` : text
}

interface Session {
  readonly id: number
  readonly helper: Subprocess<"pipe", "pipe", "ignore">
  finished: string
  volatile: string
  stopped?: Stopped
  message?: string
}

let session: Session | null = null

const stop = (s: Session) => {
  // Closing its stdin is the end of the audio.
  void s.helper.stdin.end()
}

const run = async (s: Session, tell: (h: Heard) => void) => {
  const { id } = s
  const hear = (raw: string) => {
    // Anything else on its stdout is a framework talking to itself.
    const line = decodeLine(raw)
    if (session !== s || Option.isNone(line)) {
      return
    }
    const l = line.value
    switch (l.event) {
      case "ready": {
        tell({ id, kind: "ready" })
        break
      }
      case "level": {
        tell({ id, kind: "level", level: Math.min(1, Math.max(0, l.level)) })
        break
      }
      case "volatile": {
        s.volatile = spaced(s.finished, l.text)
        tell({ id, kind: "words", text: s.finished + s.volatile })
        break
      }
      case "final": {
        s.finished += spaced(s.finished, l.text)
        s.volatile = ""
        tell({ id, kind: "words", text: s.finished })
        break
      }
      case "error": {
        s.stopped = failure(l.kind)
        s.message = l.message
        break
      }
      default: {
        l satisfies never
      }
    }
  }
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of s.helper.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n")
    rest = lines.pop() ?? ""
    for (const raw of lines) {
      hear(raw)
    }
  }
  const code = await s.helper.exited
  if (session !== s) {
    return
  }
  session = null
  // Done when it finished as asked; else it died.
  const died = code !== 0 && s.stopped === undefined
  tell({
    id,
    kind: "end",
    text: s.finished + s.volatile,
    ...(died && { stopped: "failed" as const, message: "The dictation helper quit." }),
    ...(s.stopped && { stopped: s.stopped }),
    ...(s.message !== undefined && { message: s.message }),
  })
}

/** Whether a dictation is under way: an update waits for it to end. */
export const dictating = () => session !== null

/** Does what the view asks, telling it what the dictation under way hears. */
export const dictate = (d: Dictate, tell: (h: Heard) => void) => {
  switch (d.do) {
    case "start": {
      session?.helper.kill()
      session = null
      if (HELPER === undefined) {
        tell({ id: d.id, kind: "end", text: "", stopped: "missing" })
        return
      }
      const helper = Bun.spawn([HELPER], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
      const s: Session = { id: d.id, helper, finished: "", volatile: "" }
      session = s
      void run(s, tell)
      break
    }
    case "stop": {
      if (session) {
        stop(session)
      }
      break
    }
    case "cancel": {
      session?.helper.kill()
      session = null
      break
    }
    case "settings": {
      Utils.openExternal(SETTINGS)
      break
    }
    default: {
      d satisfies never
    }
  }
}
