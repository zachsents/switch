// Devices: the Macs and iPhones paired with the brain, pairing by QR, revoking.
import { DevicesSection } from "../devices-section.tsx"
import { PaneScroll } from "../pane-scroll.tsx"

export const Devices = () => (
  <PaneScroll className="flex-1">
    <DevicesSection />
  </PaneScroll>
)
