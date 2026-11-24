// A color: a swatch that opens the system's color panel, and its hex. A form field's value.
import { useId, useRef } from "react"

import { Button } from "../kit/button.tsx"

export const ColorField = ({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}) => {
  const id = useId()
  const picker = useRef<HTMLInputElement>(null)
  return (
    <span className="flex items-center gap-1.5">
      <Button
        look="bare"
        aria-label={`${label} color`}
        onClick={() => {
          picker.current?.click()
        }}
        className="size-key rounded-key border border-line-1"
        style={{ background: value }}
      />
      <input
        ref={picker}
        type="color"
        tabIndex={-1}
        aria-hidden
        value={value}
        onChange={(e) => {
          onChange(e.target.value.toLowerCase())
        }}
        className="sr-only"
      />
      <label
        htmlFor={`${id}-hex`}
        className="flex h-key w-20 cursor-text items-center rounded-key px-1.5 border border-line-2"
      >
        <input
          id={`${id}-hex`}
          aria-label={label}
          defaultValue={value}
          key={value}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.trim().toLowerCase()
            if (/^#[0-9a-f]{6}$/u.test(v)) {
              onChange(v)
            }
          }}
          className="w-full border-0 bg-transparent p-0 font-mono text-data text-ink outline-none select-text"
        />
      </label>
    </span>
  )
}
