// The band's ‹ ›: back and forward through where the window has been, quiet until there's somewhere
// to go.
import { NO_DRAG } from "./kit/window.ts"
import { Button } from "./kit/button.tsx"
import { goBack, goForward, useHistory } from "./nav.ts"
import { Tip } from "./parts.tsx"

const Arrow = ({ d }: { d: string }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="block">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const Step = ({
  label,
  keys,
  can,
  onClick,
  d,
}: {
  label: string
  keys: string
  can: boolean
  onClick: () => void
  d: string
}) => (
  <Tip label={`${label} ${keys}`}>
    <Button
      look="plate"
      aria-label={label}
      disabled={!can}
      onClick={onClick}
      className={`${NO_DRAG} w-6 px-0!`}
    >
      <Arrow d={d} />
    </Button>
  </Tip>
)

export const HistoryKeys = () => {
  const h = useHistory()
  return (
    <span className="mr-2 flex items-center">
      <Step label="Back" keys="⌘[" can={h.back} onClick={goBack} d="M7.5 2.5 4 6l3.5 3.5" />
      <Step
        label="Forward"
        keys="⌘]"
        can={h.forward}
        onClick={goForward}
        d="M4.5 2.5 8 6l-3.5 3.5"
      />
    </span>
  )
}
