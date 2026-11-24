// The marks every screen shares (SIS rev D), on Aicher's 16-unit grid. No two states share a mark:
// needs you is a yellow hand, live an orange runner, unexpected a red triangle, stopped a red
// octagon, loading grey spokes. A space's ring is a station on its line: its letter over its
// number, in its ink.
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

/** A reply not yet read: a small ink dot after the name. */
export const Unread = () => (
  <span aria-hidden className="block size-[7px] flex-none rounded-full bg-ink" />
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
        stroke="var(--color-white)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    )}
  </Svg>
)

/** Not delivered: iMessage's red circle with "!", by a message whose answering turn failed. */
export const NotDelivered = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="8" cy="8" r="7" fill="var(--color-red)" />
    <path
      d="M8 4.2 V8.9"
      fill="none"
      stroke="var(--color-white)"
      strokeWidth="1.75"
      strokeLinecap="round"
    />
    <circle cx="8" cy="11.5" r="1" fill="var(--color-white)" />
  </Svg>
)

const Stroke = ({ size, d }: { size: number; d: string }) => (
  <Svg size={size}>
    <path
      d={d}
      fill="none"
      stroke="var(--color-ink2)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
)

/** An ask approved, done or answered: a tick. */
export const Tick = ({ size = 14 }: { size?: number }) => (
  <Stroke size={size} d="M3 8.6 L6.4 12 L13 4.6" />
)

/** An ask's words sent: a paper plane. */
export const Sent = ({ size = 14 }: { size?: number }) => (
  <Stroke size={size} d="M14 2 L1.8 7.3 L6.9 9.1 Z M14 2 L8.7 14.2 L6.9 9.1" />
)

/** An ask declined: a cross. */
export const Declined = ({ size = 14 }: { size?: number }) => (
  <Stroke size={size} d="M4 4 L12 12 M12 4 L4 12" />
)

/** An ask waved off: a dash. */
export const Dismissed = ({ size = 14 }: { size?: number }) => (
  <Stroke size={size} d="M3.5 8 H12.5" />
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
          stroke="var(--color-white)"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.85" r="1" fill="var(--color-white)" />
      </>
    )}
  </Svg>
)

// The run cycle, a leg's pose at each step: the thigh's swing from straight down (forward is
// positive) and how far the knee folds the shin back, in degrees. Kept in step with marks.rs.
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
          <path key={`gap${path}`} d={path} {...limb} stroke="var(--color-bg)" strokeWidth={3} />
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
    style={{ width: size, height: size, "--color-bg": paper } as CSSProperties}
  >
    <span className="block origin-top-left" style={{ scale: `${size / 16}` }}>
      <Strip />
    </span>
  </span>
)

/** Done: the runner at rest, one pose, in grey. A finished turn's quiet mark. */
export const Rested = ({ size = 14 }: { size?: number }) => {
  const [, p] = POSES
  return (
    <span className="block flex-none text-ink3" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="block">
        {p && (
          <>
            {[...p.far, p.torso, ...p.near].map((path) => (
              <path key={path} d={path} {...limb} stroke="currentColor" strokeWidth={1.6} />
            ))}
            <circle cx={p.head[0]} cy={p.head[1]} r={1.6} fill="currentColor" />
          </>
        )}
      </svg>
    </span>
  )
}

/** Loading, or a press under way: eight grey spokes, stepping round. Never the runner, which is
 *  only for work that runs. */
export const Spin = ({ size = 12, ink = "text-ink3" }: { size?: number; ink?: string }) => (
  <span
    className={`block flex-none ${ink}`}
    style={{ width: size, height: size, animation: "spin 1s steps(8) infinite" }}
  >
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="block">
      {Array.from({ length: 8 }, (_, i) => (
        <path
          key={i}
          d="M8 1.8 V4.6"
          transform={`rotate(${i * 45} 8 8)`}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity={0.25 + (0.75 * i) / 7}
        />
      ))}
    </svg>
  </span>
)

/** A space's ring, `size` across: its code in its ink; Home's holds a house. */
export const Ring = ({
  code,
  ink,
  size = 18,
  fill = "var(--color-bg)",
  type = "var(--color-ink)",
  home = false,
}: {
  code: string
  ink: string
  size?: number
  fill?: string
  type?: string
  home?: boolean
}) => {
  const split = code.search(/\d/u)
  const letter = split === -1 ? code : code.slice(0, split)
  const number = split === -1 ? "" : code.slice(split)
  const wide = letter.length > 1
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="block flex-none">
      <circle cx="8" cy="8" r="6.85" fill={fill} stroke={ink} strokeWidth="2.3" />
      {home && (
        <g
          transform="translate(3 3) scale(0.625)"
          fill="none"
          stroke={ink}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.6 7.6 L8 2.9 L13.4 7.6" />
          <path d="M4.4 6.3 V13.1 H11.6 V6.3" />
          <path d="M6.6 13.1 V9.6 H9.4 V13.1" />
        </g>
      )}
      <g fill={type} fontFamily="var(--font-sans)" fontWeight="700" textAnchor="middle">
        {letter !== "" && number === "" && (
          <text x="8" y="8.15" dy="0.36em" fontSize={wide ? 5.6 : 7.4}>
            {letter}
          </text>
        )}
        {letter !== "" && number !== "" && (
          <>
            <text x="8" y="5.75" dy="0.36em" fontSize={wide ? 3.7 : 4.3}>
              {letter}
            </text>
            <text x="8" y="10.35" dy="0.36em" fontSize="5.3">
              {number}
            </text>
          </>
        )}
      </g>
    </svg>
  )
}
