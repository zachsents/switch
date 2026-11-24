// The journeys scripts/paths.ts records (PATHS.md says what each should do). Points are
// window-relative, in points, for the window size the run is at; `{space}` and `{space2}` are space
// ids the run is given (data, never code). A journey's `setup` runs unrecorded; each input step in
// `act` is an action the gate measures, up to the next one. `still` rects must not change at all;
// `ignore` rects are left out of every comparison (a caret, a clock). `after: "relaunch"` quits and
// relaunches the test app, so an edit is never saved.

export interface Step {
  readonly do:
    | "click"
    | "move"
    | "drag"
    | "key"
    | "type"
    | "scroll"
    | "open"
    | "size"
    | "activate"
    | "mark"
    | "settle"
    | "menu"
  readonly wait?: number
  readonly x?: number
  readonly y?: number
  readonly x2?: number
  readonly y2?: number
  readonly w?: number
  readonly h?: number
  readonly ms?: number
  readonly hold?: number
  readonly dy?: number
  readonly button?: number
  readonly mods?: string
  readonly keys?: string
  readonly text?: string
  readonly url?: string
  /** A menu bar item's title, for `menu`. */
  readonly item?: string
}

export type Rect = readonly [x: number, y: number, w: number, h: number]

export interface Journey {
  readonly name: string
  /** Include secondary windows inside the main window's screen rectangle. */
  readonly capture?: "screen"
  readonly setup: readonly Step[]
  readonly act: readonly Step[]
  readonly still?: readonly Rect[]
  readonly ignore?: readonly Rect[]
  /** Live image interiors by action index. Their surrounding edges remain judged; a blank first
   * image still fails. Only use after inspecting the recorded widget bounds. */
  readonly live?: Readonly<Record<number, readonly Rect[]>>
  readonly after?: "relaunch"
  /** `motion`: a drag or scroll moves things while it lasts. It passes when nothing in `still`
   * changes, and once the hand lets go at most one more frame changes (a settle). `again`: the
   * window shown again as it was; no change at all passes (nothing faded or redrew). */
  readonly rule?: "motion" | "again"
  /** Nothing to do may be right (a column that fits has nothing to scroll). */
  readonly mayStay?: boolean
}

const SETTLE = 1500

/** The window's size the run is at (paths.ts --size), in points. */
const [W = 1000, H = 640] = (process.env.GATE_SIZE ?? "1000x640").split("x").map(Number)
/** The rail (a quarter of the window, at least 240) and the widgets (27 %, from 1000 wide), as
 * ui/space-page.tsx lays them out. */
const RAIL = Math.max(240, W / 4)
const WIDGETS = W >= 1000 ? W * 0.27 : 0
/** The chat between them: it never moves while either column scrolls. */
const CHAT: Rect = [Math.ceil(RAIL) + 1, 31, Math.floor(W - WIDGETS - RAIL) - 2, H - 31]
/** A space's first widget, a printer: its camera at 16:9 the column's width, under the 30 px band.
 * The image itself ends above the printer plate; the plate and the lines around it remain judged. */
const CAMERA: Rect = [
  Math.ceil(W - WIDGETS),
  30,
  Math.floor(WIDGETS),
  Math.ceil((WIDGETS * 9) / 16),
]

/** The window's buttons, which macOS greys while the window isn't key. Live content (a watch's
 * hands, a camera, a caret) the gate finds on its own: what changes while nothing is done. */
const LIVE: readonly Rect[] = [[0, 0, 76, 30]]
const settle = (ms = SETTLE) => ({ do: "settle", ms }) satisfies Step
const go = (space: string) => ({ do: "open", url: `switchboard://space/${space}` }) satisfies Step
const key = (keys: string) => ({ do: "key", keys }) satisfies Step

/** Settings opens over the main window, 760 wide, centred across it and 60 below its top; its points
 * here are the main window's. Its sidebar rows and the Theme section's controls, as laid out. */
const SET_X = Math.round((W - 760) / 2)
const SET_Y = 60
const at = (x: number, y: number) => ({ x: SET_X + x, y: SET_Y + y })
const THEME_ROW = at(40, 90)
const PRESET = { default: at(356, 70), paper: at(456, 70), slate: at(570, 70) }
const LINE_2PT = at(645, 189)
const LINE_1PT = at(604, 189)
const click = (p: { readonly x: number; readonly y: number }) =>
  ({ do: "click", ...p }) satisfies Step
// Settings by its menu item (what ⌘, does): a key posted to the app does nothing while another app
// is in front.
const SETTINGS = { do: "menu", item: "Settings…" } satisfies Step
const openTheme = [go("home"), settle(1200), SETTINGS, settle(1500), click(THEME_ROW), settle(800)]

export const journeys: readonly Journey[] = [
  {
    ignore: LIVE,
    name: "reopen",
    rule: "again",
    setup: [go("home"), settle(1000), key("cmd+w"), settle(800)],
    act: [{ do: "open", url: "switchboard://space/home" }, settle(2500)],
  },
  {
    ignore: LIVE,
    name: "home-space-home-link",
    live: { 0: [CAMERA] },
    setup: [go("home"), settle(1200)],
    act: [go("{space}"), settle(), go("home"), settle()],
  },
  {
    ignore: LIVE,
    name: "space-to-space-link",
    live: { 1: [CAMERA] },
    setup: [go("{space}"), settle(1200)],
    act: [go("{space2}"), settle(), go("{space}"), settle()],
  },
  {
    ignore: LIVE,
    name: "back-forward-keys",
    live: { 1: [CAMERA] },
    setup: [go("home"), settle(1000), go("{space}"), settle(1200)],
    act: [key("cmd+["), settle(), key("cmd+]"), settle()],
  },
  {
    ignore: LIVE,
    name: "back-forward-mouse",
    live: { 1: [CAMERA] },
    setup: [go("home"), settle(1000), go("{space}"), settle(1200)],
    act: [
      { do: "click", x: 500, y: 400, button: 4 },
      settle(),
      { do: "click", x: 500, y: 400, button: 5 },
      settle(),
    ],
  },
  {
    ignore: LIVE,
    name: "palette",
    setup: [go("home"), settle(1200)],
    act: [key("cmd+k"), settle(800), key("esc"), settle(800)],
  },
  {
    ignore: LIVE,
    // The widgets scroll as a whole under the band; the chat beside them must not move.
    name: "scroll-widgets",
    rule: "motion",
    mayStay: true,
    setup: [go("{space}"), settle(1200)],
    act: [
      { do: "scroll", x: Math.round(W - WIDGETS / 2), y: Math.round(H / 2), dy: -400 },
      settle(),
      { do: "scroll", x: Math.round(W - WIDGETS / 2), y: Math.round(H / 2), dy: 400 },
      settle(),
    ],
    still: [CHAT],
  },

  {
    ignore: LIVE,
    name: "next-previous-home-keys",
    setup: [go("{space}"), settle(1200)],
    act: [key("cmd+down"), settle(), key("cmd+up"), settle(), key("shift+cmd+h"), settle()],
  },
  {
    ignore: LIVE,
    // Settings comes up in its own window: the main window doesn't change at all.
    name: "settings-open",
    rule: "again",
    setup: [go("home"), settle(1200)],
    act: [SETTINGS, settle()],
    after: "relaunch",
  },
  {
    ignore: LIVE,
    // A preset shows in the main window at once: its first changed frame is its last.
    name: "theme-presets",
    capture: "screen",
    setup: openTheme,
    act: [
      click(PRESET.paper),
      settle(),
      click(PRESET.slate),
      settle(),
      click(PRESET.default),
      settle(),
    ],
    after: "relaunch",
  },
  {
    ignore: LIVE,
    // A line's thickness, then a background typed in: each shows everywhere in one frame.
    name: "theme-line-background",
    capture: "screen",
    setup: openTheme,
    act: [
      click(LINE_2PT),
      settle(),
      click(LINE_1PT),
      settle(),
      click(PRESET.slate),
      settle(),
      click(PRESET.default),
      settle(),
    ],
    after: "relaunch",
  },
]
