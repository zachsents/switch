// A glyph, 14 px as the house's marks and step icons are, in the ink around it: a path on its box
// (Phosphor's 256, an A2UI `svgPath`'s 24).
export const Glyph = ({ d, box = 256 }: { d: string; box?: number }) => (
  <svg width="14" height="14" viewBox={`0 0 ${box} ${box}`} aria-hidden className="block flex-none">
    <path d={d} fill="currentColor" />
  </svg>
)
