// A shell command line's simple commands, ported from Switchboard's `sb guard`: enough of sh to say
// what a line runs, never to run it.

interface Lexer {
  readonly line: string
  i: number
  word: string
  inWord: boolean
  words: string[]
  readonly commands: string[][]
  heredocs: { readonly delimiter: string; readonly tabs: boolean }[]
}

const at = (l: Lexer, offset = 0) => l.line.charAt(l.i + offset)

const until = (s: string, from: number, c: string) => {
  const found = s.indexOf(c, from)
  return found === -1 ? s.length : found
}

/** Where the bracket opened before `from` closes, past nested ones and quotes. */
const closing = (s: string, from: number) => {
  let depth = 1
  let quote = ""
  for (let i = from; i < s.length; i += 1) {
    const c = s.charAt(i)
    if (quote !== "") {
      quote = c === quote ? "" : quote
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === "\\") {
      i += 1
    } else if (c === "(" || c === ")") {
      depth += c === "(" ? 1 : -1
      if (depth === 0) {
        return i
      }
    }
  }
  return s.length
}

const endWord = (l: Lexer) => {
  if (l.inWord) {
    l.words.push(l.word)
    l.word = ""
    l.inWord = false
  }
}

const endCommand = (l: Lexer) => {
  if (l.words.length > 0) {
    l.commands.push(l.words)
    l.words = []
  }
}

/** `$(…)` or a backquote from `open`: its commands go first; what it prints stands as `$`. */
const substitution = (l: Lexer, open: number, backquote: boolean) => {
  const close = backquote ? until(l.line, open, "`") : closing(l.line, open)
  l.commands.push(...simpleCommands(l.line.slice(open, close)))
  l.word += "$"
  l.inWord = true
  l.i = close + 1
}

const doubleQuoted = (l: Lexer) => {
  l.i += 1
  l.inWord = true
  while (l.i < l.line.length && at(l) !== '"') {
    const d = at(l)
    if (d === "\\" && '"\\$`'.includes(at(l, 1)) && l.i + 1 < l.line.length) {
      l.word += at(l, 1)
      l.i += 2
    } else if (d === "$" && at(l, 1) === "(") {
      substitution(l, l.i + 2, false)
    } else if (d === "`") {
      substitution(l, l.i + 1, true)
    } else {
      l.word += d
      l.i += 1
    }
  }
  l.i += 1
}

const newline = (l: Lexer) => {
  endWord(l)
  endCommand(l)
  l.i += 1
  // Here documents' bodies, line by line to each delimiter.
  for (const h of l.heredocs) {
    while (l.i < l.line.length) {
      const eol = until(l.line, l.i, "\n")
      const body = l.line.slice(l.i, eol)
      l.i = eol + 1
      if ((h.tabs ? body.replace(/^\t+/u, "") : body) === h.delimiter) {
        break
      }
    }
  }
  l.heredocs = []
}

const operator = (l: Lexer) => {
  endWord(l)
  // `2>&1` and `&>` are redirections, not a list's `&`.
  if (at(l) === "&" && (at(l, 1) === ">" || at(l, -1) === ">")) {
    l.i += 1
    return
  }
  endCommand(l)
  l.i += 1
}

const BREAKS = ";&|<>()"

const hereDocument = (l: Lexer) => {
  let j = l.i + 2
  const tabs = l.line.charAt(j) === "-"
  j += tabs ? 1 : 0
  while (l.line.charAt(j) === " " || l.line.charAt(j) === "\t") {
    j += 1
  }
  let delimiter = ""
  while (j < l.line.length && !/\s/u.test(l.line.charAt(j)) && !BREAKS.includes(l.line.charAt(j))) {
    const d = l.line.charAt(j)
    delimiter += d === "'" || d === '"' || d === "\\" ? "" : d
    j += 1
  }
  l.heredocs.push({ delimiter, tabs })
  l.i = j
}

/** The word a redirection sends to: skipped, quotes and all. */
const target = (l: Lexer) => {
  while (at(l) === " " || at(l) === "\t") {
    l.i += 1
  }
  let quote = ""
  while (l.i < l.line.length) {
    const t = at(l)
    if (quote !== "") {
      quote = t === quote ? "" : quote
    } else if (t === "'" || t === '"') {
      quote = t
    } else if (/\s/u.test(t) || BREAKS.includes(t)) {
      return
    }
    l.i += 1
  }
}

const redirection = (l: Lexer) => {
  // A file descriptor's number just before it isn't a word (`2>`).
  if (l.inWord && /^\d+$/u.test(l.word)) {
    l.word = ""
    l.inWord = false
  }
  endWord(l)
  if (at(l) === "<" && at(l, 1) === "<" && at(l, 2) !== "<") {
    hereDocument(l)
    return
  }
  l.i += 1
  while (l.i < l.line.length && "<>|".includes(at(l))) {
    l.i += 1
  }
  if (at(l) === "&") {
    l.i += 1
    while (l.i < l.line.length && /[\d-]/u.test(at(l))) {
      l.i += 1
    }
    return
  }
  target(l)
}

const plain = (l: Lexer, c: string) => {
  l.word += c
  l.inWord = true
  l.i += 1
}

const step = (l: Lexer) => {
  const c = at(l)
  if (c === "\\") {
    const next = at(l, 1)
    if (next !== "" && next !== "\n") {
      plain(l, next)
      l.i += 1
      return
    }
    l.i += 2
  } else if (c === "'") {
    const close = until(l.line, l.i + 1, "'")
    l.word += l.line.slice(l.i + 1, close)
    l.inWord = true
    l.i = close + 1
  } else if (c === '"') {
    doubleQuoted(l)
  } else if (c === "$" && at(l, 1) === "(") {
    substitution(l, l.i + 2, false)
  } else if (c === "`") {
    substitution(l, l.i + 1, true)
  } else if (c === "#" && !l.inWord) {
    l.i = until(l.line, l.i, "\n")
  } else if (c === " " || c === "\t") {
    endWord(l)
    l.i += 1
  } else if (c === "\n") {
    newline(l)
  } else if (";&|()".includes(c)) {
    operator(l)
  } else if (c === "<" || c === ">") {
    redirection(l)
  } else {
    plain(l, c)
  }
}

/**
 * A command line's simple commands, each as its words with quotes taken off, in the order they'd
 * run: split at `;`, `&`, `|`, newlines and parentheses, with each `$(…)` and backquoted command
 * among them, ahead of the command it's in. Redirections, comments and here documents' bodies
 * aren't words.
 */
export const simpleCommands = (line: string): string[][] => {
  const l: Lexer = {
    line,
    i: 0,
    word: "",
    inWord: false,
    words: [],
    commands: [],
    heredocs: [],
  }
  while (l.i < line.length) {
    step(l)
  }
  endWord(l)
  endCommand(l)
  return l.commands
}
