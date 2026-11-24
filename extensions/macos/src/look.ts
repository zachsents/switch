// What this Mac looks like, for its picture in the vitals widget, told by its hardware. An Apple
// silicon Mac carries its product name ("MacBook Air (15-inch, M4, 2025)", "Mac mini (2024)"); an
// Intel one only its model identifier ("MacBookPro16,1"). A Mac neither names as one that's drawn
// is a laptop if it has a battery, else the Mac mini. Sizes are Apple's published ones. Its finish
// is the enclosure colour its device tree carries (`housing-color`, its last word), named as
// macOS's own CoreTypes.bundle names that model in that colour: `Mac16,13@ECOLOR=7` is
// com.apple.macbookair-15-2025-midnight, the colour its per-colour device icon is drawn in.

export interface Look {
  /** A laptop, open; the Mac mini as it's been since 2024, or as it was from 2010; the Mac Studio. */
  readonly form: "laptop" | "mini" | "mini-2010" | "studio"
  /** Width, depth and height, closed, mm. */
  readonly mm: readonly [number, number, number]
  /** Its display has the camera notch (MacBook Pro from 2021, MacBook Air from 2022). */
  readonly notch?: boolean
  /** Its keys sit in a black well (MacBook Pro from 2021). */
  readonly well?: boolean
  /** Its enclosure colour, as CoreTypes names it ("midnight", "space-black"); silver if none. */
  readonly finish?: string
}

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

const MINI: Look = { form: "mini", mm: [127, 127, 50] }
const AIR: Look = { form: "laptop", mm: [304.1, 215, 11.3], notch: true }

/** A MacBook Pro by its screen and year: from 2021 its 14- and 16-inch ones have the notch and
 * the black well. */
const pro = (inches: number, year: number): Look => {
  if (year >= 2021 && (inches === 14 || inches === 16)) {
    return {
      form: "laptop",
      mm: inches === 14 ? [312.6, 221.2, 15.5] : [355.7, 248.1, 16.8],
      notch: true,
      well: true,
    }
  }
  if (inches === 16) {
    return { form: "laptop", mm: [357.9, 245.9, 16.2] }
  }
  return { form: "laptop", mm: inches === 15 ? [349.3, 240.7, 15.5] : [304.1, 212.4, 15.6] }
}

/** What a Mac by this name looks like; `laptop` decides when the name says nothing. */
export const lookOf = (name: string, laptop: boolean): Look => {
  const plain = name.toLowerCase().replaceAll(" ", "")
  const year = Number(/\b(?<year>20\d\d)\b/u.exec(name)?.groups?.year ?? 0)
  const inches = Number(/(?<inches>\d+)-inch/u.exec(name)?.groups?.inches ?? 0)
  if (plain.startsWith("macbookair")) {
    return {
      form: "laptop",
      mm: inches === 15 ? [340.4, 237.6, 11.5] : [304.1, 215, 11.3],
      notch: year >= 2022,
    }
  }
  if (plain.startsWith("macbookpro")) {
    return pro(inches, year)
  }
  if (plain.startsWith("macbook")) {
    return { form: "laptop", mm: [280.5, 196.5, 13.1] }
  }
  if (plain.startsWith("macmini")) {
    return year >= 2024 ? MINI : { form: "mini-2010", mm: [197, 197, 36] }
  }
  if (plain.startsWith("macstudio")) {
    return { form: "studio", mm: [197, 197, 95] }
  }
  return laptop ? AIR : MINI
}

const CORE_TYPES = "/System/Library/CoreServices/CoreTypes.bundle"

const strings = (v: unknown): string[] => {
  if (typeof v === "string") {
    return [v]
  }
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
}

/** The colour CoreTypes names `model` in housing colour `color`: what its type for that model and
 * colour adds to the model's own, the type it conforms to whose name begins its own. */
const colorName = async (model: string, color: number): Promise<string | null> => {
  const code = `${model}@ECOLOR=${color}`
  const files = await run(["grep", "-rlF", "--include=Info.plist", code, CORE_TYPES])
  const plists = await Promise.all(
    files
      .split("\n")
      .filter(Boolean)
      .map(async (file): Promise<unknown> =>
        JSON.parse(await run(["plutil", "-convert", "json", "-o", "-", file])),
      ),
  )
  for (const plist of plists) {
    const types =
      typeof plist === "object" && plist !== null
        ? Object.values(plist)
            .filter((v): v is unknown[] => Array.isArray(v))
            .flat()
        : []
    for (const t of types) {
      if (typeof t !== "object" || t === null || !("UTTypeIdentifier" in t)) {
        continue
      }
      const id = t.UTTypeIdentifier
      const tags = "UTTypeTagSpecification" in t ? t.UTTypeTagSpecification : null
      const codes =
        typeof tags === "object" && tags !== null && "com.apple.device-model-code" in tags
          ? strings(tags["com.apple.device-model-code"])
          : []
      if (typeof id === "string" && codes.includes(code)) {
        const [base] = strings("UTTypeConformsTo" in t ? t.UTTypeConformsTo : null)
          .filter((p) => id.startsWith(`${p}-`))
          .toSorted((x, y) => y.length - x.length)
        if (base !== undefined) {
          return id.slice(base.length + 1)
        }
      }
    }
  }
  return null
}

/** This Mac's enclosure colour, by its device tree's `housing-color`; none on a Mac without one. */
const finish = async (model: string): Promise<string | null> => {
  const tree = await run(["ioreg", "-rd1", "-p", "IODeviceTree", "-k", "housing-color"])
  const hex = /"housing-color" = <(?<hex>[0-9a-f]+)>/u.exec(tree)?.groups?.hex
  if (hex === undefined || hex.length < 8) {
    return null
  }
  const color = Buffer.from(hex.slice(-8), "hex").readUInt32LE(0)
  return color === 0 ? null : await colorName(model, color)
}

/** This Mac: its own name (as Sharing sets it), its look, and whether it has a battery. */
export const thisMac = async () => {
  const [product, model, battery, name] = await Promise.all([
    run(["ioreg", "-rd1", "-k", "product-name"]),
    run(["sysctl", "-n", "hw.model"]),
    run(["pmset", "-g", "batt"]),
    run(["scutil", "--get", "ComputerName"]),
  ])
  const named = /"product-name" = <"(?<name>[^"]+)">/u.exec(product)?.groups?.name ?? model.trim()
  const hasBattery = battery.includes("InternalBattery")
  const color = await finish(model.trim()).catch((): null => null)
  return {
    name: name.trim(),
    look: { ...lookOf(named, hasBattery), ...(color !== null && { finish: color }) },
    battery: hasBattery,
  }
}
