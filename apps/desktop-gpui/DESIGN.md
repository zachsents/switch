# Switch's design

Functional signage: subway maps and road signs. High contrast, condensed capitals for names and
places, monospace only for code, ink for who, lamps for state. No rounded cards; keys
sit in their hairline and sink a point when pressed (old Switchboard's); nothing casts a shadow,
what floats is set apart by a line-1 hairline. Old Switchboard's style (switchboard/mac, rev D), with
its north star a page of printers: full-bleed cameras on black name plates.

Every value is a token in `src/look.rs` (Look: the background, lines, inks, lamps, text size, from
the brain's theme, `src/theme.rs`); parts are in `src/kit.rs` (buttons in their looks, segmented,
select, pick, confirm, a setting's row), `src/marks.rs`, and the band in `src/band.rs`. File names
in parentheses below are the Electrobun app's (`apps/desktop`), where this was first written;
PORTING.md's ledger names each one's Rust module. In the old app, every value was a token in
`src/mainview/index.css`, parts in `ui/kit`, `ui/parts.tsx`, `ui/marks.tsx` and `ui/look.ts`. `bun run look` (part of `bun run check`) refuses a raw color, a raw `<button>`, and any
motion not in `scripts/ui-look.allow`. The gallery (`#gallery`, dev builds) shows every part in
every state.

## Rules

1. **One background,** `bg`, everywhere: the band, page, rail, widgets, chat, popovers, menus,
   ask and reading windows, the box, keys. Hover changes only the background (`lit`, the theme's `hover` state token), instantly. It never changes a border, text color or geometry.
   Pressed, chosen or highlighted controls use the background wash `held`, without an added edge or bevel; keyboard focus uses the independent `focused` ring. The only other fills: a black plate on a picture (a
   camera's name), the green key, the user's words in their space's ink, the agent's in
   `bubble` gray, and marks.
2. **Three lines,** as the user put it: “The vertical panels should be separated with some pretty strong hierarchy whereas separating spaces from ‘Need to You’ from ‘Running’ should probably be one step below that, and then hairline within those.”
   `line-1`, strong: between the panes (the rail, the chat, the widgets) and under the band.
   `line-section`, a step below: between the rail's sections and between widgets. `line-2`, the
   hairline: between rows, under a rail section's heading, and between the chat and its box
   (“It’s all kind of the same area”). Each line has one owner, so nothing doubles or gaps. Lines are drawn over what an
   element holds (`edge`, `line-1-*`, `line-section-*`, `line-2-*`, `rows`), so a hover, a picture
   or a pressed row never covers one, and hover never changes one.
3. **Light means state.** Yellow hand: needs you. Orange runner: live. Red triangle: didn't go as
   expected. Red octagon: stopped. Lamps are marks, never text. Green is the one key that acts.
4. **Ink means who.** Each top-level space is a line with its ink; spaces under it are stations
   ("K03"). The user's words in a space are in its ink; Home's in `home`.
5. **Almost no motion.** Navigation, hover, press: instant. Moves only where they show where
   something goes. The runner is the one live loop, for work that runs; anything else loading
   or pending is the grey spinner (`Spin`), never the runner.
6. **The final layout on the first frame.** A page renders from what's held: the brain's snapshot
   and prefetched widgets. Nothing waits to show; nothing is measured while hidden.
7. **Hit area is the visible area.** A row's whole width and height is its click; the box's whole
   bottom cell is the box; a field's whole cell takes the cursor.
8. **Words sit on their capitals** (`trim`, `sign`: text-box-trim), so they centre optically.
9. **Copy:** labels, data and a one-or-two-word placeholder with an ellipsis ("Say to Printing…").

## Tokens

| Color | For |
| --- | --- |
| `bg` | The one background |
| `line-1`, `line-section`, `line-2` | Between panes; between sections and widgets; between rows |
| `ink`, `ink2`, `ink3` | Words: read, supporting, figures and times |
| `home` | Home's ink |
| `bubble` | The agent's bubble |
| `yellow`, `orange`, `red` | Lamps, for marks only |
| `go`, `go-press`, `go-*` | The one green key |
| `key-*` | A raised key's edges: border, light along the top, drop under it (no fill) |
| `black`, `white` | A plate on a picture, and its words |

| Type | Utility | For |
| --- | --- | --- |
| DIN Condensed, capitals | `sign` + `text-title` 22 / `text-name` 15 | A space's name on the band, a camera's plate |
| SF Pro | `text-read` 14/20, `text-ui` 13, `text-small` 12, `text-caption` 11 | Words; figures and times in `tabular-nums` |
| SF Mono | `font-mono` | Code only: inline, blocks, commands and paths shown as code |

Heights on a 4 px rhythm: a row and a heading `line` 24, a key `key` 22, the band `band` 30 (the
window's buttons centre on it), a plate `plate` 20. Words sit `inset` 8 from a cell's edge. Radii:
`key` 4, `float` 6, `bubble` 18.

## Parts

- **Button** (`ui/kit/button.tsx`, Base UI): `key` (raised), `go` (raised green, one in sight),
  `flat` (bare, lit under the pointer), `plate` (on the band), `row` (a whole list row), `bare`.
- **Segmented** (Base UI ToggleGroup): equal heights, one line-1 around, the chosen one pressed in;
  choosing moves nothing.
- **Select / Pick** (Base UI Select; Combobox for a long list): the choice's words and ⌃⌄, bare,
  lit under the pointer; its list floats under it (Pick's with Find on top), in groups under small
  headings, the chosen one checked.
- **Head / Section / Row / Quiet / Data:** a list's heading (mark, name, count), its rows on
  line-2s, "Nothing" when it has none (old Switchboard's), figures at a row's end. A rail section's heading (`ui/rail-section.tsx`) is a line tall with no room above
  or below, its name in small capitals, its count at the end where the rows' times are, the section
  line over it and a hairline under it: its hierarchy is the lines, the capitals and the alignment,
  not height.
- **Float:** popovers, the palette, menus: `bg` inside a line-1 hairline border, no shadow, `float` radius. No shadow anywhere in the UI: lines are borders, never `box-shadow`.
- **Ask card:** old Switchboard's: the hand, where from, its kind and its age right after it; its
  title, then its words as Markdown a size smaller in `ink2`; its pictures fitted in 240 × 96, rounded 8, on a line-2; a draft in a box rounded 8 on a
  hairline (as are its fields), its label strip over its words (Edited once changed); one green
  key, options as keys, a link key
  with ↗, then Reply and Dismiss as flat words at that row's end (11-22: “move the reply button and
  dismiss together in the bottom right”), an Answer field; 12 px between its parts. In chat where it
  was raised, as a widget in chat is: the column's whole width, rules above and below; from Needs you, in
  a window of its own that fits it.
- **Bubbles:** iMessage's. The user's on the right in the space's ink, the agent's on the left in
  `bubble` gray; no names, no emphasis on any one. Lines from one side within 5 minutes group 2 px
  apart, the last with the tail; a centred time over a line after a 10-minute gap. Time and Copy
  show beside a bubble only under the pointer, in a zone the bubble's height that spans the gap to
  them. Over its words the I-beam and the page's own selection (a double-click selects a word, a
  double-click and drag words); off them the arrow, where a double-click opens its tapbacks, as a
  right-click anywhere on it does. A tapback (heart, thumbs up, thumbs down, haha, !!, ?) sits on
  the bubble's top corner. A long line clamps with an ellipsis; a click reads it
  whole. A reply's detail, when it has one, opens from More.
- **Blips:** what happened rather than what was said (an app's outcome, a memory, a move): one
  line, centred, a mark and a few words; a click opens the whole of it, its time and its Undo.
- **Box:** the chat's whole bottom cell, a hairline over it, the mic and Send in it.
- **Band:** on the background, its line-1 under it. ‹ ›, Home's station, the stations above joined by their ink, the page's ring and its
  name in its ink.

## A space's page

The band, then one layout, the same on every space and on Home, nothing in it laid out by hand
(`ui/space-page.tsx`):

- **The rail** (left, a quarter of the window, at least 240 px; it scrolls as a whole): the spaces
  inside, as the space is set to list them (Settings ▸ Spaces; `pref space.inside:<id>`; until set,
  Home's banners and every other space's rows): banner rows, 48 high, the space's cover behind and
  on black plates over it its ring and name and its marks, so they read on any cover; or plain rows
  (ring, name, unread dot, runner, hand and count). Then Needs you and Running,
  always there and always in that order. Each lists only this space's own rows, never those of the
  spaces inside (the user's word, 11-22: “only show home-level items not all the spaces beneath”);
  a space's row marks still count the spaces inside it.
- **Running is tasks,** never a space's own chat turn (the rail, a row's runner, the counts; the
  iPhone too). This reverses Rust's rule, which counted chat work in Running
  (core/src/places.rs:370-372), at the user's word (11-22): “I want Running to be more like
  tasks.” While a chat turn answering him works, the chat shows iMessage's typing bubble (three
  dots, lit in turn) at its end on the agent's side, gone when the reply lands or the turn ends.
- **The chat** in the middle: the thread, the box its bottom cell.
- **Its widgets** (right, 27 %): the space's placements in their order, each the column's width
  and its own height, a line-1 under each. The column scrolls as a whole; nothing in it scrolls
  inside itself. A widget that draws only its empty state, or only its heading, is out of it; with
  none to show, so is the column.
- **Narrow windows:** under 1000 px the widgets fold away; under 720 px the page is one column, the
  rail over the chat.
- **Settings** is a window of its own (⌘,, one window, brought forward at a section): its sections
  down the left (General, Theme, Spaces, Connections, Extensions, Devices, Notifications, Memory,
  System), the one open beside it. Spaces: each space with spaces inside it, Home first, and how it
  lists them (Banners | Rows).

## Theme

Settings › Theme (`ui/theme.ts`) sets the tokens: the appearance (System, Light, Dark) and the text
size (every window zoomed with it), then a theme for each appearance, edited one at a time under
its name (the one shown first): its background; its three lines (between panes, between sections,
between rows), each a color and a thickness (a theme without its own section line has one worked
out between the other two); what each state color is
(Go: Send, Approve, Done, Connect; Needs you: the hand; Running: the runner; Danger: Stop,
Remove, Revoke; Neutral keys are the background's own edges), its samples drawn in its own look.
Inks are worked out from the background, each kept at its contrast (7, 4.5).
Presets: Default, Paper, Contrast, Slate, each with a side per appearance; picking one sets only
the theme being edited; Custom once anything differs. Kept in the brain (`pref theme`, beside the
one theme it was before, which the rollback app reads) and on the Mac, so a window paints it on
its first frame; a change shows in every window at once. The app takes the appearance shown, so
every web view, menu and panel does too. Every key and mark takes its color from its meaning: `look="go"`, `look="danger"`.

Keys: ⌘K find, Esc up a space, ⌘[ ⌘] and the mouse's side buttons back and forward, / to the box,
Enter sends, ⇧Enter breaks the line.
