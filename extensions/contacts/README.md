# switch-ext-contacts

People and companies in one set: the Apple and Google address books, other extensions' contacts and
everyone who messages the user, merged, with every field's source and confidence. Switch is the
source of truth: each book is imported once (a card merges into someone only on a shared phone,
email or handle and the same name), then gets what Switch holds. Every change is a batch that can be
undone, including what went out to Apple or Google. Its widget: a person card for chat.

## Fields

Name, given and family name (or the family initial alone), nickname, type (person, company or
system, or unset), labels, relationship to the user, phones, emails, social handles and links,
company, role, location, birthday, relations, notes. Every write is made normal, whatever its
source: phones in E.164 (read in `CONTACTS_REGION`, else the US), names without emoji or styled
letters and cased when typed all lower or all upper (McX, O'X and particles kept right), a tag
after a name ("Ann Lee · Acme") moved to a label, and a full name split into given and family when
that's all there is. The `normalize` tool does it once to everything already there.

## Sync

| Switch | Apple | Google |
| --- | --- | --- |
| given, family (or initial) | first, last | given, family |
| nickname | nickname | nickname |
| company, role | organization, job title | organization |
| type | company card (person or company) | — |
| note | note | biography |
| phones, emails, links, handles | phones, emails, URLs | phones, emails, URLs |
| labels | groups | labels |
| relationship | the Me card's related names | — |

Every two minutes changes go out. A value the book holds that Switch once held too is replaced by
Switch's; one Switch never saw is the user's edit there, left alone and recorded as a conflict. A
person merged from several cards in one book keeps the first-linked card, which gets everything;
the rest are deleted, each kept whole in the log so undo brings it back. Nothing goes to a book
before it's been imported, and nothing already there changes without a backup of both books from
the last hour in `contacts-backup/<time>/` (`apple.vcf`, `apple.json`, `google.json`).

A [Switch](https://switch.ax) extension, built on
[switch-ext-kit](../../packages/kit).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/contacts`, or add it in the desktop's
Extensions view (⌘K, Extensions). It runs on a Mac (it reads Contacts through Contacts.app).

## Setup

- Connect a Google account with contacts access when Switch asks.
- Allow the host to control Contacts the first time it reads them.
- Apple is imported as soon as Contacts answers, Google as soon as it's connected (or run the
  `import` tool). Everyone who messages the user comes in as their messages land in the brain
  (texts, Gmail, Instagram, a business's conversations), other sources every hour, and changes go
  out every two minutes (`CONTACTS_LOOPS=0` turns these off). A record or event that fails is kept
  in `contacts-skipped.json` and tried again every five minutes; `contacts.heartbeat` says what's
  failing and how far behind the brain's messages it is. Its log, state and backups live in
  `$SWITCH_CONTACTS_DIR`, else the folder it runs in (its own, under the host); what an older
  version kept in `$SWITCH_DIR` (else `~/.switch`) moves there on the first start.

Another extension adds people by emitting `<extension>.contact` events with `{ ref, name?, aliases?,
emails?, phones?, handles?, company?, role?, note?, spaces? }`.

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```

## Mac app

`Contacts.app` (Electrobun) is the extension's own window: search as you type, a person's every
field with its source and confidence, merges and every change with its undo. It reads and changes
people only through this extension's tools,
via the core (`$SWITCH_CORE`, else the core in `~/.switch/config.json`), and follows the brain's
contacts events to stay current. It dials in as the extension `contacts-app`, so the agent can open,
search, pick and screenshot it.

```sh
bun run app         # dev
bun run app:build   # signed with the Developer ID in ~/.switch/deploy.json, if there is one
```

## iPhone

`ios/` is Contacts for iPhone (SwiftUI, XcodeGen). It reaches this extension through Switch's core,
calling the same tools an agent does. `sh ios/build.sh` installs it on a paired iPhone;
`--simulator` builds it for the simulator. Team, bundle id prefix and the core's address come from
the environment or a `deploy.local` (`ios_team`, `ios_bundle_prefix`, `ios_core`), never the source.
