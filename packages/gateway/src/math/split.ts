// Math in an agent's words, found the same way on every surface (the desktop's math.rs, the
// iPhone's Math.swift, pages here), each checked against cases.json:
// - `$$…$$` is a formula on its own (display), on one line or across lines;
// - `$…$` is one in the words (inline) only when its dollars hug it: no space after the opening
//   `$`, none before the closing one, and no digit right after it, so "$215" and "costs $5 and
//   $10" stay money; the first `$` after an opening one closes it or nothing does;
// - `\$` is a dollar, and nothing in code (a fence or backticks) is math.
// Whitespace and digits are ASCII's, so the three agree to the character.

export interface Segment {
  readonly kind: "text" | "inline" | "display"
  readonly text: string
}

const space = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r"
const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"

/** Where a fence that opens at `at` (a line's start) ends: past its closing line, or the end. */
const fenceEnd = (s: string, at: number): number | null => {
  let i = at
  while (i < at + 3 && s[i] === " ") {
    i += 1
  }
  const mark = s[i]
  if (mark !== "`" && mark !== "~") {
    return null
  }
  let run = 0
  while (s[i + run] === mark) {
    run += 1
  }
  if (run < 3) {
    return null
  }
  let line = s.indexOf("\n", i)
  while (line !== -1) {
    let j = line + 1
    while (j < line + 4 && s[j] === " ") {
      j += 1
    }
    let close = 0
    while (s[j + close] === mark) {
      close += 1
    }
    if (close >= run) {
      const end = s.indexOf("\n", j + close)
      return end === -1 ? s.length : end
    }
    line = s.indexOf("\n", line + 1)
  }
  return s.length
}

/** Past the code span whose opening backticks start at `at`, or null when none closes them. */
const codeEnd = (s: string, at: number, run: number): number | null => {
  let i = at + run
  while (i < s.length) {
    if (s[i] === "`") {
      let n = 0
      while (s[i + n] === "`") {
        n += 1
      }
      if (n === run) {
        return i + n
      }
      i += n
    } else {
      i += 1
    }
  }
  return null
}

/** The `$$` that closes one opened before `from`, skipping escapes. */
const displayEnd = (s: string, from: number): number | null => {
  let i = from
  while (i < s.length - 1) {
    if (s[i] === "\\") {
      i += 2
    } else if (s[i] === "$" && s[i + 1] === "$") {
      return i
    } else {
      i += 1
    }
  }
  return null
}

/** The `$` that closes one opened at `at`, when the first one after it may. */
const inlineEnd = (s: string, at: number): number | null => {
  if (space(s[at + 1]) || s[at + 1] === "$" || at + 1 >= s.length) {
    return null
  }
  let i = at + 1
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      i += 2
    } else if (c === "\n") {
      let j = i + 1
      while (s[j] === " " || s[j] === "\t" || s[j] === "\r") {
        j += 1
      }
      if (s[j] === "\n" || j >= s.length) {
        return null
      }
      i += 1
    } else if (c === "$") {
      return space(s[i - 1]) || digit(s[i + 1]) ? null : i
    } else {
      i += 1
    }
  }
  return null
}

export const splitMath = (s: string): Segment[] => {
  const out: Segment[] = []
  let text = ""
  const put = (kind: "inline" | "display", math: string) => {
    if (text !== "") {
      out.push({ kind: "text", text })
    }
    text = ""
    out.push({ kind, text: math })
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (i === 0 || s[i - 1] === "\n") {
      const end = fenceEnd(s, i)
      if (end !== null) {
        text += s.slice(i, end)
        i = end
        continue
      }
    }
    if (c === "\\") {
      text += s.slice(i, i + 2)
      i += 2
    } else if (c === "`") {
      let run = 0
      while (s[i + run] === "`") {
        run += 1
      }
      const end = codeEnd(s, i, run) ?? i + run
      text += s.slice(i, end)
      i = end
    } else if (c === "$" && s[i + 1] === "$") {
      const end = displayEnd(s, i + 2)
      const math = end === null ? "" : s.slice(i + 2, end).trim()
      if (end === null || math === "") {
        text += "$$"
        i += 2
      } else {
        put("display", math)
        i = end + 2
      }
    } else if (c === "$") {
      const end = inlineEnd(s, i)
      if (end === null) {
        text += "$"
        i += 1
      } else {
        put("inline", s.slice(i + 1, end))
        i = end + 1
      }
    } else {
      text += c
      i += 1
    }
  }
  if (text !== "") {
    out.push({ kind: "text", text })
  }
  return out
}
