// Switch's marks (SIS rev D), on Aicher's 16-unit grid, as its desktop draws them. No two states
// share a mark: needs you is a yellow hand, live an orange runner, unexpected a red triangle,
// stopped a red octagon.
import type { CSSProperties, ReactNode } from "react"

const Svg = ({ size, children }: { size: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="block flex-none">
    {children}
  </svg>
)

/** Needs you: a raised right hand, palm out. Never a warning sign. */
export const Hand = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <g fill="none" stroke="var(--color-yellow)" strokeLinecap="round" strokeWidth="1.9">
      <path d="M4.75 4.4 V9" />
      <path d="M7.35 2.7 V9" />
      <path d="M9.95 2.95 V9" />
      <path d="M12.45 4.7 V9" />
      <path d="M5.1 11.1 L2.55 8.35" strokeWidth="2.1" />
    </g>
    <path
      d="M3.8 8 H13.4 V10.6 C13.4 13.1 11.6 14.9 9.1 14.9 H8.2 C5.7 14.9 3.8 13.1 3.8 10.6 Z"
      fill="var(--color-yellow)"
    />
  </Svg>
)

/** Didn't finish, or can't: a red octagon. */
export const Stop = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path
      d="M14.42 10.66 L10.66 14.42 L5.34 14.42 L1.58 10.66 L1.58 5.34 L5.34 1.58 L10.66 1.58 L14.42 5.34 Z"
      fill="var(--color-red)"
      stroke="var(--color-red)"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
    {size > 10 && (
      <path
        d="M5.1 8 H10.9"
        fill="none"
        stroke="var(--color-on-lamp)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    )}
  </Svg>
)

/** Didn't go as expected: a red triangle. */
export const Warn = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path
      d="M8 1.9 L14.6 13.9 H1.4 Z"
      fill="var(--color-red)"
      stroke="var(--color-red)"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    {size > 10 && (
      <>
        <path
          d="M8 6.1 V9.6"
          fill="none"
          stroke="var(--color-on-lamp)"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.85" r="1" fill="var(--color-on-lamp)" />
      </>
    )}
  </Svg>
)

// The run cycle, a leg's pose at each step: the thigh's swing from straight down (forward is
// positive) and how far the knee folds the shin back, in degrees.
const THIGH = [30, 4, -26, -40, -10, 30, 52, 44]
const KNEE = [16, 40, 20, 95, 122, 100, 62, 26]
const BOUNCE = [0, 0.45, 0.15, -0.35, 0, 0.45, 0.15, -0.35]
const STEPS = 8

type Point = readonly [number, number]

const at = ([x, y]: Point, degrees: number, length: number): Point => {
  const a = (degrees * Math.PI) / 180
  return [x + length * Math.sin(a), y + length * Math.cos(a)]
}

const d = (points: readonly Point[]) =>
  `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L")}`

const pose = (step: number) => {
  const hip: Point = [7.2, 8.4 + (BOUNCE[step] ?? 0)]
  const shoulder = at(hip, 166, 3.9)
  const head = at(shoulder, 158, 2.45)
  const leg = (k: number) => {
    const thigh = THIGH[k] ?? 0
    const knee = at(hip, thigh, 3.1)
    return [hip, knee, at(knee, thigh - (KNEE[k] ?? 0), 3.2)]
  }
  const arm = (k: number) => {
    const swing = 4 - 1.2 * (THIGH[k] ?? 0)
    const elbow = at(shoulder, swing, 2.6)
    return [shoulder, elbow, at(elbow, swing + 88, 2.2)]
  }
  const other = (step + STEPS / 2) % STEPS
  return {
    near: [leg(step), arm(other)].map(d),
    far: [leg(other), arm(step)].map(d),
    torso: d([shoulder, hip]),
    head,
  }
}

const POSES = Array.from({ length: STEPS }, (_, i) => pose(i))

const limb = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const

/** The runner's eight poses side by side; the mark shows one at a time. */
const Strip = () => (
  <svg
    width={16 * STEPS}
    height={16}
    viewBox={`0 0 ${16 * STEPS} 16`}
    aria-hidden
    className="block"
    style={{ animation: "run 1s steps(8) infinite", animationDelay: "var(--run-delay)" }}
  >
    {POSES.map((p, i) => (
      <g key={i} transform={`translate(${i * 16} 0)`}>
        {/* The near limbs part the far ones by a hairline of paper. */}
        {p.near.map((path) => (
          <path key={`gap${path}`} d={path} {...limb} stroke="var(--color-paper)" strokeWidth={3} />
        ))}
        {p.far.map((path) => (
          <path key={`far${path}`} d={path} {...limb} stroke="currentColor" strokeWidth={1.9} />
        ))}
        <path d={p.torso} {...limb} stroke="currentColor" strokeWidth={1.9} />
        <circle cx={p.head[0]} cy={p.head[1]} r={1.7} fill="currentColor" />
        {p.near.map((path) => (
          <path key={`near${path}`} d={path} {...limb} stroke="currentColor" strokeWidth={1.9} />
        ))}
      </g>
    ))}
  </svg>
)

/** Every runner on one beat: the document's clock, eight poses a second. */
const beat = () => `${-(performance.now() % 1000)}ms`

/** Running: the orange runner, always running. */
export const Runner = ({ size = 14, paper }: { size?: number; paper?: string }) => (
  <span
    // Set once, as it mounts: a later delay would jump the stride.
    ref={(el) => {
      el?.style.setProperty("--run-delay", beat())
    }}
    className="block flex-none overflow-hidden text-orange"
    style={{ width: size, height: size, "--color-paper": paper } as CSSProperties}
  >
    <span className="block origin-top-left" style={{ scale: `${size / 16}` }}>
      <Strip />
    </span>
  </span>
)
