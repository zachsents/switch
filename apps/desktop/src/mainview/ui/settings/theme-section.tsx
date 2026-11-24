// Theme: a preset, the appearance, the background per appearance, the three lines (color per
// appearance, thickness), the state colors, text size. Every change shows at
// once in every window (TanStack Form, its values the theme); nothing to apply.
import { useForm } from "@tanstack/react-form"
import { useState } from "react"

import { Button } from "../kit/button.tsx"
import { Segmented } from "../kit/segmented.tsx"
import { PaneScroll } from "../pane-scroll.tsx"
import {
  PRESET_KEYS,
  PRESET_NAMES,
  PRESETS,
  presetOf,
  sectionOf,
  ThemeSchema,
  useOutside,
  useTheme,
} from "../theme.ts"
import type { Theme } from "../theme.ts"
import { useSetTheme } from "../use-theme-sync.ts"
import { ColorField } from "./color-field.tsx"
import { Group, Setting } from "./setting.tsx"
import { Schema } from "effect"

const valid = Schema.is(ThemeSchema)

const PRESET_OPTIONS = PRESET_KEYS.map((k) => ({ value: k, label: PRESET_NAMES[k] }))
const WIDTHS = [
  { value: "0.5", label: "Hairline" },
  { value: "1", label: "1 pt" },
  { value: "2", label: "2 pt" },
] as const

const widthOf = (v: string) => {
  if (v === "0.5") {
    return 0.5
  }
  return v === "2" ? 2 : 1
}

const Form = ({ start, onPreset }: { start: Theme; onPreset: (t: Theme) => void }) => {
  const set = useSetTheme()
  const form = useForm({
    // A theme without its own section line shows the one worked out for it.
    defaultValues: { ...start, section: sectionOf(start) },
    listeners: {
      onChange: ({ formApi }) => {
        const t: unknown = formApi.state.values
        if (valid(t)) {
          set(t)
        }
      },
    },
  })
  const theme = useTheme()
  const preset = presetOf(theme)
  return (
    <PaneScroll className="flex-1">
      <Group label="Theme">
        <Setting label="Preset">
          <Segmented
            label="Preset"
            options={
              preset === null
                ? [...PRESET_OPTIONS, { value: "custom", label: "Custom" }]
                : PRESET_OPTIONS
            }
            value={preset ?? "custom"}
            onChange={(v) => {
              const k = PRESET_KEYS.find((x) => x === v)
              if (k) {
                onPreset(PRESETS[k])
              }
            }}
          />
        </Setting>
        <form.Field name="appearance">
          {(f) => (
            <Setting label="Appearance">
              <Segmented
                label="Appearance"
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
                value={f.state.value}
                onChange={(v) => {
                  f.handleChange(v === "light" || v === "dark" ? v : "system")
                }}
              />
            </Setting>
          )}
        </form.Field>
        <Setting label="Background">
          <form.Field name="bg.light">
            {(f) => <ColorField label="Light" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="bg.dark">
            {(f) => <ColorField label="Dark" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
        </Setting>
      </Group>
      <Group label="Lines">
        <Setting label="Between panes">
          <form.Field name="line1.light">
            {(f) => <ColorField label="Light" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="line1.dark">
            {(f) => <ColorField label="Dark" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="line1.w">
            {(f) => (
              <Segmented
                label="Between panes"
                options={WIDTHS}
                value={String(f.state.value)}
                onChange={(v) => {
                  f.handleChange(widthOf(v))
                }}
              />
            )}
          </form.Field>
        </Setting>
        <Setting label="Between sections">
          <form.Field name="section.light">
            {(f) => <ColorField label="Light" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="section.dark">
            {(f) => <ColorField label="Dark" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="section.w">
            {(f) => (
              <Segmented
                label="Between sections"
                options={WIDTHS}
                value={String(f.state.value)}
                onChange={(v) => {
                  f.handleChange(widthOf(v))
                }}
              />
            )}
          </form.Field>
        </Setting>
        <Setting label="Between rows">
          <form.Field name="line2.light">
            {(f) => <ColorField label="Light" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="line2.dark">
            {(f) => <ColorField label="Dark" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <form.Field name="line2.w">
            {(f) => (
              <Segmented
                label="Between rows"
                options={WIDTHS}
                value={String(f.state.value)}
                onChange={(v) => {
                  f.handleChange(widthOf(v))
                }}
              />
            )}
          </form.Field>
        </Setting>
      </Group>
      <Group label="Colors">
        <Setting label="Go">
          <form.Field name="go">
            {(f) => <ColorField label="Go" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <Button look="go">Send</Button>
        </Setting>
        <Setting label="Needs you">
          <form.Field name="needs">
            {(f) => (
              <ColorField label="Needs you" value={f.state.value} onChange={f.handleChange} />
            )}
          </form.Field>
        </Setting>
        <Setting label="Running">
          <form.Field name="running">
            {(f) => <ColorField label="Running" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
        </Setting>
        <Setting label="Danger">
          <form.Field name="danger">
            {(f) => <ColorField label="Danger" value={f.state.value} onChange={f.handleChange} />}
          </form.Field>
          <Button look="danger">Stop</Button>
        </Setting>
        <Setting label="Neutral">
          <Button look="key">Reply</Button>
        </Setting>
        <Setting label="Text">
          <span className="trim text-ui text-ink">Read</span>
          <span className="trim text-ui text-ink2">Supporting</span>
          <span className="trim text-caption tabular-nums text-ink3">12:23</span>
        </Setting>
      </Group>
      <Group label="Size">
        <form.Field name="size">
          {(f) => (
            <Setting label="Text size">
              <Segmented
                label="Text size"
                options={[
                  { value: "small", label: "Small" },
                  { value: "default", label: "Default" },
                  { value: "large", label: "Large" },
                ]}
                value={f.state.value}
                onChange={(v) => {
                  f.handleChange(v === "small" || v === "large" ? v : "default")
                }}
              />
            </Setting>
          )}
        </form.Field>
      </Group>
    </PaneScroll>
  )
}

export const ThemeSection = () => {
  const outside = useOutside()
  const set = useSetTheme()
  const theme = useTheme()
  // A preset, or a change from elsewhere, starts the form again from the theme.
  const [picked, setPicked] = useState(0)
  return (
    <Form
      key={`${outside}:${picked}`}
      start={theme}
      onPreset={(t) => {
        set(t)
        setPicked((n) => n + 1)
      }}
    />
  )
}
