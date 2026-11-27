# switch-ext-reader

Documents of any common kind in Switch's reader: a word's definition and a name's Wikipedia article a selection away, notable terms linked, and follow-up questions each in a thread of its own.

Reads Switch's published pages, web articles, PDF, EPUB, DOCX, Markdown, plain text, CSV, code, and (on macOS) RTF, DOC and ODT. Definitions come from Wiktionary, summaries from Wikipedia; a thread's answers from the user's own turn model, given the document and the passage.

A [Switch](https://github.com/zachsents/switch) extension, built on [switch-ext-kit](../../packages/kit).

## Tools

`open`, `documents`, `document`, `content`, `define`, `highlight`, `unhighlight`, `highlights`, `ask`, `threads`, `thread`. Events: `reader.opened`, `reader.linked`, `reader.highlighted`, `reader.unhighlighted`, `reader.asked`, `reader.answered`, `reader.heartbeat`.

## Widgets

`document` (a document: in a chat, a line that opens it; in its own window, the reader) and `documents` (what's been opened).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
