# Switchboard desktop: user paths

Each line is one journey for `scripts/paths.ts`: `path → expected result`. Every journey passes only if the first changed frame after the action is the settled frame.

## Rules every journey holds
- No blank frame, fade, reflow or late pop-in; nothing moves but what the action moves.
- Only motion allowed: the runner, streaming words, the mic pulse.
- Menus, popovers, tooltips, sheets, the palette: appear and go in one frame.
- Hover/press: a fill inside the lines only; no border or layout change.

## Open the app
- Cold launch → the band and Home's page (rail, chat, widgets) at their final layout on the first painted frame, never empty then filled.
- Launch with brain down → band shows Stop + "Can't reach the brain" at its right; nothing else changes.
- ⌘W or red button → window hides; app keeps running.
- Dock icon after hide → window shows exactly as it was (page, scroll, draft text).
- ⌘Q → app quits.
- ⌘H / ⌥⌘H → app / others hide.
- ⌘M → window minimizes.
- ⌃⌘F → full screen; band and page relaid in one frame.

## Home
- Home → band (30 px, window buttons centred on it): ‹ ›, house ring, "HOME"; under it the rail (the top-level spaces, Needs you, Running), the chat, and Home's widgets on the right. Every space the same.
- A widget with nothing to show → absent; the rest closed up, no gap. None to show → no widgets column; the chat takes the room.
- Chat with nothing under it → reaches the window's foot, no strip below.
- Empty chat → "No messages" centred; box at the foot.

## Rail, chat, widgets
- Scroll the widgets → only the widgets column moves; band, rail and chat stay put, every frame. Nothing inside a widget scrolls.
- Scroll the rail → only the rail moves.
- Needs you and Running → this space's own rows first, then each space inside's under its ring and name; "Nothing" when empty, never gone.
- A space with no spaces inside → no Spaces section; Needs you at the rail's top.
- Home's spaces → banner rows: each one's cover behind, its ring and name and its marks on black plates, a little taller than a plain row. Any other space's → plain rows.
- ⚙ on the band → a popover at once: Spaces, Banners or Rows; a pick redraws the list in one frame and stays.
- Lines → strong between the panes and under the band; a step below between the rail's sections and between widgets; hairlines between rows and over the box; never two at one edge, no gap.

## Switch spaces
- Click a space's row in the rail → that space's band and page in one frame; no Home frame between.
- "More" line in Spaces (past nine) → the rest show in place; nothing above moves.
- Click a station on the band → that space opens; band way shortens in the same frame.
- Click the house station (tip "Home ⇧⌘H") → Home.
- ⌘K → palette at once, 72 px down, no scrim; input focused, placeholder "Find…".
- ⌘K, type a space name, Enter → palette gone and space open in the same frame.
- ⌘K, Esc → palette gone; page unchanged.
- ⌘K, no match → "Nothing".
- ⌘K, pick an ask / running work / command → its page or command runs; palette gone at once.
- `switchboard://space/<id>` → window shows (if hidden) on that space.
- `switchboard://thread/<id>` → that thread's page.
- `switchboard://ask/<id>` → the ask's space.
- `switchboard://` legacy `open/ws/<slug>`, `workspace/<slug>`, `work/<id>` → the space/thread they name.
- Unknown link → Home.
- Link at cold launch → opens straight on its page; no Home frame first.
- Go ▸ Spaces ▸ a space → that space.
- Space menu ▸ a space inside → that space.
- ⇧⌘H → Home.
- ⌘↑ / ⌘↓ → previous / next space in tree order, wrapping.
- Esc on a space → its enclosing space; on Home → nothing.
- Recently open space (last 4) revisited → instant, same scroll and draft as left.
- Archived or unknown space → Home.

## Back and forward
- ‹ on the band → previous page; ‹ dims to 30 % when there is none.
- › → next page; dims when none.
- ⌘[ / ⌘] → same as ‹ / ›.
- Mouse button 4 / 5 → back / forward.
- Two-finger swipe right / left (> 140 px) → back / forward; never inside something that scrolls sideways.
- Re-opening the open space at another line → no history step.

## Threads
- Running row in Running → thread page: band shows its title and live runner; transcript live; box steers.
- Esc on a thread → back to the space it came from, scroll kept.
- ‹ / ⌘[ on a thread → same.
- ⌘. → the running turn stops (the thread open's, else the space's); runner goes to Stop.
- Stopped work row → thread page with Stop.

## Needs you
- Needs you line → the ask in its own window (one per ask; again brings it forward), centred, fitted to the card: band strip with where it's from, then the card, never blank.
- Item window, Esc or ⌘W → window closes.
- Ask answered or closed elsewhere → its window closes itself.
- Answer in the item window → card seals; line leaves Needs you in the main window.
- Ask card in the chat, answered → folds to a line in place; nothing above moves.

## Chat
- ⌘L, ⌘N, File ▸ New Message, "/" → cursor in the box.
- Click anywhere in the box's bottom cell → cursor in the words.
- Type → words appear; box grows line by line to 240 px, then scrolls; history above doesn't jump.
- ↵ → sends; message shows at the foot at once; box empties.
- ⇧↵ → new line.
- ↑ in an empty box → last message back to edit; "Editing" + Cancel esc above.
- Esc while editing → edit dropped; page stays.
- Paste or drop a file → chip above the words.
- ⌘D / mic → dictation; words appear in place; Esc drops it; ↵ keeps them.
- Scroll up → history holds; older lines load above without moving what's seen.
- New line arrives while scrolled up → view doesn't move.
- At the foot, new line arrives → kept at the latest.
- ⌘F or Edit ▸ Find in Chat → bar as the chat's top cell, focused; history doesn't shift.
- Type in ⌘F → "n/m" or "None"; match ringed and in view.
- ↵ / ⇧↵ in ⌘F → next / previous match.
- Esc in ⌘F → bar gone; page stays.
- ⌘F again with the bar open → its words selected.
- "Mentioned in" link → that space.

## Spaces' commands
- Double-click the space name on the band → rename field in place; ↵ keeps, Esc puts it back.
- Right-click a station or the name → native menu: Rename…, Split Off, Move To, Copy Link, Archive (Home: Split Off, Copy Link).
- ⇧⌘N → Split Off.
- Archive the open space → its parent opens.

## Settings
- ⌘, (or Switchboard ▸ Settings…) → the Settings window, centred over the main one, no animation, at General; again → that window comes forward, never a second.
- Space ▸ Connections / Memory → the Settings window at that section.
- Click a section down the left → it opens beside; the list stays.
- General → Launch at login (Off/On), Updates (Automatic/Manual), Version and Update now when one waits, every shortcut.
- Theme → a preset, Appearance, Background (light, dark), the two lines (color per appearance, thickness), Go, Needs you, Running, Danger, Neutral, Text, Text size; every change shows in every window in one frame, no flicker; a preset picked shows whole at once; anything changed → Custom.
- Connections → accounts by provider; Disconnect; Connect where none.
- Spurs → installed with version; Update / Remove.
- Devices → pairings waiting (Approve / Deny), paired devices (Revoke), the pairing QR.
- Notifications → Send to (This Mac / iPhone), While the app is open (Show / Quiet).
- Memory → where it holds down the left, what's remembered beside.
- System → spend, recent turns, Mac permissions, brain counts.
- Esc or ⌘W in Settings → the window closes.

## Sheets
- ⌘/ → Keyboard Shortcuts sheet at once; every shortcut a line; Esc closes.

## Window size
- Drag width across 1000 px → the widgets fold away or come back in one frame; across 720 px → the rail over the chat, or beside it, in one frame; no intermediate layout.
- Resize height → chat reaches the new foot; rows meet the foot exactly.
- Resize within wide → rail, chat and widgets scale with the window; nothing reflows late.

## Appearance
- System light ↔ dark → every token flips in one frame; the window stays opaque.
- Each journey above → passes in light and in dark.

## Every shortcut
⌘K find · ⌘F find in chat · ⌘N / ⌘L chat · / box · ↵ send · ⇧↵ new line · ⌘D dictate · ⇧⌘H home · ⌘↑ ⌘↓ previous/next space · Esc up/back · ⌘[ ⌘] back/forward · ⇧⌘N split off · ⌘. stop · ⌘, settings · ⌘W close · ⌘/ shortcuts · ⌘Z ⇧⌘Z ⌘X ⌘C ⌘V ⌥⇧⌘V ⌘A edit · ⌘M minimize · ⌃⌘F full screen · ⌘H ⌥⌘H hide · ⌘Q quit.

## Live images in the frame gate

A camera's pixels can refresh while its geometry stays fixed. `journeys.ts` declares the image
interior by action index, using the printer's 16:9 bounds at the recorded width. The plate and
the lines around it remain judged with the original thresholds. The first camera image is
also checked for a blank load. Verdict JSON keeps both the masked and full-image differences and
lists every excluded interior. A reanalysis of an older recording is not a new native run.

A locked screen blocks native verification: the recorder returns
`screen locked: app windows don't paint or take input until it's unlocked`. Headless captures do
not replace that native journey gate.
