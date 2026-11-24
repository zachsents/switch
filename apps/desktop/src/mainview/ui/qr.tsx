// A QR code, drawn as one SVG path, dark on light whatever the theme so cameras read it.
import { encode } from "uqr"

export const Qr = ({ text, size = 220 }: { text: string; size?: number }) => {
  const { data, size: n } = encode(text, { border: 2 })
  const d = data
    .flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join("")
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR"
    >
      <rect width={n} height={n} fill="var(--color-white)" />
      <path d={d} fill="var(--color-black)" />
    </svg>
  )
}
