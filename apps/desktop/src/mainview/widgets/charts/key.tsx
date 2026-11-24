// A series' key beside its name, mirroring its mark: a square for bars, areas and slices, a short
// line for lines, a dot for points. The color is on the key, never on the words.

export type KeyKind = "square" | "line" | "dot"

export const Key = ({ kind, color }: { kind: KeyKind; color: string }) => {
  if (kind === "line") {
    return (
      <svg aria-hidden width={12} height={10} className="flex-none">
        <rect y={4} width={12} height={2} rx={1} fill={color} />
      </svg>
    )
  }
  if (kind === "dot") {
    return (
      <svg aria-hidden width={8} height={10} className="flex-none">
        <circle cx={4} cy={5} r={4} fill={color} />
      </svg>
    )
  }
  return (
    <svg aria-hidden width={10} height={10} className="flex-none">
      <rect width={10} height={10} rx={2} fill={color} />
    </svg>
  )
}
