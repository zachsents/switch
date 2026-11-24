# Desktop in Rust: porting notes

A slice of `apps/desktop` on gpui and UI SDK for gpui (tag v0.1.0, gpui at the rev it pins). It
reads the core the way the desktop does: this Mac's `~/.switch/config.json` core, the desktop's
credential (its file, then the Keychain; pairs if neither works), the snapshot, then live events on
the sync socket with `?since=`, older pages on request. It writes nothing but `message.post`.

Run: `sh scripts/bundle.sh && open "build/Switch GPUI.app"`.

## In the slice

- The rail: the spaces inside (banners or rows, as `pref space.inside` says), Needs you, Running,
  each space's marks counting the spaces under it.
- The band: ‹ ›, the stations above, the page's ring and name; "Can't reach the brain" when down.
- A space's chat: bubbles in runs with tails, the time over a gap, Markdown, blips, pictures and
  file cards (a click saves to Downloads and opens), mentions, Edited, More, pending and Not sent,
  typing while the space's turn answers. gpui's list, virtualized, following the tail, Latest ↓,
  older pages at the top. Each chat is made once and kept, so going back is instant.
- The box: UI SDK's Textarea; Enter sends; the saved draft goes in once, as the box is first drawn.
- A task opened from Running: its transcript, "N steps" folds (UI SDK's Collapsible), the live step.
- Theme from `pref theme` (background, three lines, inks worked out from the background, text size).
- Keys: ⌘[ ⌘] back and forward, Esc up a space, / to the box.

## Left for the full port


## The chat (agent 1)

- Selection (`select.rs`): gpui draws text with no selection of its own, so each run of words is a
  `SelText` (gpui's `StyledText`, laid out once) that notes where it was drawn and paints its part of
  the selection under its glyphs. A drag selects across bubbles (and scrolls the column past its
  edges), a double-click a word, a triple-click a paragraph, ⇧ extends, ⌘C copies (runs of one line
  a line apart, lines a paragraph apart). A run never drawn (scrolled past too fast) isn't copied.
- The words bar and tapbacks are one menu (`tapback.rs`), floated with gpui's `anchored`, over the
  bubble or the words' first line, under them when there's no room above.
- More shows for a reply's detail and for agent words past 24 lines. The TS writes `more ?? clamped`,
  where `more` is never null, so it never shows More for a clamped reply alone; its comment says it
  should, so this does.
- 3D models are drawn natively (`model3d.rs`, wgpu, one device): 60 fps on the mini with a 1M-triangle
  STL at 640 × 480, 2–6 ms of main-thread time a frame. 3MF colour groups keep their colours.
- Video and sound play natively (`media.rs`): AVPlayer, its frames on gpui's surface (BT.601), the
  tile painting its own rounded frame; sound has the widgets' transport, 320 wide.
- Inline code has no "Copy" tip and keeps the words' size: gpui sets a tooltip on an element, not on
  part of a run of text, and one size per run of text (the desktop's code is 0.9 em). It copies on a
  click with the copy cursor, as there.
- Raw HTML in a reply is read as the desktop's Streamdown reads it: rehype-sanitize's GitHub schema
  (ammonia, with `tel:`, `switchboard:` and `switch:` besides), so an unknown tag like `<printer>`
  in prose goes and its words stay, as there. Math (`$…$`) and mermaid fences stay text and code,
  also as there: Streamdown 2.8 renders them only through its `math` and `mermaid` plugins, and
  `markdown.tsx` passes none.

- Keys (audit round 2): a key typed outside a field goes to the box only as one printable character
  (Enter, Tab and a focused button's Space are the button's, pressed on the key's release as
  gpui's keyboard click does). Tab reaches what the desktop's does in a chat: reply insets, clamped
  words, files, pictures, code blocks, details, tapbacks, Latest, Cancel; a bubble's bar shows with a
  key in it focused (`focus-within`), as there, so a bubble with none has no Copy on Tab. Links in
  words aren't Tab stops: they're runs of one `StyledText`, and gpui gives focus to elements only.
- Citation chips keep the words' size (the desktop's are 12 px): gpui sets one size per run of text.
- Remend (`smooth.rs`) closes what's open in a reply's last paragraph (code fences anywhere); the
  desktop's remend 1.5 reads CommonMark delimiter runs, which this approximates by counting.
- Footnotes are laid out as remark-gfm's (numbers in the order first referred to, the notes an
  ordered list at the end with ↩), from pulldown-cmark's events.
- A 3D model's click doesn't open Preview and its drag turns it, as `model.tsx` has it (no click
  handler there; the file line under it opens the file).
- "Moved" lines: nothing to port; main dropped them (`d055b96`), and this draws none either.

## The parity ledger

Every file under `apps/desktop/src`, its agent (1 chat and box, 2 asks, widgets, pages and web
content, 3 shell, navigation and settings, 4 platform and packaging, 5 data layer), its Rust module,
and where it stands: done, partial, open (not started), or not ported (with why). Agent 5 keeps it
current from the commits on `gpui-desktop` and each area's own table; an area's table has the
detail.

| TS file (`apps/desktop/src/`) | Agent | Rust module | Status |
|---|---|---|---|
| `bun/auth.ts` | 4 | `auth.rs`, `net.rs` | done: the Keychain item the desktop keeps (asked with no prompt), else the desktop's file; mint on loopback, else pair; one refused is dropped and paired again as the socket dials (revoking closes the socket) |
| `bun/dictation.ts` | 4 | `platform/dictation.rs` | done |
| `bun/extension.ts` | 4 | `platform/extension.rs`, `platform/snapshot.rs`, `platform/notify.rs` | done: rmcp over the socket, the token in a header; a notification's click opens its space directly |
| `bun/files.test.ts` | 4 |  | not ported: a test (no tests) |
| `bun/files.ts` | 4 | `platform/files.rs`, `platform/quicklook.rs` | done |
| `bun/frame.ts` | 4 | `platform/windows.rs` | done: frames on a display, at least 200 a side; the full-screen-video workaround is Electrobun's own and not needed |
| `bun/index.ts` | 4 | `platform/lifecycle.rs`, `main.rs` | done |
| `bun/local.ts` | 3 | `local.rs` | done |
| `bun/menu.ts` | 3 | `menu.rs`, `native_menu.rs` | done |
| `bun/mesh.ts` | 4 | `platform/mesh.rs` | done |
| `bun/native.ts` | 4 | `platform/helpers.rs` | done |
| `bun/oauth-relay.ts` | 4 | `platform/oauth.rs` | done (tiny_http loopback) |
| `bun/reading.ts` | 4 | `platform/windows.rs`, `reading.rs` (its page) | done for the reading window; Settings, a widget's and an ask's windows are their pages' (the spare window kept ready isn't needed: gpui draws a window whole on its first frame) |
| `bun/still.ts` | 4 | `platform/appkit.rs` (`still`), `platform/lifecycle.rs` (`still_all`) | done: every window; see-through until drawn isn't needed |
| `bun/timing.ts` | 4 | `platform/timing.rs` | done: shown and painted are the first frame |
| `bun/update.ts` | 4 | `platform/update.rs` | done: its own feed (scripts/ship.sh), the same rules; Settings' version and Update now |
| `bun/watch.ts` | 4 | `platform/watch.rs` | done: the main thread's beat stands in for the view's |
| `bun/window-state.ts` | 4 | `local.rs`, `platform/update.rs`, `platform/files.rs`, `look.rs` | done: every window reads the same entities and globals |
| `mainview/app.tsx` | 3 | `app.rs`, `shell.rs` | done |
| `mainview/brain/accounts.ts` | 5 | `queries.rs` (accounts), `mutations.rs` (`account_request`) | done |
| `mainview/brain/adapter.ts` | 5 | `brain.rs`, `items.rs` (items, placements), `derive.rs` (`live_step`) | done |
| `mainview/brain/auth.ts` | 5 | `net.rs` (`auth`, `core`, `core_url`, `portal_url`), `auth.rs` | done |
| `mainview/brain/client.ts` | 5 | `model.rs`, `net.rs` | done |
| `mainview/brain/connection.ts` | 5 | `net.rs` | done; one window per process, so another window's keeps (`OTHERS_AFTER`) and a core change mid-run don't arise; a refused credential pairs again |
| `mainview/brain/derive.ts` | 5 | `derive.rs` | done |
| `mainview/brain/files.ts` | 5 | `files.rs`, `mutations.rs` (`choose`, uploads) | done |
| `mainview/brain/find.ts` | 5 | `queries.rs` (`find`, `find_in`) | done |
| `mainview/brain/forms.ts` | 5 | `mutations.rs` (`can_post`, `has_words`) | done |
| `mainview/brain/history.ts` | 5 | `brain.rs` (chats, transcripts) | done |
| `mainview/brain/item-mutations.ts` | 5 | `mutations.rs` | done |
| `mainview/brain/items.ts` | 2 | `items.rs` | done |
| `mainview/brain/json.ts` | 5 | `json.rs` | done |
| `mainview/brain/models.ts` | 5 | `queries.rs` (`models`), `mutations.rs` (profiles) | done |
| `mainview/brain/mutations.ts` | 5 | `model.rs`, `mutations.rs` | done |
| `mainview/brain/outbox-files.ts` | 5 | `outbox.rs` (files beside the document) | done |
| `mainview/brain/outbox.ts` | 5 | `outbox.rs` | done; kept in a file per core instead of localStorage (no older-build list to read) |
| `mainview/brain/pages.ts` | 5 | `model.rs` (`want_chat`, `older_chat`, `want_thread`, `older_thread`) | done |
| `mainview/brain/providers.ts` | 5 | `queries.rs` (`registry`), `mutations.rs` (`add_provider`, `add_account`) | done |
| `mainview/brain/step.ts` | 5 | `steps.rs` | done |
| `mainview/brain/store.ts` | 5 | `brain.rs` | done |
| `mainview/brain/system.ts` | 5 | `queries.rs` (`memories`, `system`) | done |
| `mainview/brain/use-brain.ts` | 5 | `model.rs` (`model(cx)`, observed) | done |
| `mainview/brain/use-chat.ts` | 5 | `model.rs` (`reach_chat`), `derive.rs` (`chat`) | done |
| `mainview/brain/use-transcript.ts` | 5 | `brain.rs` (`transcript`), `model.rs` (`retry_thread`) | done |
| `mainview/dictation/dictation.ts` | 4 | `platform/dictation.rs` | done |
| `mainview/dictation/words.ts` | 4 | `platform/words.rs` | done: UTF-8 offsets, as the text field's |
| `mainview/drive.ts` | 4 | | not ported: nothing calls `window.switchDrive` (the journey scripts drive by points, keys and menus); `shot.rs` opens pages by id for looking without a screen |
| `mainview/index.css` | 3 | `look.rs`, `kit.rs`, `marks.rs`, `select.rs`, `chat.rs`, `widgets/column.rs` | done: tokens, type, lines and rows, the runner, selectable words, typing, the widget column's spacing |
| `mainview/index.html` | 4 | `main.rs` | done: one native window |
| `mainview/main.tsx` | 3 | `main.rs`, `theme.rs`, `queries.rs`, `asks/window.rs`, `widgets/window.rs` | done: the theme on the first frame; the windows of one thing are native windows; Temporal and React's root have no counterpart |
| `mainview/query.ts` | 5 | `queries.rs` (defaults: 30 s fresh, one retry) | done |
| `mainview/ui/action-error.tsx` | 2 | `settings/parts.rs` (`action_error`) | done: `role=alert` (VoiceOver reaches it by its words) |
| `mainview/ui/activity-row.tsx` | 3 | `rail.rs` (`activity_row`) | done |
| `mainview/ui/ask-answer.tsx` | 2 | `asks/card.rs` | done: a field's hairline ink3 while it has the keyboard (a draft's box while its field does), the whole box the click, a draft's label too; an option's files by its index as a number (`===`), each files row its own sideways scroll; errors are alerts, read out as they show |
| `mainview/ui/ask-card.tsx` | 2 | `asks/card.rs` | done: the age again every 30 s (`useNow`); title and words selectable as one, the words in ink2; what's held and the brain's reason for refusing it are the card's own |
| `mainview/ui/ask-decided.tsx` | 2 | `asks/card.rs` | done |
| `mainview/ui/ask-ending.tsx` | 2 | `asks/card.rs`, `asks/chat.rs` | done |
| `mainview/ui/ask-files.tsx` | 2 | `asks/files.rs` | done |
| `mainview/ui/ask-in-chat.tsx` | 2 | `asks/chat.rs`, `chat.rs` | done: a closed ask's line is a key; an ask that closes or leaves the chat drops its card, so open again it's a fresh one, its closed line drawn or not |
| `mainview/ui/ask-outcome.ts` | 2 | `items.rs` (`ending_of`, `detail_of`, `recipient_of`) | done |
| `mainview/ui/ask-portal.tsx` | 2 | `asks/portal.rs`, `webview.rs` | done: none in a quiet copy (its page would act on the remote Mac with the credential); the live screen streams only while drawn (let go two seconds off screen), and goes with its card (closed, gone from the chat, its space left); the picture is a key; the controller lies over the whole window as a dialog, the page takes keys, wheel and pointer; Esc in the live screen is the remote Mac's (the page has the keys, as the desktop's frame does); the controller's own Esc, with the window's keys, closes it and nothing else (not the ask's window, not up a space), the keyboard back on the picture, as when it ends |
| `mainview/ui/ask-reply.tsx` | 2 | `asks/card.rs` | done: closed (or sent), the reply goes with its words and error, a fresh one when it opens again; opened, the field has the keys (its `autoFocus`); Reply says it's pressed |
| `mainview/ui/ask-sealed.tsx` | 2 | `asks/card.rs`, `mutations.rs` (`answer_sealed`) | done: label and placeholder `sealed.use` as it is, else "Secret" |
| `mainview/ui/attached.tsx` | 1 | `attached.rs` | done: a row of pictures and videos that scrolls sideways (count under it when it holds more than it shows), a lone picture, sound, 3D files, a file line that turns while it opens; Open, Quick Look, the file menu (platform/files.rs). Its overlay scrollbar isn't drawn: the row scrolls by trackpad and wheel |
| `mainview/ui/band.tsx` | 3 | `band.rs` | done |
| `mainview/ui/blip.tsx` | 1 | `quiet.rs` | done |
| `mainview/ui/boundary.tsx` | 4 | `boundary.rs` | done: the band, a space's rail and chat, a thread, the palette, each widget, a widget's window and Settings each build inside one; a panic while one builds shows "Can't show this" and Retry there, and is an error report (`client.crashed`); a panic while gpui lays out or paints is past every section, a crash |
| `mainview/ui/box.tsx` | 1 | `chatbox.rs` | done: Enter and ⇧Enter, "/" and typing or ⌘V from anywhere, ↑ to edit the last message, Esc, Editing and Cancel, the error and dictation rows, reply rows, chips uploading at once (the outbox), files dropped on the chat or pasted, the mic and its meter, ✓ and ×, the "/" keycap in the placeholder, the column width past 768 px |
| `mainview/ui/chat-asks.ts` | 2 | `asks/chat.rs` (used by `chat.rs`) | done |
| `mainview/ui/chat.tsx` | 1 | `chat.rs`, `said.rs` | done |
| `mainview/ui/chip.tsx` | 1 | `chatbox.rs` | done |
| `mainview/ui/cite.tsx` | 1 | `markdown.rs` | done: a citation is a chip-colored run in the words (gpui lays out text runs, not boxes, inline) |
| `mainview/ui/code.tsx` | 1 | `markdown.rs` | done |
| `mainview/ui/connection-actions.tsx` | 3 | `settings/connection_actions.rs` (`connection_actions`) | done: the ask card draws it beside its buttons |
| `mainview/ui/connection-verify.tsx` | 3 | `settings/connection_actions.rs` | done: "Not signed in" an alert too |
| `mainview/ui/connections-page.tsx` | 3 | `settings/connections.rs` | done |
| `mainview/ui/connections.ts` | 3 | `settings/connection_actions.rs` (`connect`, `run_action`, `cancel_connection`), `mutations.rs`, `queries.rs` (needs), `platform/oauth.rs` | done: a returned view opens `widgets/window.rs`, an item dispatches `OpenItem` |
| `mainview/ui/devices-section.tsx` | 3 | `settings/devices.rs` | done |
| `mainview/ui/devices.ts` | 3 | `mutations.rs` | done |
| `mainview/ui/emoji-find.ts` | 1 | `tapback.rs`, `emoji.json` | done: emojibase 18's en data, kept as its table (emoji, name, keywords, order) |
| `mainview/ui/emoji-search.tsx` | 1 | `tapback.rs` | done |
| `mainview/ui/extension-add.tsx` | 3 | `settings/extensions.rs` | done |
| `mainview/ui/extensions-page.tsx` | 3 | `settings/extensions.rs` | done |
| `mainview/ui/extensions.ts` | 3 | `mutations.rs` | done |
| `mainview/ui/find-bar.tsx` | 3 | `find.rs`, `chat.rs` (reveals `find::target`) | done |
| `mainview/ui/follow-end.ts` | 1 | `chat.rs`, `thread.rs` | done |
| `mainview/ui/gallery.tsx` | 3 |  | not ported: the web look's dev-only page (`#gallery`); the Rust app's frames are looked at with `--features shot` |
| `mainview/ui/history-keys.tsx` | 3 | `band.rs` | done |
| `mainview/ui/inline-image.tsx` | 1 | `markdown.rs` | done |
| `mainview/ui/item-held.ts` | 2 | `asks/window.rs` | done |
| `mainview/ui/item-window.tsx` | 2 | `asks/window.rs`, `asks/mod.rs` | done: 640×480 at the centre, on screen, unseen (no frames come to a window off screen), and seen once the card is drawn and the window fits it, from one click (at most 720, its bottom edge kept, as bun/reading.ts's `fit`); titled with the ask; not opened on an ask the brain, caught up, doesn't hold; Esc closes it wherever the keyboard was |
| `mainview/ui/kit/button.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/kit/confirm.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/kit/float.ts` | 3 | `kit.rs` | done |
| `mainview/ui/kit/pick.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/kit/segmented.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/kit/select.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/kit/window.ts` | 3 | `kit.rs` | done |
| `mainview/ui/link.tsx` | 1 | `markdown.rs`, `chat.rs` (`on_link`) | done |
| `mainview/ui/links.ts` | 3 | `links.rs` | done |
| `mainview/ui/look.ts` | 3 | `derive.rs` (stations) | done |
| `mainview/ui/markdown.tsx` | 1 | `markdown.rs` | done: Streamdown's reading (CommonMark, GitHub's tables, strikethrough, task lists, bare addresses), raw HTML through rehype-sanitize's GitHub schema (ammonia, read back with scraper; ids made links before it; tables as wide as their words with spans and alignment; GitHub's footnotes; a picture with no address its words; `details` open and shut, `kbd`/`samp` in mono, `sup`/`sub` as their Unicode forms where there are any), record links, pictures, margins collapsing as a page's. Math and mermaid stay their text, as in the desktop: Streamdown 2.8 draws them only with its math and mermaid plugins, which `markdown.tsx` doesn't pass |
| `mainview/ui/marks.tsx` | 3, 1 | `marks.rs`, `chat_marks.rs` (NotDelivered, Spin, Copy, the tapbacks', mic's) | done |
| `mainview/ui/memory-item.tsx` | 3 | `settings/memory.rs` | done |
| `mainview/ui/memory-page.tsx` | 3 | `settings/memory.rs` | done |
| `mainview/ui/mic.tsx` | 1 | `chatbox.rs` (keys), platform/dictation.rs (engine) | done |
| `mainview/ui/model.tsx` | 1 | `model3d.rs` | done natively: wgpu, one device for every model, 60 fps on the mini at 1M triangles (2–6 ms a frame); 3MF read with zip and quick-xml |
| `mainview/ui/nav.ts` | 3 | `nav.rs` | done |
| `mainview/ui/needs-you.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/notify-prefs.ts` | 3 | `settings/notifications.rs` | done |
| `mainview/ui/pairing.tsx` | 3 | `app.rs` | done; no letter-spacing in gpui |
| `mainview/ui/palette-choices.tsx` | 3 | `palette.rs` | done |
| `mainview/ui/palette.tsx` | 3 | `palette.rs` | done |
| `mainview/ui/pane-scroll.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/parts.tsx` | 3 | `kit.rs`, `band.rs` | done |
| `mainview/ui/picture-row.tsx` | 1 | `attached.rs` | done |
| `mainview/ui/qr.tsx` | 3 | `settings/qr.rs` (qrcode crate, drawn as quads) | done |
| `mainview/ui/query-devtools.tsx` | 5 |  | not ported: TanStack's devtools, a dev build's |
| `mainview/ui/quiet-line.tsx` | 1 | `quiet.rs` | done |
| `mainview/ui/rail-section.tsx` | 3 | `rail.rs` | done; no letter-spacing in gpui (the headings' 0.06em) |
| `mainview/ui/rail.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/reading-page.tsx` | 1 | `reading.rs` | done |
| `mainview/ui/rename-field.tsx` | 3 | `band.rs` | done |
| `mainview/ui/reply-rows.tsx` | 1 | `chatbox.rs` | done |
| `mainview/ui/replying.ts` | 1 | `replying.rs` | done |
| `mainview/ui/reports.ts` | 4 | `platform/watch.rs` | done |
| `mainview/ui/running-section.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/runs.ts` | 1 | `chat.rs` | done |
| `mainview/ui/said-bar.tsx` | 1 | `said.rs`, `tapback.rs` | done |
| `mainview/ui/said-replies.tsx` | 1 | `said.rs`, `select.rs` (`find`) | done |
| `mainview/ui/scroll.tsx` | 1 | `chat.rs`, `thread.rs` | done: gpui's list, bottom-aligned, following the tail; Latest; older pages at the top; a line brought into view, centred; the overlay thumb under the pointer |
| `mainview/ui/scrollbar.tsx` | 1 | `follow.rs` | done: the chat's, a task's and the reading window's thumb, 2 px in; a picture row has none |
| `mainview/ui/settings/account-completion.tsx` | 3 | `settings/providers.rs` (`completion`) | done |
| `mainview/ui/settings/account-row.tsx` | 3 | `settings/providers.rs` (`account_row`) | done |
| `mainview/ui/settings/accounts.ts` | 3 | `settings/accounts.rs` | done |
| `mainview/ui/settings/color-field.tsx` | 3 | `color_panel.rs` | done |
| `mainview/ui/settings/devices.tsx` | 3 | `settings/devices.rs` | done |
| `mainview/ui/settings/general.tsx` | 3 | `settings/general.rs` | done |
| `mainview/ui/settings/notifications.tsx` | 3 | `settings/notifications.rs` | done |
| `mainview/ui/settings/profile-form.tsx` | 3 | `settings/profiles.rs` (`profile_form`) | done |
| `mainview/ui/settings/profile-section.tsx` | 3 | `settings/profiles.rs` (`profile_section`) | done |
| `mainview/ui/settings/profiles.tsx` | 3 | `settings/profiles.rs` | done |
| `mainview/ui/settings/provider-add.tsx` | 3 | `settings/providers.rs` (`provider_add`) | done |
| `mainview/ui/settings/provider-cli.tsx` | 3 | `settings/providers.rs` (`provider_cli`) | done |
| `mainview/ui/settings/provider-models.tsx` | 3 | `settings/providers.rs` (`provider_models`) | done; the model names aren't selectable (gpui text has no selection) |
| `mainview/ui/settings/provider-section.tsx` | 3 | `settings/providers.rs` (`provider_section`) | done |
| `mainview/ui/settings/provider-sign-in.tsx` | 3 | `settings/providers.rs` (`sign_in`) | done |
| `mainview/ui/settings/providers.tsx` | 3 | `settings/providers.rs` | done |
| `mainview/ui/settings/role-choice.tsx` | 3 | `settings/profiles.rs` (`role_choice`) | done |
| `mainview/ui/settings/role-choices.ts` | 3 | `settings/role_choices.rs` | done |
| `mainview/ui/settings/setting.tsx` | 3 | `kit.rs` | done |
| `mainview/ui/settings/settings-window.tsx` | 3 | `settings/mod.rs` | done |
| `mainview/ui/settings/spaces.tsx` | 3 | `settings/spaces.rs` | done |
| `mainview/ui/settings/standing-mark.tsx` | 3 | `settings/providers.rs` (`standing_mark`), `marks.rs` (`warn`) | done |
| `mainview/ui/settings/theme-section.tsx` | 3 | `settings/theme.rs` | done |
| `mainview/ui/settings/use-account-action.ts` | 3 | `settings/act.rs` | done; settles when the route answers, as the accounts' re-read starts (`queries::invalidate` gives nothing to wait on) |
| `mainview/ui/settings/use-providers.ts` | 3 | `settings/accounts.rs` (`sections`) | done |
| `mainview/ui/shortcuts-sheet.tsx` | 3 | `shortcuts.rs` | done |
| `mainview/ui/smooth.ts` | 1 | `smooth.rs` | done |
| `mainview/ui/space-banner.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/space-chat.tsx` | 1 | `chat.rs` | done |
| `mainview/ui/space-line.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/space-page.tsx` | 3 | `app.rs` | done |
| `mainview/ui/space-view.ts` | 3 | `spaces.rs` | done |
| `mainview/ui/spaces-section.tsx` | 3 | `rail.rs` | done |
| `mainview/ui/spaces.ts` | 3 | `spaces.rs` | done |
| `mainview/ui/step-icons.tsx` | 1 | `step_icons.rs`, `marks.rs` | done |
| `mainview/ui/steps.tsx` | 1 | `thread.rs` | done |
| `mainview/ui/system-page.tsx` | 3 | `settings/system.rs` | done |
| `mainview/ui/tapback.tsx` | 1 | `tapback.rs` | done |
| `mainview/ui/theme.ts` | 3 | `theme.rs`, `look.rs` | done |
| `mainview/ui/thread.tsx` | 1 | `thread.rs` | done |
| `mainview/ui/time.ts` | 1 | `time.rs` | done |
| `mainview/ui/timeline-position.ts` | 1 | `chat.rs` | done: each chat's view is kept, so its place is kept with it |
| `mainview/ui/timeline-viewport.ts` | 1 | `chat.rs` | done: the wheel, a drag and the scroll keys (PageUp, PageDown, Home, End, arrows, Space) outside a field |
| `mainview/ui/use-box-draft.ts` | 1 | `chatbox.rs` over `outbox.rs` | done |
| `mainview/ui/use-bubble.ts` | 1 | `said.rs`, `select.rs` | done |
| `mainview/ui/use-commands.ts` | 3 | `commands.rs` | done |
| `mainview/ui/use-copy.ts` | 1 | `said.rs`, `markdown.rs` | done |
| `mainview/ui/use-draft-edits.ts` | 2 | `asks/card.rs`, `mutations.rs` (`keep_edit`, `kept_edit`, `edit_item`, `item_drafts`) | done |
| `mainview/ui/use-find-in.ts` | 3 | `find.rs` | done |
| `mainview/ui/use-held.ts` | 2 | `asks/card.rs`, `mutations.rs` (`hold`, `unhold`, `done`) | done |
| `mainview/ui/use-history-input.ts` | 3 | `app.rs` | done |
| `mainview/ui/use-menu.ts` | 3 | `menu.rs`, `spaces.rs`, `settings/mod.rs`, `links.rs` | done |
| `mainview/ui/use-now.ts` | 1 | `chat.rs` | done: the chat draws again on the beat |
| `mainview/ui/use-overflow.ts` | 1 | `attached.rs` (a row's scroll handle) | done |
| `mainview/ui/use-painted.ts` | 4 | `platform/timing.rs` | done: every window of one thing (an ask's, a reply's, a widget's, Settings) logs `open <kind>: shown N ms, painted N ms` at its first frame, which gpui draws whole, so it's seen and painted at once |
| `mainview/ui/use-read.ts` | 1 | `chat.rs` (`mark_read`) | done |
| `mainview/ui/use-shortcuts.ts` | 3 | `commands.rs`, `app.rs` | done |
| `mainview/ui/use-shown-page.ts` | 4 | `app.rs` | not needed: gpui's list lays out in the frame it's drawn, so a first open isn't blank |
| `mainview/ui/use-theme-sync.ts` | 3 | `theme.rs` | done |
| `mainview/ui/use-timeline-follow.ts` | 1 | `chat.rs` | done |
| `mainview/ui/use-track.ts` | 3 | `track.rs` | done |
| `mainview/ui/video-tile.tsx` | 1 | `media.rs` | done natively: AVPlayer's frames drawn with gpui's surface; one plays at a time; full screen in a window of its own |
| `mainview/ui/widget-cell.tsx` | 2 | `widgets/column.rs`, `widgets/render.rs` (`nothing`) | done: a cell with nothing to show (no words but headings' and captions', no picture, frame or glyph: an empty Row, an Entry, a Divider, an Image with no address it would show, a Feed with no frame yet) is drawn out of view, so a feed in it keeps asking for frames |
| `mainview/ui/widget-column.tsx` | 2 | `widgets/column.rs` | done |
| `mainview/ui/widget-window.tsx` | 2 | `widgets/window.rs` | done: a failed load is the boundary's fallback (`boundary::failed_read`), reported once, Retry asking again |
| `mainview/ui/window-page.tsx` | 2 | `asks/window.rs`, `widgets/window.rs`, `settings/mod.rs`, `platform/windows.rs` | done: each window of one thing is a native window |
| `mainview/ui/words-bar.tsx` | 1 | `tapback.rs`, `chat.rs`, `select.rs` | done |
| `mainview/ui/work-row.tsx` | 3 | `rail.rs` | done |
| `mainview/widgets/along.ts` | 2 | `widgets/house/playing.rs` | done |
| `mainview/widgets/basic/audio-player.tsx` | 2 | `widgets/basic/playback.rs` (a WebKit `<audio>` driven by the gpui transport) | done |
| `mainview/widgets/basic/button.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/card.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/catalog.ts` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/check-box.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/choice-picker.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/column.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/date-time-input.tsx` | 2 | `widgets/basic/controls.rs` | done: UI SDK's DatePicker (its words mm/dd/yyyy, typed or picked from Calendar floating under them, opened by a press or ⌥↓, Calendar's keys, `min` and `max`) and TimeInput (hours, minutes, AM/PM, typed or stepped); writes ISO 8601 keeping the other half as A2UI's own does, a cleared half as `date-time-input.tsx` writes it; `min` and `max` as the model says now; a press on its label focuses its first field |
| `mainview/widgets/basic/divider.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/each.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/flex.ts` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/gallery.tsx` | 2 | `widgets/basic/gallery.rs` (`--features shot`, `SWITCH_GPUI_PAGES=parts`) | partial: fixtures for what a cell hides, createSurface's own components and data, Pick, Check, a Row with a url and a note, Gallery, the controls, Modal, actions and checks, and the dates; driven by `SWITCH_GPUI_STEPS` (`click:x,y`, `hover:x,y`, `key:tab`, `type:words`, `wait:ms`, `shot:name`, `log` each fixture's data, `a11y` then `ax:name` the accessibility tree as JSON); the gallery's own fixtures aren't all ported |
| `mainview/widgets/basic/glyph.tsx` | 2 | `widgets/basic/icons.rs`, `marks.rs` (`icon/`, `path24/`) | done |
| `mainview/widgets/basic/held.ts` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/icon.tsx` | 2 | `widgets/basic/layout.rs`, `icons.rs` | done |
| `mainview/widgets/basic/icons.ts` | 2 | `widgets/basic/icons.rs` | done |
| `mainview/widgets/basic/image.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/in-key.ts` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/list.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/modal.tsx` | 2 | `widgets/basic/layout.rs` (UI SDK's Dialog) | done: the trigger a button named by its words, Tab kept inside while open, focus back on the trigger, Esc, a press outside or ✕ |
| `mainview/widgets/basic/problems.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/row.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/slider.tsx` | 2 | `widgets/basic/controls.rs` | done: a whole value written as one (2, not 2.0) |
| `mainview/widgets/basic/tabs.tsx` | 2 | `widgets/basic/layout.rs` | done: the Segmented drawn here as Base UI's ToggleGroup: a group named Tabs, each title a toggle pressed while chosen, one Tab stop, the arrows along |
| `mainview/widgets/basic/text-field.tsx` | 2 | `widgets/basic/` | done |
| `mainview/widgets/basic/text.tsx` | 2 | `widgets/basic/text.rs`, `markdown.rs` (the chat's Markdown, `cell`) | done: the chat's renderer as Streamdown with the house's components is, in the cell's layout text.tsx gives it (headings a line, semibold; paragraphs, lists, quotes and code inset; rules a line-2); a caption a line in ink3 |
| `mainview/widgets/basic/track.tsx` | 2 | `widgets/basic/controls.rs` (`track`) | done: its knob a slider named for screen readers, taking Tab with the ring; a press on the track focuses it; the arrows a step, Shift and Page Up and Down the large step (10), from the value on its step |
| `mainview/widgets/basic/transport.tsx` | 2 | `widgets/basic/playback.rs` | done: Play or Pause a named key (Space and Return press it once), the track named Position |
| `mainview/widgets/basic/use-media.ts` | 2 | `widgets/basic/playback.rs` | done |
| `mainview/widgets/basic/video.tsx` | 2 | `widgets/basic/playback.rs` (a WebKit `<video>` at its ratio, the gpui transport under it) | done |
| `mainview/widgets/basic/words.ts` | 2 | `widgets/basic/` | done |
| `mainview/widgets/call.ts` | 2 | `widgets/host.rs` (`call_tool`, an action's call), `mutations.rs` (`call_tool`, `call_checked`) | done |
| `mainview/widgets/catalog.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/charts/area-chart.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/bar-chart.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/bins.ts` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/calendar-heatmap.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/calendar.tsx` | 2 | `widgets/charts/calendar.rs` (holds the day it came onto, as the original holds the cell) | done |
| `mainview/widgets/charts/charts.ts` | 2 | `widgets/charts/` (each surface an application to VoiceOver, its drawn words labels, `parts::Drawn`) | done |
| `mainview/widgets/charts/data.ts` | 2 | `widgets/charts/data.rs` (a number label as `String(n)`; static props as written, not bound) | done |
| `mainview/widgets/charts/donut-chart.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/ends.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/figures.ts` | 2 | `widgets/charts/figures.rs`, `locale.rs` (Foundation's formatters; compact figures ICU4X's, in the locale, rounded as Intl's) | done |
| `mainview/widgets/charts/fixtures.ts` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/gallery.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/held.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/histogram.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/key.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/legend.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/line-chart.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/lone.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/look.ts` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/meter.tsx` | 2 | `widgets/charts/meter.rs` (`max` as written, divided as JavaScript divides) | done |
| `mainview/widgets/charts/peak.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/point.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/rows.ts` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/scatter-chart.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/segment.tsx` | 2 | `widgets/charts/cartesian.rs` (Recharts' stack, offset none) | done |
| `mainview/widgets/charts/slice.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/sparkline.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/ticks.ts` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/tip-box.tsx` | 2 | `widgets/charts/` | done |
| `mainview/widgets/charts/tip.tsx` | 2 | `widgets/charts/parts.rs` (placed as Recharts' `getTooltipTranslate` in the plot; the keys as its accessibility layer) | done |
| `mainview/widgets/charts/trend.tsx` | 2 | `widgets/charts/cartesian.rs` (axes' words as Recharts' `getTicks`, marks in its layers) | done |
| `mainview/widgets/chat-widget.tsx` | 2 | `widgets/chat_widget.rs` | done |
| `mainview/widgets/check.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/choices.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/entry.tsx` | 2 | `widgets/house/lines.rs` | done: its placeholder the model's as it changes; Enter sends unless with Control or ⌘ or while an input method composes |
| `mainview/widgets/feed.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/host.ts` | 2 | `widgets/host.rs`, `a2ui/`, `widgets/page.rs` | done: createSurface's own components and data model; actions as `{event}`, `{name, context}`, `{functionCall}` or `{call}`, one with no name calling nothing; checks as A2UI's binder reads them (only errors block, the check's message, the function's, "Validation failed"); a refresh during a load fetches again after it; McpApp's `allowedTools` and `allowedFunctions` read through bindings, a function the MCP catalog hasn't run from the surface's own catalog, its frame at most 2000 tall in a part as tall as it asked |
| `mainview/widgets/old-parts.ts` | 2 | `a2ui/mod.rs` | done |
| `mainview/widgets/page-theme.ts` | 2 | `widgets/page.rs` | done |
| `mainview/widgets/pick.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/pictures.tsx` | 2 | `widgets/house/gallery.rs` | done: a click is Quick Look on the saved pictures, from the one clicked |
| `mainview/widgets/playing.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/row.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/set-mutation.ts` | 2 | `mutations.rs` (`widget_set`), called by `widgets/house/lines.rs` (`run`: Pick's Set, Check's ring, Entry's Enter, Playing's keys) | done |
| `mainview/widgets/swatch.tsx` | 2 | `widgets/house/` | done |
| `mainview/widgets/use-prefetch.ts` | 2 | `widgets/host.rs` | done |
| `mainview/widgets/use-watch.ts` | 2 | `widgets/host.rs`, `net.rs` (`watch`) | done |
| `native/build.sh` | 4 | `build.rs` | done |
| `native/dictation.swift` | 4 | `native/dictation.swift` | done (the same helper) |
| `native/post-build.ts` | 4 | `scripts/bundle.sh` | done: the microphone's prompt |
| `native/quicklook.swift` | 4 | `native/quicklook.swift` | done (the same helper) |
| `native/snapshot.m` | 4 | `native/snapshot.m`, `platform/snapshot.rs` | done: gpui's frame rendered off screen, web views and the window's buttons drawn over |
| `shared/commands.ts` | 3 | `commands.rs`, `spaces.rs`, `menu.rs` | done |
| `shared/dictation.ts` | 4 | `platform/dictation.rs` | done |
| `shared/safe-error.ts` | 5 | `mutations.rs` (`safe_error`) | done |

## Parity: the shell, navigation, pages and settings

| TS file | Rust module | Status |
|---|---|---|
| `shared/commands.ts` (Command, SpaceMenu, MenuModel, spaceLink) | `commands.rs`, `spaces.rs`, `menu.rs` | done |
| `bun/menu.ts` (the menu bar, a space's right-click menu) | `menu.rs`, `native_menu.rs` | done: an NSMenu at the pointer; About is AppKit's panel |
| `ui/use-commands.ts` | `commands.rs` | done; ⌘D is passed on as `Do(Command::Dictate)` for dictation to answer |
| `ui/use-shortcuts.ts` (SHORTCUTS, Escape) | `commands.rs`, `app.rs` | done; Escape goes up unless the palette, ⌘F's bar, the sheet or a rename has it |
| `ui/use-menu.ts` | `menu.rs`, `spaces.rs`, `settings/mod.rs`, `links.rs` | done for the menu bar, right-click menus, Copy, Settings, an item's link (`OpenItem`); files, pictures, item and widget windows are the chat's, asks' and widgets'; typing's update hold is the platform's |
| `ui/nav.ts` | `nav.rs` | done (`Nav.at`: a chat line to bring into view) |
| `ui/use-history-input.ts` | `app.rs` | done: mouse side buttons, a two-finger swipe |
| `ui/use-track.ts` | `track.rs` | done |
| `ui/band.tsx`, `ui/history-keys.tsx` | `band.rs` | done; tips use gpui's tooltip delay, not 100 ms |
| `ui/rename-field.tsx` | `band.rs` (`RenameField`) | done |
| `ui/spaces.ts` | `spaces.rs`, `band.rs` (`space_menu`), `rail.rs` (right-click) | done |
| `ui/links.ts` | `links.rs`, `main.rs` (`on_open_urls`) | done; the bundle needs the `switchboard` URL scheme (packaging) |
| `ui/palette.tsx`, `ui/palette-choices.tsx` | `palette.rs` | done; matching is case-blind, not accent-blind |
| `ui/find-bar.tsx`, `ui/use-find-in.ts` | `find.rs`, `chat.rs` | done: the chat reaches back to the match and brings it into view, centred |
| `ui/shortcuts-sheet.tsx` | `shortcuts.rs` | done |
| `ui/space-page.tsx` (layouts under 1000 and 720 px) | `app.rs` | done |
| `ui/theme.ts`, `ui/use-theme-sync.ts` | `theme.rs`, `look.rs`, `app.rs` | done; where notifications go is the notifier's (platform) |
| `ui/look.ts` | `derive.rs` (stations) | done |
| `ui/space-view.ts` | `spaces.rs` | done |
| `ui/notify-prefs.ts` | `settings/notifications.rs` | done |
| `ui/kit/button.tsx`, `segmented.tsx`, `select.tsx`, `pick.tsx`, `confirm.tsx`, `float.ts`, `window.ts` | `kit.rs` | done |
| `ui/pane-scroll.tsx`, `ui/parts.tsx` (Tip) | `kit.rs`, `band.rs` | done |
| `settings/settings-window.tsx` | `settings/mod.rs` | done |
| `settings/setting.tsx` | `kit.rs` (`setting`, `group`) | done |
| `settings/general.tsx`, `bun/local.ts` | `settings/general.rs`, `local.rs` | done; the version and Update now read `settings::Updates` and send `UpdateNow` (the updater's) |
| `settings/theme-section.tsx`, `settings/color-field.tsx` | `settings/theme.rs`, `color_panel.rs` | done: the system color panel |
| `settings/spaces.tsx` | `settings/spaces.rs` | done |
| `settings/notifications.tsx` | `settings/notifications.rs` | done |
| the first frame in its final layout | `net.rs` (`keep_snapshot`), `model.rs`, `theme.rs` | done: the last snapshot and the theme kept on disk |

## Parity: platform and packaging

`src/platform/` is the bun process and its native helpers. The ledger's rows above say what each
file became; what differs on purpose:

- A notification's click opens its space from the click itself (UNUserNotificationCenter's
  delegate), not from the app coming forward within two minutes of one.
- The screenshot is gpui's last frame rendered again off screen (`Window::render_to_image`, from
  gpui's test-support, which is on for it), then the web views and the window's buttons drawn over
  it by `native/snapshot.m`; still no Screen Recording.
- A section's failure (`boundary.rs`) is a panic caught while the section builds its elements;
  gpui can't unwind out of layout or paint, so a panic there is the app's crash.
- Typing's update hold hears every key in a text field (`observe_keystrokes`), no message needed.
- The Keychain is asked with user interaction off: an item another build made answers nothing
  rather than prompting, and the desktop's file is read and written instead.

- Every menu item and shortcut reaches the main window's view whichever window is in front, and
  with it hidden (`lifecycle.rs`); Close, Minimize, Zoom and Full Screen act on the window in front.
  Checked on the mini with real menu presses and keys through the macOS extension.
- A sign-in belongs to the window that started it; closing that window cancels it.
- A quiet copy (`SWITCH_GPUI_QUIET=1`) writes nothing to the core (socket, HTTP, uploads, sign-ins,
  credentials), keeps its data and reports in a folder of its own (`switch-gpui-quiet-<pid>`, swept
  once it's gone) and sends no reports. The app's reports are its own file, never the Electrobun
  app's `~/.switch/desktop-reports.json`.
- A window comes out of full screen where it went in (AppKit leaves its top under the menu bar).
- Cutover: the Electrobun app's Keychain item doesn't answer the Rust app with prompts off, but the
  desktop's `~/.switch/desktop-credential.json` holds a credential its core takes on both Macs, so
  the first launch takes it with no pairing (checked on the mini, read-only).

Packaging:

- `build.rs` builds the Swift helpers beside the binary and compiles `snapshot.m` in.
- `scripts/bundle.sh` makes the app: icon, helpers in `Contents/MacOS`, the microphone's
  entitlement and prompt, its name, id, version and update feed from the environment, signed with a
  Developer ID (hardened, timestamped) when given one, else ad hoc. It registers the `switchboard`
  scheme only when told (`SWITCH_APP_SCHEME`): a test copy beside the live app would take its links.
- `scripts/ship.sh` (on the server, from this branch; never main's deploy): builds a commit, signs
  with the deploy's identity, notarizes and staples, and publishes to `~/.switch/updates-gpui`
  (`update.json` and the zip), served by `ax.switch.updates-gpui` on loopback and Tailscale Serve on
  port 8446. It's "Switch GPUI" under `<appId>.gpui` beside the live app; `SWITCH_GPUI_LIVE=1`
  builds it as the live app (its name, `appId`, the scheme), for the cutover. The live app's
  Electrobun updater can't install it: the cutover installs it once by hand, and it updates itself
  from then on. Not yet run on the server: the plan below.

### The update feed's first run (a plan; not run: the user's call at cutover)

On the server (the mini), as its user, with nothing else of the cutover needed first:

1. Check the ports are free: `tailscale serve status` has nothing on 8446, and
   `lsof -nP -iTCP:4881 -sTCP:LISTEN` shows nothing. (8443 is the Electrobun app's feed; 8444 is
   taken by something else, which is why this one is 8446.) Free disk: the build's target in
   `~/.switch/gpui-target` takes about 3 GB.
2. The branch is on the server: `git -C ~/.switch/repo.git rev-parse gpui-desktop` (every landing
   pushes it there).
3. Run the lane from the branch itself:
   `git -C ~/.switch/repo.git show gpui-desktop:apps/desktop-gpui/scripts/ship.sh | sh -s "$(git -C ~/.switch/repo.git rev-parse gpui-desktop)"`.
   For the cutover build, `SWITCH_GPUI_LIVE=1` in front of `sh` (the live name, `appId`, the
   `switchboard` scheme); without it, "Switch GPUI" under `<appId>.gpui`, beside the live app.
   It checks out `~/.switch/gpui-src` at the commit, builds (utility QoS), signs with the deploy's
   identity, notarizes and staples (Apple being slow leaves it signed, not stapled), packs the zip,
   writes `update.json` and swaps `~/.switch/updates-gpui` in whole, then sets up the feed: the
   `ax.switch.updates-gpui` LaunchAgent (python's http.server on 127.0.0.1:4881) and Tailscale Serve
   on 8446. Its log: `~/Library/Logs/switch/gpui-build.log`.
4. Check it: `curl -s https://<server>.<tailnet>:8446/update.json` from another Mac on the tailnet
   names the version, commit and SHA-256; `codesign --verify --deep --strict` and
   `spctl -a -vv` on `~/.switch/gpui-src/apps/desktop-gpui/build/<name>.app` pass.
5. Install the app once by hand on each Mac (the Electrobun app's updater can't install it): the
   zip from the feed, unzipped into /Applications. From then on it updates itself from the feed.
6. Each later release: step 3 again. Undo: `launchctl bootout gui/$(id -u)/ax.switch.updates-gpui`,
   `tailscale serve --https=8446 off`, remove `~/.switch/updates-gpui`, `~/.switch/gpui-src` (a
   worktree of repo.git: `git -C ~/.switch/repo.git worktree remove`) and `~/.switch/gpui-target`.

## Web content (`webview.rs`)

A page (an extension's MCP App, an agent's page, an ask's live view, a video or a sound) is a
WKWebView laid over the window where its element is: a clip view the size of what clips the element
(a chat's list, the widget column) holds it, so it's cut at their edges; each frame the element's
prepaint says where it goes, and a frame it isn't drawn hides it. `webview::slot(view, height)` is
the element; `WebView::new(window, Source::Html | Source::Sandboxed | Source::Framed, scripts, cx)` the page, which talks
to its host as a frame talks to its parent (`messages()` in, `post()` out; a hidden frame stands in
for the parent). `widgets/page.rs` answers the MCP Apps bridge.

- The frame lead is gone: where each page goes is worked out in a frame's prepaint and put on the
  view as the next frame starts (`window.on_next_frame`), the vsync gpui's Metal frame shows on.
  Checked on the mini by screen capture mid-scroll at 600 px/s over Home's agent page: the page and
  its row's rules stay together to the pixel (with the lead it was about 16 px).
  (the Metal layer's present-with-transaction flag isn't reachable: gpui's renderer resets it after each native frame.)
- The wheel: the view hands the wheel's up and down to the window (the list under it) when it
  lies at its own height; across stays the page's, and a page that fills a window or a remote
  screen keeps it all. Over a part of the page that scrolls itself, that part takes it until it's
  at its end in the wheel's way, then it goes on to the window, as a frame's does to its parent.
  Checked with a real wheel on the mini (CGEvent pixel wheel posted from a process with
  Accessibility): Home's widget column scrolls under the pointer over its pages.
- No WebRTC in any page (WebKit's peer connection preference off): its connections reach out past
  any CSP or content rule. Checked on the mini (`SWITCH_GPUI_PAGES=keys`, `framed-keys`, with a
  listener on 3478/UDP and 3479/TCP): before, a page and a page in a sandboxed frame both reached
  it (7 STUN packets, 1 TURN connection); now `RTCPeerConnection` isn't there and nothing arrives.
- The keys are a page's only when the user clicks into it (or the app hands them over, as a live
  screen does): the web view refuses first responder otherwise, so a page's `focus()` can't take
  them from the app's field, and a click anywhere else in the window gives them back. Checked on
  the mini (`keys`, `framed-keys`, AppKit events through the app's queue): before, the page heard
  every key, even after a click on the app; now it hears none until clicked, then none after a
  click on the app.
- An app's page: frames from its `frameDomains` load (its CSP's `frame-src`, WebKit's rules, and
  the guard letting a frame of its own go there); a link to a new window or the top is stopped as
  it's clicked, before WebKit reaches for it; a CSP host matches whole, not as the start of a
  longer one; it runs as a secure context, so what its permissions grant works; `alert`,
  `confirm` and `prompt` show as AppKit's alert (A2UI's frame allows modals); VoiceOver calls it
  by its accessibility label, else its title, else "MCP App". Checked on the mini
  (`SWITCH_GPUI_PAGES=web`, with a listener): the allowed frame's request came, the other frame's
  and the clicked link's never did; `isSecureContext` true, `crypto.subtle`, `getUserMedia` and
  the clipboard there. The modals and the title weren't driven.
- Clicks through a picture that's a key (the portal's live screen on an ask card): `passthrough`.
- An app's or the agent's page is sandboxed as A2UI's frame is (`Source::Sandboxed`): an opaque
  origin, the catalog's CSP first in its head (no network, frames or forms beyond its `csp`), held
  to its document (a link goes through `ui/open-link`), camera, microphone, location and clipboard
  only as its `permissions` say. It calls only the tools its `allowedTools` lists (an agent's page
  none), and its bridge is the catalog's whole (`widgets/page.rs`): the protocol version it asks
  for when spoken, else the latest; its host context's changes alone (the theme the system's, as a
  browser's media query says; the locale this Mac's first language); its bound data whole when it's
  ready, then what changes of it field by field, never its own writes back; the catalog's own
  functions (`widgets/functions.rs`: `updateDataModel`, `transformData` by JMESPath, `split`,
  `regexCapture` in the portable, safe subset, `callMcpTool` unconfigured as on the desktop), any
  other not found; a tool's answer as the extension gives it, a body that isn't JSON as a failure;
  its height at least 100 at once with no cap, its width as asked (200 to 3000); an empty
  `htmlContent` keeps its frame, empty; a `csp` or `permissions` key the schema hasn't refuses the
  part. Checked on the mini with `SWITCH_GPUI_PAGES=bridge`.
- Anything gpui draws over the window (⌘K, a menu, a popup, a sheet, a tooltip) puts
  `webview::covering()` in itself: a page laid out under it hides while it's there. Something
  small that lies over pages as the list's own (Latest ↓, the overlay scroll thumbs) puts
  `webview::cutting()` in itself instead: its box is masked out of the pages under it, and clicks
  there go to the window.
- Copy from a page: Edit ▸ Copy reaches the page when it has the keys, and its `copy` isn't
  cancelled. Checked on the mini (`SWITCH_GPUI_PAGES=copy`): words selected in a sandboxed page
  land on the pasteboard.
- Cost: three WebKit processes for the first page, about 69 MB (GPU 27, network 11, content 31).

## Looking at it without a screen

`--features shot`: `SWITCH_GPUI_SHOT=<dir> SWITCH_GPUI_PAGES=home,<space>,thread:<id>` saves each
page's frame with gpui's own renderer (native views like the web view aren't in it);
`SWITCH_GPUI_TOUR=1` times space switches and scroll frames and prints them. Pages `widgets` and
`asks` expand to each space with widgets placed or asks, `ask:*` (or `ask:<id>`) to each open ask's
window; `charts` the charts' gallery (with `SWITCH_GPUI_DRIVE=1`, each section's first chart
again under the pointer and from the keys); `copy` copies from a sandboxed page. Between pages,
`click:`, `dbl:`, `hover:`, `down:`/`drag:`/`up:`, `wheel:<x>:<y>:<dy>` and `key:<keystroke>` go to
the window last shot; `fixture:<file>` adds the asks in a JSON array to this copy's brain only
(nothing reaches the core), `close:<id>` closes one as done and `reopen:<id>` opens it again.
`SWITCH_GPUI_WHEEL=x,y,px,seconds` (with `SWITCH_GPUI_SIZE`,
`SWITCH_GPUI_AT`) turns the wheel a step a frame on Home, for watching a web view keep to its row;
the mini's macOS extension's `screenshot` tool sees it. Launch with `-ApplePersistenceIgnoreState
YES`, or a crashed run's restore prompt holds the next one.

## The cutover

The Rust app takes the Electrobun app's place on each Mac by being installed as
`/Applications/Switchboard.app`, built as the live app (`ship.sh` with `SWITCH_GPUI_LIVE=1`: the
live name, bundle id and the switchboard scheme). What it keeps is its bundle's own
(`~/Library/Application Support/<id>/gpui`: outbox, marks, kept snapshot, theme), so a side-by-side
or test build never shares an outbox, a mark or a credential with it. Only the copy installed at
that path carries over Electrobun's outbox (commands not yet answered, Not sent messages, held
Undos, drafts with their reply rows and files), and only once no app with Electrobun's bundle id
runs; it does so once, marked in `gpui/carried/<id>.json`, files still owed tried again on later
launches. `cutover.rs`, `outbox.rs`; `scripts/cutover.sh` does the steps below.

1. **Quit Electrobun first.** `cutover.sh install` asks it to quit and waits until no app with its
   id runs; a held Undo answered there after it quits can't be undone in the Rust app's place.
2. **Install with the script**, on each Mac: `scripts/cutover.sh install <the live build's .app or
   .zip>`. It checks the build (the installed app's bundle id, the switchboard scheme, its
   signature), keeps Electrobun aside, puts the build in `/Applications/Switchboard.app`,
   registers it for the switchboard scheme (and the kept copy off it), and opens it.
3. **The credential, on each Mac.** The script says whether `~/.switch/desktop-credential.json`
   or the Keychain's `Switchboard` item holds one for this Mac's core (never what it is). The live
   build uses that one and keeps any new one there; with none it mints one on the core's own Mac,
   else pairs.
4. **Remove the side-by-side app.** The script quits and removes `~/Applications/Switch GPUI.app`
   (and `/Applications/Switch GPUI.app`); its data stays in its own folder.
5. **Stop Electrobun's publishing** once every Mac has switched: main's `scripts/ship.sh` no longer
   publishes the TypeScript app's feed, so no Mac is updated back to it.
6. **Pending reports.** The script carries `~/.switch/desktop-reports.json` (crash and hang
   reports not yet in the brain) into the Rust app's (`Application Support/<id>/reports.json`),
   which sends them, and leaves the old file as `desktop-reports.carried.json`.
7. **The shared `update-tried.json`.** Both apps keep their last update tried at
   `Application Support/<id>/update-tried.json`; the script moves Electrobun's aside
   (`update-tried.electrobun.json`) so the Rust updater starts clean, and a rollback puts it back.
8. **Rollback.** `scripts/cutover.sh rollback` quits the Rust app and puts the kept Electrobun app
   (`~/.switch/rollback/Switchboard-electrobun.app`) back, registered for the scheme, its update
   record restored. Electrobun's own stores were only ever read, so it opens where it left off;
   what the Rust app sent meanwhile is in the brain (a command sent again under the same id is a
   no-op there).

## The data layer (agent 5): what views use

- `model(cx)` is the brain: `m.brain` (spaces, threads, chats, transcripts, pending, asks, revising,
  closed, widgets, prefs, connections, subscriptions, extensions and `extension_info`, credentials,
  activities) and `m.derived` (stations, marks, running `Work` with its live `step`,
  asks and children per space). `derive.rs` has the rest of derive.ts as functions: `chat` (a
  space's lines as its column shows them, pending last), `undelivered`, `unread_at`, `unread`,
  `subtree`, `live`, `warmest`, `activities`, `widgets`, `title_of`, `ask_of`, `live_step`,
  `app_names`, `typing_since`, `above`, `space_of`. `brain.transcript(thread)` is use-transcript.
- Subscribe on the model to `Heard` (each batch of live events, for widgets' refresh) and
  `BrainEvent`: `Snapshot`, `Restored(place)` (a "Not sent" message's words back in a box).
- Every command is a method on `Model`, typed, optimistic where the TS is, all through the
  outbox. The chat's (`model.rs`): `command`/`command_as` (any command, an `Answer`), `post`,
  `post_message(Post)` (files: chosen ones upload before it goes), `read`, `react`,
  `edit_message`, `retry`, `stop`, `steer`, `forget`, `change`. The rest (`mutations.rs`, each a
  `Task<Result<…, String>>`): `send`, `restore`, `choose` (uploads at once; `m.uploads` has each
  chip's state), `act(Act::…)`, `emit`, `edit_memory`, `set_pref`, `hold`/`unhold`/`done`
  (held for Undo), `edit_item`, `keep_edit`, `kept_edit`, `item_drafts`, `reopen`, `reply_on`,
  `answer_sealed` (HPKE, as switch-ext-kit seals), `call_tool`, `call_checked`, `widget_set`,
  extensions install/update/remove, `verify_connection`, `disconnect`, `approve`/`deny`/`revoke`,
  `offer`, `select_profile`/`save_profile`/`delete_profile`, `add_provider`, `add_account`,
  `account_request`. Chats and transcripts: `want_chat`, `older_chat`, `reach_chat` (pages until a
  seq is held), `want_thread`, `older_thread`, `retry_thread`.
- Reads that aren't the sync (`queries.rs`), called in render, observed through
  `queries::entity(cx)`: `models`, `accounts`, `registry`, `find`, `find_in`, `memories`, `system`,
  `needs`; `invalidate(prefix)`.
- `outbox.rs` keeps commands and drafts across relaunches (`draft(place)`, `set_draft`); `files.rs`
  has `choose`/`choose_paths`, `type_of`, `size_of`, `blob_url`, `image_blob`. `Net` has
  `core_url` and `portal_url` (credential in the address, for web views), `watch(types)`, `get`,
  `post`, `http`, `request`, `fetch_url`. `SWITCH_GPUI_QUIET=1` sends nothing (for looking at the app on the mini).
- Pictures: `Pictures::get` decodes at chat size (720 px); `Pictures::sized(hash, format, px)` at
  a drawn size; `Pictures::local(path, px)` for a chip. ImageIO decodes straight at that size (HEIC
  too); bounded (48 MB decoded, 16 MB fetched), textures freed as they go. On the mini after ten
  spaces: 345 MB footprint (495 before ImageIO, 440 in the slice); switches one frame (16.6 ms
  median, 19.9 max); Home alone 140 MB.
- The first frame: the last snapshot frame is kept on disk by core (`net.rs`) and read before
  the network; `brain.kept` is true until the live one lands.
