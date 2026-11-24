// Filament presets: what a slot is told it holds. Bambu Studio's installed presets when present
// (merged over their `inherits` chain, as the CLI's load_preset), else the generic ones built in.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { Preset } from "./payloads.ts"

const STUDIO =
  process.env.PRINTERS_STUDIO_FILAMENTS ??
  "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament"

/** Bambu Studio 02's generic presets, resolved, for a Mac without Studio. */
const GENERIC: Record<string, Preset> = {
  PLA: { idx: "GFL99", type: "PLA", minTemp: 190, maxTemp: 240 },
  PETG: { idx: "GFG99", type: "PETG", minTemp: 220, maxTemp: 270 },
  ASA: { idx: "GFB98", type: "ASA", minTemp: 240, maxTemp: 280 },
  ABS: { idx: "GFB99", type: "ABS", minTemp: 240, maxTemp: 280 },
  TPU: { idx: "GFU99", type: "TPU", minTemp: 200, maxTemp: 250 },
}

type Json = Record<string, unknown>

const isJson = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x)

const read = (name: string): Json | undefined => {
  const file = path.join(STUDIO, `${name}.json`)
  if (!existsSync(file)) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"))
    return isJson(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const resolve = (name: string, depth = 0): Json | undefined => {
  const preset = read(name)
  if (!preset || depth > 8) {
    return preset
  }
  const parent = typeof preset.inherits === "string" ? resolve(preset.inherits, depth + 1) : {}
  return { ...parent, ...preset }
}

const first = (x: unknown): unknown => (Array.isArray(x) ? (x as unknown[])[0] : x)

const toPreset = (p: Json | undefined): Preset | undefined => {
  const idx = p?.filament_id
  const type = first(p?.filament_type)
  const min = Number(first(p?.nozzle_temperature_range_low))
  const max = Number(first(p?.nozzle_temperature_range_high))
  if (typeof idx !== "string" || typeof type !== "string" || !min || !max) {
    return undefined
  }
  return { idx, type, minTemp: min, maxTemp: max }
}

/**
 * The preset for a brand and type: "Bambu" "PLA" is Bambu PLA Basic, "Polymaker" "PLA" Polymaker
 * PLA, no brand the generic one. Undefined when Studio has no such preset.
 */
export const presetFor = (type: string, brand?: string): Preset | undefined => {
  const t = type.trim().toUpperCase()
  const b = brand?.trim() ?? ""
  if (b === "" || b.toLowerCase() === "generic") {
    return toPreset(resolve(`Generic ${t} @base`)) ?? GENERIC[t]
  }
  for (const name of [`${b} ${type.trim()} @base`, `${b} ${type.trim()} Basic @base`]) {
    const p = toPreset(resolve(name))
    if (p) {
      return p
    }
  }
  return undefined
}

let names: Map<string, string> | undefined

/** A preset id's maker as Studio names it ("Bambu", "Generic", "Polymaker"), if known. */
export const brandOf = (idx: string): string | undefined => {
  if (names === undefined) {
    names = new Map()
    const files = existsSync(STUDIO) ? readdirSync(STUDIO) : []
    for (const f of files.filter((x) => x.endsWith(" @base.json"))) {
      const id = read(f.slice(0, -5))?.filament_id
      if (typeof id === "string" && !names.has(id)) {
        names.set(id, f.split(" ")[0] ?? "")
      }
    }
    for (const p of Object.values(GENERIC)) {
      if (!names.has(p.idx)) {
        names.set(p.idx, "Generic")
      }
    }
  }
  return names.get(idx)
}
