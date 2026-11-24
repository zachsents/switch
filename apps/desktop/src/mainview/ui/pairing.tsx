// The window while this app waits to be paired: the code to approve on another desktop.
import { Section } from "./parts.tsx"

const DRAG = "electrobun-webkit-app-region-drag"

export const Pairing = ({ code }: { code: string }) => (
  <div className="flex h-full flex-col bg-bg">
    <div className={`${DRAG} h-band flex-none bg-bg line-1-b`} />
    <main className="min-h-0 flex-1 bg-bg">
      <Section label="Pair">
        <li className="flex h-board items-center justify-center line-2-b">
          <span className="font-mono text-title tracking-[0.12em] text-ink select-all">{code}</span>
        </li>
      </Section>
    </main>
  </div>
)
