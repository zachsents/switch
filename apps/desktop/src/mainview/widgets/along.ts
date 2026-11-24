// How far in what's playing is (widgets/playing.tsx).

/** How far in, 0 to 1: `at` as of `asOf`, run on to `now` while it plays. */
export const along = (p: {
  at?: number | undefined
  length?: number | undefined
  asOf?: number | undefined
  playing: boolean
  now: number
}) => {
  if (p.at === undefined || p.length === undefined || p.length <= 0) {
    return null
  }
  const ran = p.playing && p.asOf !== undefined ? Math.max(0, p.now - p.asOf) : 0
  return Math.min(1, Math.max(0, (p.at + ran) / p.length))
}
