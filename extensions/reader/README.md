# switch-ext-reader

Documents of any common kind in Switch's reader: a word's definition and a name's Wikipedia article a selection away, notable terms linked, follow-up questions each in a thread of its own, and what those threads settle pinned to the passage as notes in the margin, found again wherever another document mentions the same term.

Reads Switch's published pages, web articles, PDF, EPUB, DOCX, Markdown, plain text, CSV, code, and (on macOS) RTF, DOC and ODT. A PDF's bookmarks and an EPUB's contents come with its words (`content`'s `outline`), for the reader's contents. Definitions come from Wiktionary, summaries from Wikipedia, each kept with its document so none is fetched twice; a thread's answers from Switch itself (the kit's `Switch.ask`), a real turn in a side thread of the document's space, given the document and the passage: the space's chat knows of it but never shows it. That turn pins what it settles (a definition, an idea explained, a link) to the passage with `annotate`; a note is anchored by its quoted words and the words around them, so it survives small edits, and is matched to other documents by its term when they're read.

A [Switch](https://github.com/zachsents/switch) extension, built on [switch-ext-kit](../../packages/kit).

## Tools

`open`, `documents`, `document`, `content`, `define`, `highlight`, `unhighlight`, `highlights`, `ask`, `threads`, `thread`, `annotate`, `notes`, `edit_note`, `delete_note`. Events: `reader.opened`, `reader.linked`, `reader.highlighted`, `reader.unhighlighted`, `reader.asked`, `reader.answered`, `reader.noted`, `reader.unnoted`, `reader.looked_up`, `reader.heartbeat`.

## Widgets

`document` (a document: in a chat, a line that opens it; in its own window, the reader) and `documents` (what's been opened).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
