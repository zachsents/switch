// paths.ts <out-dir> [--size 1000x640] [--only a,b] [--spaces <file.json | space=<id>,space2=<id>>]
//          [--journeys <file.ts>] [--analyze]
// The journey gate. Plays each journey (journeys.ts) in the test app on $MINI (scripts/test-app.sh)
// while recording its window at 60 fps (record/rec.swift), then reads every frame whose content
// changed after each action and judges it. An action passes only when its first changed frame is
// (near-)identical to its final, settled frame. Flags: blank frames, fades (frames blended between
// before and after), reflows (a large change after the first), late pop-ins (changes > 100 ms after
// the first) and any change inside a journey's `still` rects. Writes per journey a contact sheet
// and a JSON verdict, and index.md, to <out-dir>. `--analyze` judges recordings already in
// <out-dir>/raw without playing anything. Space ids are data: --spaces, or $JOURNEY_SPACES.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

import type { Journey, Rect, Step } from "./journeys.ts"

const HERE = import.meta.dir
const ID = process.env.SWITCH_APP_ID ?? "switch.ui2.test"
const SCRATCH = process.env.TEST_SCRATCH ?? "switch-test"
const MINI = process.env.MINI ?? ""

/** Per-channel difference that counts as a changed pixel; video noise stays under it. */
const PIXEL = 24
/** Changed pixels, as a share of the frame, below which two frames are the same. */
const SAME = 0.0004
/** A change this large between two frames moves things: a reflow. */
const REFLOW = 0.02
/** How far the first changed frame may be from the final: below a small badge (a "LIVE" plate is
 * 0.15%), above what live content drifts by between quiet frames' masks. */
const FIRST_FINAL = 0.001
const LATE_MS = 100
/** Width the frames are judged at. */
const JUDGE_W = 640
const SHEET_W = 360
const SHEET_MAX = 36

// ---- Arguments

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const [out] = args
if (out === undefined || out.startsWith("--")) {
  console.error(
    "usage: paths.ts <out-dir> [--size WxH] [--only a,b] [--spaces file|k=id,..] [--analyze]",
  )
  process.exit(2)
}
const analyzeOnly = args.includes("--analyze")
const size = (flag("--size") ?? "1000x640").split("x").map(Number)
const only = flag("--only")?.split(",")
// The journeys place their points by the window's size.
process.env.GATE_SIZE = size.join("x")
// Another journeys file (its `journeys` export) may stand in for journeys.ts.
const isJourneys = (m: unknown): m is { journeys: readonly Journey[] } =>
  typeof m === "object" && m !== null && "journeys" in m && Array.isArray(m.journeys)
const loaded: unknown = await import(
  path.resolve(flag("--journeys") ?? path.join(HERE, "journeys.ts"))
)
if (!isJourneys(loaded)) {
  throw new Error("the journeys file exports no `journeys` array")
}
const { journeys } = loaded
const spacesArg = flag("--spaces") ?? process.env.JOURNEY_SPACES ?? ""

const SpacesFile = Schema.Record(Schema.String, Schema.String)
const spaces: Record<string, string> = { home: "home" }
if (spacesArg && existsSync(spacesArg)) {
  Object.assign(
    spaces,
    Schema.decodeUnknownSync(SpacesFile)(JSON.parse(readFileSync(spacesArg, "utf-8"))),
  )
} else if (spacesArg) {
  for (const pair of spacesArg.split(",")) {
    const [k, v] = pair.split("=")
    if (k !== undefined && v !== undefined) {
      spaces[k] = v
    }
  }
}

/** The journey with its `{name}` holes filled, or the first name it lacks. */
const resolve = (j: Journey) => {
  let missing = ""
  const fill = (s: string) =>
    s.replaceAll(/\{(?<k>\w+)\}/gu, (_m, k: string) => {
      const v = spaces[k]
      if (v === undefined) {
        missing = k
        return ""
      }
      return v
    })
  const steps = (list: readonly Step[]) =>
    list.map((s) => (s.url === undefined ? s : { ...s, url: fill(s.url) }))
  const r = { ...j, setup: steps(j.setup), act: steps(j.act) }
  return { journey: r, missing }
}

// ---- Running on the Mac

const run = async (cmd: readonly string[], input?: string) => {
  const p = Bun.spawn([...cmd], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, stdout, stderr }
}

const mx = async (command: string) => await run(["sh", path.join(HERE, "record/mx.sh"), command])

const play = async (name: string, j: Journey, raw: string) => {
  const [w, h] = size
  const steps: Step[] = [
    { do: "size", w, h, x: 0, y: 0 },
    { do: "activate" },
    ...j.setup,
    // Keep keyboard journeys away from hover controls left under the pointer by a prior journey.
    { do: "move", x: Math.round((w ?? 1000) / 2), y: 15 },
    // Recording starts here, left alone a moment first: what moves then is live.
    { do: "mark" },
    { do: "settle", ms: 1000 },
    ...j.act,
  ]
  const remote = `${SCRATCH}/runs`
  const local = mkdtempSync(path.join(tmpdir(), "paths-"))
  writeFileSync(path.join(local, `${name}.steps.json`), JSON.stringify(steps))
  await run(["ssh", MINI, `mkdir -p ${remote}`])
  await run(["scp", "-q", path.join(local, `${name}.steps.json`), `${MINI}:${remote}/`])
  rmSync(local, { recursive: true })
  const r = await mx(
    `cd ~/${remote} && ~/${SCRATCH}/rec/rec run ${ID} ${name}.steps.json ${name}.mov ${j.capture ?? "window"}`,
  )
  if (r.code !== 0) {
    throw new Error(`${name}: ${r.stderr.trim() || r.stdout.trim()}`)
  }
  const got = await run([
    "scp",
    "-q",
    `${MINI}:${remote}/${name}.mov`,
    `${MINI}:${remote}/${name}.json`,
    raw,
  ])
  if (got.code !== 0) {
    throw new Error(`${name}: ${got.stderr.trim()}`)
  }
  await run([
    "ssh",
    MINI,
    `rm -f ${remote}/${name}.mov ${remote}/${name}.json ${remote}/${name}.steps.json`,
  ])
  if (j.after === "relaunch") {
    await run(["sh", path.join(HERE, "test-app.sh"), "launch"])
  }
}

// ---- Frames

const Recording = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      t: Schema.Number,
      /** When the input was done (a drag let go); older recordings have none. */
      end: Schema.optionalKey(Schema.Number),
      do: Schema.String,
      label: Schema.optionalKey(Schema.String),
      keys: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  frames: Schema.Array(Schema.Number),
  window: Schema.Struct({
    w: Schema.Number,
    h: Schema.Number,
    px_w: Schema.Number,
    px_h: Schema.Number,
  }),
})
type Recording = typeof Recording.Type

interface Frames {
  readonly w: number
  readonly h: number
  readonly data: readonly Uint8Array[]
  /** 1 where a pixel is judged, 0 where an `ignore` rect leaves it out. */
  readonly mask: Uint8Array
  readonly scale: number
}

const decode = async (mov: string, rec: Recording, ignore: readonly Rect[]): Promise<Frames> => {
  const scale = Math.min(1, JUDGE_W / rec.window.px_w)
  const w = Math.round((rec.window.px_w * scale) / 2) * 2
  const h = Math.round((rec.window.px_h * scale) / 2) * 2
  const p = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      mov,
      "-fps_mode",
      "passthrough",
      "-vf",
      `scale=${w}:${h}:flags=area,setpts=N`,
      "-enc_time_base",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const all = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  const n = w * h * 3
  const data: Uint8Array[] = []
  for (let o = 0; o + n <= all.length; o += n) {
    data.push(all.subarray(o, o + n))
  }
  // Points to judged pixels: the window's points times its pixel scale times the judging scale.
  const k = (rec.window.px_w / rec.window.w) * scale
  const mask = new Uint8Array(w * h).fill(1)
  for (const [rx, ry, rw, rh] of ignore) {
    for (
      let y = Math.max(0, Math.floor(ry * k));
      y < Math.min(h, Math.ceil((ry + rh) * k));
      y += 1
    ) {
      mask.fill(
        0,
        y * w + Math.max(0, Math.floor(rx * k)),
        y * w + Math.min(w, Math.ceil((rx + rw) * k)),
      )
    }
  }
  maskLive(data, w, h, mask, quietFrames(rec, data.length))
  return { w, h, data, mask, scale: k }
}

/** How long before an action, and before each action's end, the window is left alone, ms. */
const QUIET_MS = 1500
/** How far a live pixel's mask reaches round it, judged pixels. */
const REACH = 3

/** The frames when nothing was done: before the first action, and each action's last stretch, once
 * it has had time to settle. What changes then (a watch's hands, a camera, a caret) is live. */
const quietFrames = (rec: Recording, n: number) => {
  const times = rec.frames.slice(0, n)
  const actions = rec.events.filter((e) => INPUTS.has(e.do)).map((e) => e.t)
  const ends = [...actions.slice(1), times.at(-1) ?? 0]
  const windows: (readonly [number, number])[] = [
    [0, (actions[0] ?? 0) - 50],
    ...actions.map(
      (t, i) => [Math.max(t + 900, (ends[i] ?? t) - QUIET_MS), (ends[i] ?? t) - 20] as const,
    ),
  ]
  return times.flatMap((t, k) => (k > 0 && windows.some(([a, b]) => t > a && t <= b) ? [k] : []))
}

/** Leaves out of every judgment the pixels that change in quiet frames, and those near them. */
const maskLive = (
  data: readonly Uint8Array[],
  w: number,
  h: number,
  mask: Uint8Array,
  quiet: readonly number[],
) => {
  const live = new Uint8Array(w * h)
  for (const k of quiet) {
    const a = data[k - 1]
    const b = data[k]
    if (!a || !b) {
      continue
    }
    for (let i = 0; i < w * h; i += 1) {
      const o = i * 3
      if (
        Math.abs(byte(a, o) - byte(b, o)) > PIXEL ||
        Math.abs(byte(a, o + 1) - byte(b, o + 1)) > PIXEL ||
        Math.abs(byte(a, o + 2) - byte(b, o + 2)) > PIXEL
      ) {
        live[i] = 1
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (live[y * w + x] === 1) {
        for (let dy = -REACH; dy <= REACH; dy += 1) {
          for (let dx = -REACH; dx <= REACH; dx += 1) {
            const yy = y + dy
            const xx = x + dx
            if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
              mask[yy * w + xx] = 0
            }
          }
        }
      }
    }
  }
}

const byte = (p: Uint8Array, o: number) => p[o] ?? 0

/** Changed pixels between two frames, as a share of the judged ones, optionally inside a rect. */
const diff = (f: Frames, a: number, b: number, rect?: Rect) => {
  const pa = f.data[a]
  const pb = f.data[b]
  if (!pa || !pb) {
    return 0
  }
  let x0 = 0
  let y0 = 0
  let x1 = f.w
  let y1 = f.h
  if (rect) {
    x0 = Math.max(0, Math.floor(rect[0] * f.scale))
    y0 = Math.max(0, Math.floor(rect[1] * f.scale))
    x1 = Math.min(f.w, Math.ceil((rect[0] + rect[2]) * f.scale))
    y1 = Math.min(f.h, Math.ceil((rect[1] + rect[3]) * f.scale))
  }
  let changed = 0
  let judged = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * f.w + x
      if (f.mask[i] === 0) {
        continue
      }
      judged += 1
      const o = i * 3
      if (
        Math.abs(byte(pa, o) - byte(pb, o)) > PIXEL ||
        Math.abs(byte(pa, o + 1) - byte(pb, o + 1)) > PIXEL ||
        Math.abs(byte(pa, o + 2) - byte(pb, o + 2)) > PIXEL
      ) {
        changed += 1
      }
    }
  }
  return judged === 0 ? 0 : changed / judged
}

/** Where two frames differ inside a rect, in points: x,y,w,h. */
const boxOf = (f: Frames, a: number, b: number, rect: Rect) => {
  const pa = f.data[a]
  const pb = f.data[b]
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
  if (pa && pb) {
    for (
      let y = Math.floor(rect[1] * f.scale);
      y < Math.min(f.h, (rect[1] + rect[3]) * f.scale);
      y += 1
    ) {
      for (
        let x = Math.floor(rect[0] * f.scale);
        x < Math.min(f.w, (rect[0] + rect[2]) * f.scale);
        x += 1
      ) {
        const i = y * f.w + x
        const o = i * 3
        if (f.mask[i] === 1 && Math.abs(byte(pa, o) - byte(pb, o)) > PIXEL) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
      }
    }
  }
  const pt = (v: number) => Math.round(v / f.scale)
  return x1 < 0 ? "-" : `${pt(x0)},${pt(y0)},${pt(x1 - x0 + 1)},${pt(y1 - y0 + 1)}`
}

const luma = (p: Uint8Array, o: number) =>
  0.299 * byte(p, o) + 0.587 * byte(p, o + 1) + 0.114 * byte(p, o + 2)

/** Mostly one color: 98% of pixels within 10 of the median brightness. */
const blank = (f: Frames, k: number) => {
  const p = f.data[k]
  if (!p) {
    return false
  }
  const hist = new Float64Array(256)
  const total = f.w * f.h
  for (let i = 0; i < total; i += 1) {
    const b = Math.round(luma(p, i * 3))
    hist[b] = (hist[b] ?? 0) + 1
  }
  let seen = 0
  let median = 0
  while (seen < total / 2) {
    seen += hist[median] ?? 0
    median += 1
  }
  let near = 0
  for (let v = Math.max(0, median - 11); v <= Math.min(255, median + 9); v += 1) {
    near += hist[v] ?? 0
  }
  return near / total > 0.98
}

/** A frame between the one before it and the final: most pixels that differ lie strictly between. */
const blended = (f: Frames, prev: number, k: number, final: number) => {
  const a = f.data[prev]
  const m = f.data[k]
  const z = f.data[final]
  if (!a || !m || !z) {
    return false
  }
  let moving = 0
  let between = 0
  for (let i = 0; i < f.w * f.h; i += 1) {
    if (f.mask[i] === 0) {
      continue
    }
    const o = i * 3
    const la = luma(a, o)
    const lz = luma(z, o)
    if (Math.abs(la - lz) < PIXEL) {
      continue
    }
    moving += 1
    const lm = luma(m, o)
    const lo = Math.min(la, lz) + 6
    const hi = Math.max(la, lz) - 6
    if (lm > lo && lm < hi) {
      between += 1
    }
  }
  return moving > f.w * f.h * SAME && between / moving > 0.5
}

// ---- Judging

const INPUTS = new Set(["click", "drag", "key", "type", "scroll", "open", "size", "menu"])

interface Segment {
  readonly action: string
  readonly at_ms: number
  readonly first_change_ms: number | null
  readonly settled_ms: number | null
  readonly changes: number
  readonly first_vs_final: number | null
  readonly pass: boolean
  readonly flags: readonly string[]
  /** Frames for the sheet: the one before, each change, the final. */
  readonly sheet: readonly { readonly k: number; readonly label: string }[]
}

/** The frames after an action up to the next one, and the last frame before it. */
const span = (times: readonly number[], from: number, to: number) => {
  const inside: number[] = []
  for (const [k, t] of times.entries()) {
    if (t > from && t <= to) {
      inside.push(k)
    }
  }
  return {
    inside,
    before: Math.max(
      0,
      times.findLastIndex((t) => t <= from),
    ),
  }
}

/** Fade frames (blends toward the final) and reflows (a large change after the first, not a fade's). */
const motion = (f: Frames, changes: readonly number[], final: number) => {
  const fades = changes.filter((k) => k !== final && blended(f, k - 1, k, final))
  const reflows = changes
    .slice(1)
    .filter((k) => diff(f, k - 1, k) > REFLOW && !fades.includes(k) && !fades.includes(k - 1))
  return { fades, reflows }
}

/** A journey's recorded inputs, in order: its act's, as the recording lists its actions. */
const inputsOf = (j: Journey) => j.act.filter((s) => INPUTS.has(s.do))

/** How long the hand is on an input, ms: a drag's holds and travel (rec.swift's defaults), a
 * scroll's steps. */
const handMs = (s: Journey["act"][number] | undefined) => {
  if (s?.do === "drag") {
    // Each step of its travel waits a frame on top of posting it.
    return (s.ms ?? 400) * 1.2 + 2 * (s.hold ?? 150) + 80
  }
  if (s?.do === "scroll") {
    return Math.max(1, Math.floor(Math.abs(s.dy ?? 0) / 40)) * 17 + 50
  }
  return 0
}

/** A drag's or scroll's frames that change after the hand lets go; 0 for any other journey. */
const settlesOf = (
  f: Frames,
  j: Journey,
  ai: number,
  e: { readonly t: number; readonly end?: number },
  changes: readonly number[],
  at: (k: number) => number,
) => {
  if (j.rule !== "motion") {
    return 0
  }
  const released = e.end ?? e.t + handMs(inputsOf(j)[ai])
  // A settle is a frame that moves things (a reflow's size of change), not live content redrawn.
  return changes.filter((k) => at(k) > released && diff(f, k - 1, k) > REFLOW).length
}

/** A journey's verdict: its first changed frame its final (a drag or scroll: at most one settle
 * frame), no blank frame, nothing still moved. */
const passes = (
  j: Journey,
  settles: number,
  firstVsFinal: number,
  blanks: number,
  flags: readonly string[],
) =>
  (j.rule === "motion" ? settles <= 1 : firstVsFinal <= FIRST_FINAL) &&
  blanks === 0 &&
  !flags.some(
    (x) =>
      x.startsWith("still") ||
      x.startsWith("blank live") ||
      x.startsWith("fade") ||
      (j.rule !== "motion" && (x.startsWith("reflow") || x.startsWith("late"))),
  )

/** An action after which nothing changed: a fail, but for a window shown again as it was. */
const unchanged = (
  j: Journey,
  action: string,
  t: number,
  before: number,
  flags: readonly string[],
): Segment => {
  // A window shown again as it was, or a scroll with nothing to scroll: nothing moved, nothing should.
  const again = (j.rule === "again" || j.mayStay === true) && flags.length === 0
  return {
    action,
    at_ms: Math.round(t),
    first_change_ms: null,
    settled_ms: null,
    changes: 0,
    first_vs_final: null,
    pass: again,
    flags: again ? [] : ["no change", ...flags],
    sheet: [{ k: before, label: "before" }],
  }
}

/** Excludes only declared live image interiors, preserving the surrounding plate and lines. */
const liveFrames = (f: Frames, rects: readonly Rect[]) => {
  if (rects.length === 0) {
    return f
  }
  const mask = new Uint8Array(f.mask)
  for (const [x, y, w, h] of rects) {
    for (
      let yy = Math.ceil(y * f.scale);
      yy < Math.min(f.h, Math.floor((y + h) * f.scale));
      yy += 1
    ) {
      for (
        let xx = Math.ceil(x * f.scale);
        xx < Math.min(f.w, Math.floor((x + w) * f.scale));
        xx += 1
      ) {
        mask[yy * f.w + xx] = 0
      }
    }
  }
  return { ...f, mask }
}

/** Checks a live image separately: excluding its moving pixels must never conceal a blank load. */
const blankImage = (f: Frames, k: number, [x, y, w, h]: Rect) => {
  const source = f.data[k]
  if (!source) {
    return false
  }
  const x0 = Math.max(0, Math.ceil(x * f.scale))
  const y0 = Math.max(0, Math.ceil(y * f.scale))
  const width = Math.min(f.w - x0, Math.floor(w * f.scale))
  const height = Math.min(f.h - y0, Math.floor(h * f.scale))
  const pixels = new Uint8Array(width * height * 3)
  for (let row = 0; row < height; row += 1) {
    const at = ((y0 + row) * f.w + x0) * 3
    pixels.set(source.subarray(at, at + width * 3), row * width * 3)
  }
  return blank({ ...f, w: width, h: height, data: [pixels] }, 0)
}

const blankImages = (f: Frames, first: number, final: number, rects: readonly Rect[]) =>
  rects.some((r) => blankImage(f, first, r) && !blankImage(f, final, r))

const judge = (j: Journey, rec: Recording, frames: Frames): Segment[] => {
  const interiors = j.live ?? {}
  const times = rec.frames.slice(0, frames.data.length)
  const actions = rec.events.filter((e) => INPUTS.has(e.do))
  const ends = [...actions.slice(1).map((e) => e.t), Number.POSITIVE_INFINITY]
  return actions.map((e, ai) => {
    const live = interiors[ai] ?? []
    const f = liveFrames(frames, live)
    const { inside, before } = span(times, e.t, ends[ai] ?? Number.POSITIVE_INFINITY)
    const at = (k: number) => times[k] ?? 0
    const action = [e.do, e.label ?? e.keys ?? e.url].filter(Boolean).join(" ")
    const changes = inside.filter((k) => diff(f, k - 1, k) > SAME)
    const flags: string[] = []
    const final = inside.at(-1) ?? before
    const rel = (k: number) => Math.round(at(k) - e.t)
    const moved = (j.still ?? []).filter((r) => inside.some((k) => diff(f, before, k, r) > SAME))
    for (const r of moved) {
      const k = inside.find((x) => diff(f, before, x, r) > SAME) ?? before
      flags.push(
        `still ${r.join(",")} moved at +${Math.round(at(k) - e.t)}ms in ${boxOf(f, before, k, r)}`,
      )
    }
    const [first] = changes
    if (first === undefined) {
      return unchanged(j, action, e.t, before, flags)
    }
    if (blankImages(frames, first, final, live)) {
      flags.push("blank live image on first frame")
    }
    const last = changes.at(-1) ?? first
    const finalBlank = blank(f, final)
    const blanks = changes.filter((k) => !finalBlank && blank(f, k))
    if (blanks.length > 0) {
      flags.push(`blank ${blanks.map((k) => `+${rel(k)}`).join(" ")}`)
    }
    const { fades, reflows } = motion(f, changes, final)
    if (fades.length >= 2) {
      flags.push(`fade ${fades.length} frames`)
    }
    if (reflows.length > 0) {
      flags.push(`reflow ${reflows.map((k) => `+${rel(k)}`).join(" ")}`)
    }
    const late = changes.filter((k) => at(k) - at(first) > LATE_MS)
    if (late.length > 0) {
      flags.push(`late ${late.length} until +${rel(late.at(-1) ?? first)}`)
    }
    const firstVsFinal = diff(f, first, final)
    const settles = settlesOf(f, j, ai, e, changes, at)
    if (settles > 1) {
      flags.push(`${settles} frames after release`)
    }
    const pass = passes(j, settles, firstVsFinal, blanks.length, flags)
    const shown =
      changes.length <= SHEET_MAX
        ? changes
        : changes.filter((_k, i) => i % Math.ceil(changes.length / SHEET_MAX) === 0)
    const tag = (k: number) =>
      [
        `+${rel(k)}ms`,
        blanks.includes(k) ? "blank" : "",
        fades.includes(k) ? "fade" : "",
        reflows.includes(k) ? "reflow" : "",
      ]
        .filter(Boolean)
        .join(" ")
    return {
      action,
      at_ms: Math.round(e.t),
      first_change_ms: rel(first),
      settled_ms: rel(last),
      changes: changes.length,
      first_vs_final: Number(firstVsFinal.toFixed(5)),
      first_vs_final_including_live: Number(diff(frames, first, final).toFixed(5)),
      live_interiors: live,
      pass,
      flags,
      sheet: [
        { k: before, label: `${action}: before` },
        ...shown.map((k) => ({ k, label: tag(k) })),
        ...(shown.includes(final) ? [] : [{ k: final, label: `final +${rel(final)}ms` }]),
      ],
    }
  })
}

const sheet = async (mov: string, segments: readonly Segment[], dest: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sheet-"))
  const wanted = [...new Set(segments.flatMap((s) => s.sheet.map((x) => x.k)))].toSorted(
    (a, b) => a - b,
  )
  if (wanted.length === 0) {
    return
  }
  const select = wanted.map((k) => `eq(n\\,${k})`).join("+")
  await run([
    "ffmpeg",
    "-v",
    "error",
    "-i",
    mov,
    "-vf",
    `select='${select}',scale=${SHEET_W}:-2`,
    "-fps_mode",
    "passthrough",
    path.join(dir, "%05d.png"),
  ])
  const file = (k: number) =>
    path.join(dir, `${String(wanted.indexOf(k) + 1).padStart(5, "0")}.png`)
  const tiles: string[] = []
  for (const s of segments) {
    for (const x of s.sheet) {
      tiles.push("-label", x.label, file(x.k))
    }
  }
  // ImageMagick may know no fonts by name; Menlo is on every Mac.
  const made = await run([
    "magick",
    "montage",
    "-font",
    "/System/Library/Fonts/Menlo.ttc",
    ...tiles,
    "-tile",
    "6x",
    "-geometry",
    "+4+4",
    "-pointsize",
    "13",
    "-background",
    "#1b1b1b",
    "-fill",
    "#e8e8e8",
    dest,
  ])
  rmSync(dir, { recursive: true })
  if (made.code !== 0) {
    throw new Error(`sheet: ${made.stderr.trim()}`)
  }
}

// ---- Main

if (!analyzeOnly && !MINI) {
  console.error("MINI: the Mac the test app runs on (ssh host)")
  process.exit(2)
}
const raw = path.join(out, "raw")
mkdirSync(raw, { recursive: true })
/** One journey played (unless only analyzed) and judged: its rows in the index. */
const gate = async (base: Journey): Promise<string[]> => {
  const { journey, missing } = resolve(base)
  const { name } = base
  if (missing) {
    console.log(`${name}: skipped, no {${missing}}`)
    return []
  }
  const mov = path.join(raw, `${name}.mov`)
  try {
    if (!analyzeOnly) {
      // $GATE_WAIT, if set, runs first and returns once the app's data holds still (no turn running
      // on the core): what an agent's live work changes on screen is no verdict on the app.
      const wait = process.env.GATE_WAIT ?? ""
      if (wait !== "") {
        await run(["sh", "-c", wait])
      }
      await play(name, journey, raw)
    }
    const rec = Schema.decodeUnknownSync(Recording)(
      JSON.parse(readFileSync(path.join(raw, `${name}.json`), "utf-8")),
    )
    const frames = await decode(mov, rec, journey.ignore ?? [])
    const segments = judge(journey, rec, frames)
    await sheet(mov, segments, path.join(out, `${name}.png`))
    const pass = segments.length > 0 && segments.every((x) => x.pass)
    const verdict = {
      journey: name,
      capture: journey.capture ?? "window",
      pass,
      window: `${rec.window.w}x${rec.window.h}`,
      frames: frames.data.length,
      segments: segments.map(({ sheet: _s, ...x }) => x),
    }
    writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(verdict, null, 2)}\n`)
    console.log(
      `${name}: ${pass ? "pass" : "FAIL"} ${segments.map((x) => `${x.action} ${x.first_change_ms ?? "-"}/${x.settled_ms ?? "-"}ms ${x.flags.join(",")}`).join(" | ")}`,
    )
    return segments.map(
      (x) =>
        `| ${name} | ${verdict.window} | ${x.action} | ${x.pass ? "pass" : "FAIL"} | ${x.first_change_ms ?? "-"} | ${x.settled_ms ?? "-"} | ${x.changes} | ${x.flags.join("; ")} | [sheet](${name}.png) |`,
    )
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    console.log(`${name}: error ${why}`)
    return [
      `| ${name} | - | - | ERROR | - | - | - | ${why.replaceAll("|", "/").replaceAll("\n", " ")} | |`,
    ]
  }
}

// One at a time: they share the one window.
const each = async (
  list: readonly Journey[],
  done: readonly string[],
): Promise<readonly string[]> => {
  const [j, ...rest] = list
  if (j === undefined) {
    return done
  }
  return await each(rest, [...done, ...(await gate(j))])
}
const rows = await each(
  journeys.filter((j) => !only || only.includes(j.name)),
  [],
)
writeFileSync(
  path.join(out, "index.md"),
  [
    `# Journeys at ${size.join("x")}`,
    "",
    "First change and settled: ms after the action. Pass: first changed frame = settled frame.",
    "",
    "| journey | window | action | verdict | first change | settled | changes | flags | sheet |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n"),
)
console.log(path.join(out, "index.md"))
