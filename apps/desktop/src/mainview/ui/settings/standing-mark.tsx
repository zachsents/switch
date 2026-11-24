// How an account stands, as a mark (needs you, stopped, not as expected), its words under the pointer.
import { Hand, Stop, Warn } from "../marks.tsx"
import { Tip } from "../parts.tsx"
import type { Standing } from "./accounts.ts"

const Glyph = ({ mark }: { mark: NonNullable<Standing["mark"]> }) => {
  switch (mark) {
    case "hand": {
      return <Hand size={12} />
    }
    case "stop": {
      return <Stop size={12} />
    }
    case "warn": {
      return <Warn size={12} />
    }
    default: {
      return mark satisfies never
    }
  }
}

export const StandingMark = ({ standing }: { standing: Standing }) =>
  standing.mark !== null && (
    <Tip label={standing.words}>
      <span className="flex flex-none">
        <Glyph mark={standing.mark} />
      </span>
    </Tip>
  )
