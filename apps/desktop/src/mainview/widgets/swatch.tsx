// A color as a dot, hairlined so it shows on any ground, ringed when it's the one chosen. A very dark
// one carries a soft highlight, so on a black band it still reads as filled, not as an empty ring.
const dark = (color: string) => {
  if (!/^[0-9a-f]{6}$/iu.test(color)) {
    return false
  }
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(color.slice(i, i + 2), 16))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) < 40
}

export const Swatch = ({
  color,
  size = 12,
  chosen = false,
}: {
  color: string
  size?: number
  chosen?: boolean
}) => (
  <span
    className={`inline-block flex-none rounded-full border border-ink3 ${chosen ? "outline-2 outline-offset-1 outline-ink" : ""}`}
    style={{
      width: size,
      height: size,
      backgroundColor: color === "" ? "transparent" : `#${color}`,
      backgroundImage: dark(color)
        ? "radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--color-white) 55%, transparent), transparent 60%)"
        : "none",
    }}
  />
)
