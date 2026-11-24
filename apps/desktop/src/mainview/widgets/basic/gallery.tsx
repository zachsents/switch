// The widget parts in the gallery (`#gallery`, dev builds): A2UI surfaces of every part of the basic
// catalog in every state, the house parts beside them, and widgets written for the parts the house
// catalog dropped, read as what replaced them. Each is fixture messages taken through the host's one
// processor (host.ts), as an extension's widget is, and drawn in a cell as the grid draws one.
import { A2uiSurface } from "@a2ui/react"
import { useQuery } from "@tanstack/react-query"
import { BASIC_CATALOG, SWITCH_CATALOG } from "switch-ext-kit"

import icon from "../../../../assets/brand/icon.iconset/icon_256x256.png"
import { take } from "../host.ts"

type Component = Readonly<Record<string, unknown>>

/** A surface of `components` in `catalog`, its data model `data`. */
const surface = (catalog: string, components: readonly Component[], data: Component = {}) => [
  { version: "1.0", createSurface: { surfaceId: "fixture", catalogId: catalog } },
  { version: "1.0", updateComponents: { surfaceId: "fixture", components } },
  { version: "1.0", updateDataModel: { surfaceId: "fixture", path: "/", value: data } },
]

/** Basic parts in a Column, the root: `top` down it, `inner` those placed by them. */
const basic = (top: readonly Component[], inner: readonly Component[] = [], data: Component = {}) =>
  surface(
    BASIC_CATALOG,
    [{ id: "root", component: "Column", children: top.map((c) => String(c.id)) }, ...top, ...inner],
    data,
  )

/** A second of silence, as a WAV: what an audio player can play here. */
const silence = () => {
  const rate = 8000
  const bytes = new Uint8Array(44 + rate).fill(128)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => {
    bytes.set(new TextEncoder().encode(s), at)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + rate, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  ascii(36, "data")
  view.setUint32(40, rate, true)
  return `data:audio/wav;base64,${bytes.toBase64()}`
}

const text = (id: string, words: unknown, more: Component = {}) => ({
  id,
  component: "Text",
  text: words,
  ...more,
})

/** A Button, and its words. */
const key = (id: string, words: string, more: Component = {}) =>
  [
    {
      id,
      component: "Button",
      child: `${id}Words`,
      action: { event: { name: "press", context: { key: id } } },
      ...more,
    },
    text(`${id}Words`, words),
  ] as const

const required = (path: string, message: string) => [
  { condition: { "@call": "required", args: { value: { "@path": path } } }, message },
]

interface Cell {
  readonly name: string
  readonly w?: number
  readonly messages: readonly unknown[]
}

const BASIC: readonly (readonly [string, readonly Cell[]])[] = [
  [
    "Text",
    [
      {
        name: "heading, body, caption",
        messages: basic([
          text("h", "# Printers"),
          text("b", "Printing the second plate, 45% done"),
          text("c", "Nothing", { variant: "caption" }),
        ]),
      },
      {
        name: "Markdown, wrapping",
        messages: basic([
          text(
            "m",
            "Swap to **PETG** before the next plate: the *bed* needs `70°C`, and the [spool](https://example.com) is in the dry box.\n\n- Unload\n- Load the new spool",
          ),
        ]),
      },
      {
        name: "nothing said",
        messages: basic([
          text("e1", ""),
          text("e2", "# "),
          text("e3", "##"),
          text("e4", { "@path": "/none" }, { variant: "caption" }),
          text("after", "Only this line draws"),
        ]),
      },
    ],
  ],
  [
    "Image",
    [
      { name: "medium (default)", messages: basic([{ id: "i", component: "Image", url: icon }]) },
      {
        name: "icon, avatar, small",
        messages: basic([
          { id: "a", component: "Image", url: icon, variant: "icon" },
          { id: "b", component: "Image", url: icon, variant: "avatar" },
          { id: "c", component: "Image", url: icon, variant: "smallFeature" },
        ]),
      },
      {
        name: "header, no url",
        messages: basic([
          { id: "h", component: "Image", url: icon, variant: "header" },
          { id: "n", component: "Image", url: "" },
          text("t", "Under the header"),
        ]),
      },
    ],
  ],
  [
    "Icon",
    [
      {
        name: "names, svgPath, unknown",
        messages: basic(
          [{ id: "r", component: "Row", children: ["i1", "i2", "i3", "i4", "i5", "i6", "i7"] }],
          [
            { id: "i1", component: "Icon", name: "home" },
            { id: "i2", component: "Icon", name: "search" },
            { id: "i3", component: "Icon", name: "settings" },
            { id: "i4", component: "Icon", name: "warning" },
            { id: "i5", component: "Icon", name: { svgPath: "M12 3 22 21H2Z" } },
            { id: "i6", component: "Icon", name: { "@path": "/unknown" } },
            { id: "i7", component: "Icon", name: "check" },
          ],
          { unknown: "nothingLikeIt" },
        ),
      },
    ],
  ],
  [
    "Video and AudioPlayer",
    [
      {
        name: "video, poster",
        messages: basic([
          { id: "v", component: "Video", url: "/no-such-video.mp4", posterUrl: icon },
        ]),
      },
      {
        name: "audio",
        messages: basic([
          { id: "a", component: "AudioPlayer", url: silence(), description: "Doorbell" },
          { id: "b", component: "AudioPlayer", url: "/no-such-sound.m4a" },
        ]),
      },
    ],
  ],
  [
    "Row, Column, List",
    [
      {
        name: "Row",
        messages: basic(
          [
            { id: "r1", component: "Row", children: ["r1a", "r1b"] },
            {
              id: "r2",
              component: "Row",
              justify: "spaceBetween",
              align: "center",
              children: ["r2a", "r2b"],
            },
            { id: "r3", component: "Row", children: ["r3a", "r3b"] },
          ],
          [
            text("r1a", "Left"),
            text("r1b", "Right"),
            { id: "r2a", component: "Image", url: icon, variant: "avatar" },
            text("r2b", "Spaced, centred"),
            text("r3a", "Weight 2", { weight: 2 }),
            text("r3b", "Weight 1", { weight: 1 }),
          ],
        ),
      },
      {
        name: "Column, aligned",
        messages: surface(BASIC_CATALOG, [
          { id: "root", component: "Column", align: "center", children: ["a", "b"] },
          text("a", "Centred"),
          ...key("b", "Under it"),
        ]),
      },
      {
        name: "List, down and across",
        messages: basic(
          [
            { id: "d", component: "List", children: { componentId: "line", path: "/lines" } },
            { id: "x", component: "List", direction: "horizontal", children: ["x1", "x2", "x3"] },
          ],
          [
            text("line", { "@path": "words" }),
            { id: "x1", component: "Image", url: icon },
            { id: "x2", component: "Image", url: icon },
            { id: "x3", component: "Image", url: icon },
          ],
          { lines: [{ words: "First" }, { words: "Second" }, { words: "Third" }] },
        ),
      },
    ],
  ],
  [
    "Card, Divider",
    [
      {
        name: "cards down",
        messages: basic(
          [
            { id: "c1", component: "Card", child: "c1t" },
            { id: "c2", component: "Card", child: "c2t" },
            text("after", "After the cards"),
          ],
          [text("c1t", "# First card"), text("c2t", "# Second card")],
        ),
      },
      {
        name: "cards across",
        messages: basic(
          [{ id: "r", component: "Row", justify: "stretch", children: ["c1", "c2"] }],
          [
            { id: "c1", component: "Card", child: "c1t" },
            text("c1t", "Left card"),
            { id: "c2", component: "Card", child: "c2t" },
            text("c2t", "Right card"),
          ],
        ),
      },
      {
        name: "dividers",
        messages: basic(
          [
            text("a", "Over"),
            { id: "d", component: "Divider" },
            text("b", "Under"),
            { id: "r", component: "Row", children: ["l", "v", "rt"] },
          ],
          [
            text("l", "Beside"),
            { id: "v", component: "Divider", axis: "vertical" },
            text("rt", "it"),
          ],
        ),
      },
    ],
  ],
  [
    "Tabs, Modal",
    [
      {
        name: "tabs",
        messages: basic(
          [
            {
              id: "t",
              component: "Tabs",
              tabs: [
                { title: "Queue", child: "q" },
                { title: "Done", child: "d" },
                { title: "Failed", child: "f" },
              ],
            },
          ],
          [text("q", "Two plates waiting"), text("d", "Nothing yet"), text("f", "One failed")],
        ),
      },
      {
        name: "modal",
        messages: basic(
          [{ id: "m", component: "Modal", trigger: "open", content: "inside" }],
          [
            ...key("open", "Details"),
            { id: "inside", component: "Column", children: ["ih", "ib", "ik"] },
            text("ih", "# Plate 2"),
            text("ib", "PETG, 3 h 12 m, 41 g"),
            ...key("ik", "Print", { variant: "primary" }),
          ],
        ),
      },
    ],
  ],
  [
    "Button",
    [
      {
        name: "default, primary, borderless",
        messages: basic(
          [{ id: "r", component: "Row", children: ["k", "g", "f"] }],
          [
            ...key("k", "Pause"),
            ...key("g", "Approve", { variant: "primary" }),
            ...key("f", "Later", { variant: "borderless" }),
          ],
        ),
      },
      {
        name: "off, with an icon",
        messages: basic(
          [
            key("off", "Send", {
              variant: "primary",
              checks: required("/note", "Say something"),
            })[0],
            { id: "ic", component: "Button", child: "icr", action: { event: { name: "press" } } },
          ],
          [
            text("offWords", "Send"),
            { id: "icr", component: "Row", children: ["ici", "ict"] },
            { id: "ici", component: "Icon", name: "print" },
            text("ict", "Print"),
          ],
          { note: "" },
        ),
      },
    ],
  ],
  [
    "TextField",
    [
      {
        name: "empty, filled, number, password",
        messages: basic(
          [
            {
              id: "a",
              component: "TextField",
              label: "Name",
              value: { "@path": "/name" },
              placeholder: "Name…",
            },
            { id: "b", component: "TextField", label: "Spool", value: { "@path": "/spool" } },
            {
              id: "c",
              component: "TextField",
              label: "Grams",
              value: { "@path": "/grams" },
              variant: "number",
            },
            {
              id: "d",
              component: "TextField",
              label: "Key",
              value: { "@path": "/key" },
              variant: "obscured",
            },
          ],
          [],
          { name: "", spool: "PETG black", grams: "41", key: "secret" },
        ),
      },
      {
        name: "long, failing its check",
        messages: basic(
          [
            {
              id: "a",
              component: "TextField",
              label: "Note",
              value: { "@path": "/note" },
              variant: "longText",
              placeholder: "Note…",
            },
            {
              id: "b",
              component: "TextField",
              label: "Order",
              value: { "@path": "/order" },
              checks: required("/order", "An order number"),
            },
          ],
          [],
          { note: "", order: "" },
        ),
      },
    ],
  ],
  [
    "CheckBox, ChoicePicker",
    [
      {
        name: "boxes",
        messages: basic(
          [
            { id: "a", component: "CheckBox", label: "Dry the spool", value: { "@path": "/a" } },
            { id: "b", component: "CheckBox", label: "Brim", value: { "@path": "/b" } },
            {
              id: "c",
              component: "CheckBox",
              label: "Supports",
              value: { "@path": "/c" },
              checks: [{ condition: { "@path": "/c" }, message: "Supports are needed" }],
            },
          ],
          [],
          { a: true, b: false, c: false },
        ),
      },
      {
        name: "several, one",
        messages: basic(
          [
            {
              id: "s",
              component: "ChoicePicker",
              label: "Plates",
              variant: "multipleSelection",
              options: [
                { label: "Plate 1", value: "1" },
                { label: "Plate 2", value: "2" },
                { label: "Plate 3", value: "3" },
              ],
              value: { "@path": "/plates" },
            },
            {
              id: "o",
              component: "ChoicePicker",
              label: "Printer",
              options: [
                { label: "Left", value: "left" },
                { label: "Right", value: "right" },
              ],
              value: { "@path": "/printer" },
            },
          ],
          [],
          { plates: ["1", "3"], printer: ["right"] },
        ),
      },
      {
        name: "chips, filterable",
        messages: basic(
          [
            {
              id: "c",
              component: "ChoicePicker",
              label: "Material",
              variant: "multipleSelection",
              displayStyle: "chips",
              options: [
                { label: "PLA", value: "pla" },
                { label: "PETG", value: "petg" },
                { label: "ASA", value: "asa" },
                { label: "TPU", value: "tpu" },
              ],
              value: { "@path": "/material" },
            },
            {
              id: "f",
              component: "ChoicePicker",
              label: "Color",
              filterable: true,
              options: [
                { label: "Black", value: "black" },
                { label: "White", value: "white" },
                { label: "Gray", value: "gray" },
              ],
              value: { "@path": "/color" },
            },
          ],
          [],
          { material: ["petg"], color: ["gray"] },
        ),
      },
    ],
  ],
  [
    "Slider, DateTimeInput",
    [
      {
        name: "sliders",
        messages: basic(
          [
            {
              id: "a",
              component: "Slider",
              label: "Infill",
              min: 0,
              max: 100,
              value: { "@path": "/infill" },
            },
            {
              id: "b",
              component: "Slider",
              label: "Walls",
              min: 1,
              max: 6,
              steps: 5,
              value: { "@path": "/walls" },
            },
            { id: "c", component: "Slider", max: 1, value: { "@path": "/level" } },
          ],
          [],
          { infill: 15, walls: 3, level: 0.4 },
        ),
      },
      {
        name: "date, time, both",
        messages: basic(
          [
            { id: "a", component: "DateTimeInput", label: "Due", value: { "@path": "/due" } },
            {
              id: "b",
              component: "DateTimeInput",
              label: "At",
              enableTime: true,
              value: { "@path": "/at" },
            },
            {
              id: "c",
              component: "DateTimeInput",
              label: "Starts",
              enableDate: true,
              enableTime: true,
              value: { "@path": "/starts" },
            },
            { id: "d", component: "DateTimeInput", label: "Ends", value: { "@path": "/ends" } },
          ],
          [],
          { due: "2026-11-24", at: "14:30", starts: "2026-11-24T09:00:00", ends: "" },
        ),
      },
    ],
  ],
]

/** House parts in a basic Column, the root, on a surface of Switch's catalog. */
const house = (top: readonly Component[], inner: readonly Component[] = []) =>
  surface(SWITCH_CATALOG, [
    {
      id: "root",
      component: "Column",
      catalogId: BASIC_CATALOG,
      children: top.map((c) => String(c.id)),
    },
    ...top,
    ...inner,
  ])

const HOUSE: readonly Cell[] = [
  {
    name: "Title, Line, Slot, Field",
    messages: house(
      [
        { id: "t", component: "Title", label: "Plate 2", needsYou: true },
        { id: "lines", component: "List", catalogId: BASIC_CATALOG, children: ["l", "s", "f"] },
      ],
      [
        { id: "l", component: "Line", label: "Printing", running: true, elapsed: 754_000 },
        { id: "s", component: "Slot", time: "2:00 PM", title: "Spool", conflict: true },
        { id: "f", component: "Field", label: "Bed", value: "70°C", alert: true },
      ],
    ),
  },
  {
    name: "Row, Pick, Check, Entry",
    messages: house(
      [
        {
          id: "lines",
          component: "List",
          catalogId: BASIC_CATALOG,
          children: ["r", "c1", "c2"],
        },
        { id: "e", component: "Entry", placeholder: "Add…", action: "add", field: "text" },
      ],
      [
        {
          id: "r",
          component: "Row",
          label: "Left printer",
          mark: "running",
          detail: "Plate 2",
          values: ["45%"],
          progress: 45,
          children: ["p1", "p2"],
        },
        { id: "c1", component: "Check", label: "Dry the spool", done: true, action: "tick" },
        { id: "c2", component: "Check", label: "Level the bed", action: "tick" },
        {
          id: "p1",
          component: "Pick",
          label: "PETG",
          swatch: "222222",
          strong: true,
          groups: [{ key: "material", choices: ["PLA", "PETG"] }],
          action: "set_filament",
        },
        {
          id: "p2",
          component: "Pick",
          label: "PLA",
          groups: [{ key: "material", choices: ["PLA", "PETG"] }],
          action: "set_filament",
        },
      ],
    ),
  },
  {
    name: "Gallery",
    messages: house([
      {
        id: "g",
        component: "Gallery",
        images: [1, 2, 3, 4].map((n) => ({ url: icon, description: `Icon ${String(n)}` })),
      },
    ]),
  },
  ...[240, 360].map((w) => ({
    name: `Playing, ${String(w)} wide`,
    w,
    messages: house([
      {
        id: "now",
        component: "Playing",
        title: "Windowlicker",
        by: "Aphex Twin",
        art: icon,
        playing: true,
        at: 140_000,
        length: 366_000,
        asOf: Date.now(),
        back: "previous",
        toggle: "toggle",
        next: "next",
      },
    ]),
  })),
  {
    name: "Playing, paused",
    w: 240,
    messages: house([
      {
        id: "now",
        component: "Playing",
        title: "Windowlicker",
        by: "Aphex Twin",
        art: icon,
        playing: false,
        at: 140_000,
        length: 366_000,
        back: "previous",
        toggle: "toggle",
        next: "next",
      },
    ]),
  },
  {
    name: "Feed, failing",
    messages: house([{ id: "f", component: "Feed", action: "camera", ratio: 16 / 9 }]),
  },
]

/** Widgets written for the parts the house catalog dropped, read as what replaced them. */
const OLD: readonly Cell[] = [
  {
    name: "Stack, Head, Lines, Empty",
    messages: surface(
      SWITCH_CATALOG,
      [
        { id: "root", component: "Stack", children: ["head", "rows", "empty"] },
        { id: "head", component: "Head", label: "Today" },
        { id: "rows", component: "Lines", children: { componentId: "row", path: "/rows" } },
        {
          id: "row",
          component: "Slot",
          time: { "@path": "time" },
          title: { "@path": "title" },
        },
        { id: "empty", component: "Empty", label: "Clear" },
      ],
      {
        rows: [
          { time: "9:00 AM", title: "Brackets" },
          { time: "2:00 PM", title: "Spool" },
        ],
      },
    ),
  },
  {
    name: "bound Head, empty Empty, Picture",
    messages: surface(
      SWITCH_CATALOG,
      [
        { id: "root", component: "Stack", children: ["head", "pic", "empty"] },
        { id: "head", component: "Head", label: { "@path": "/day" } },
        { id: "pic", component: "Picture", src: icon },
        { id: "empty", component: "Empty", label: { "@path": "/empty" } },
      ],
      { day: "Monday", empty: "" },
    ),
  },
  {
    name: "a heading with nothing",
    messages: surface(
      SWITCH_CATALOG,
      [
        { id: "root", component: "Stack", children: ["head", "empty"] },
        { id: "head", component: "Head", label: { "@path": "/day" } },
        { id: "empty", component: "Empty", label: { "@path": "/empty" } },
      ],
      { day: "", empty: "Clear" },
    ),
  },
]

const Drawn = ({ name, messages }: { name: string; messages: readonly unknown[] }) => {
  const shown = useQuery({
    queryKey: ["gallery", name],
    queryFn: () => take(`gallery/${name}`, messages),
    staleTime: Infinity,
    structuralSharing: false,
    retry: false,
  })
  if (shown.error) {
    return <p className="m-0 p-inset text-small text-red">{shown.error.message}</p>
  }
  return shown.data ? <A2uiSurface surface={shown.data} /> : null
}

const Cells = ({ part, cells }: { part: string; cells: readonly Cell[] }) => (
  <section data-part={part} className="flex flex-col line-1-b">
    <h2 className="m-0 flex h-line items-center px-inset text-small font-semibold text-ink2">
      <span className="trim">{part}</span>
    </h2>
    <div className="flex flex-wrap items-start gap-4 px-inset pb-4">
      {cells.map((c) => (
        <span key={c.name} className="flex flex-col gap-2">
          <span className="text-small text-ink3">{c.name}</span>
          <div
            data-cell-name={`${part}: ${c.name}`}
            className="widget-cell widget-body edge"
            style={{ width: c.w ?? 340 }}
          >
            <Drawn name={`${part}/${c.name}`} messages={c.messages} />
          </div>
        </span>
      ))}
    </div>
  </section>
)

export const WidgetParts = () => (
  <>
    {BASIC.map(([part, cells]) => (
      <Cells key={part} part={part} cells={cells} />
    ))}
    <Cells part="House parts" cells={HOUSE} />
    <Cells part="Dropped parts, read as their replacements" cells={OLD} />
  </>
)
