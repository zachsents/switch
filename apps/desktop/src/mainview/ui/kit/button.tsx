// The one button. Every press in the app is one of these (Base UI's Button underneath), in one of a
// few looks, all instant: no transition, and hover never changes a line or the layout.
//   key    a key in its hairline, sinking a point when pressed: a choice, a secondary act
//   go     the go key: the one act that goes ahead (Send, Approve, Done, Connect)
//   danger a key in the danger color: what stops or takes away (Stop, Decline, Remove)
//   flat   bare words or a glyph, lit under the pointer (Edit, ‹ ›, ✕)
//   plate  bare, on the band
//   row    a whole list row: its full width and height are the click
//   bare   no look of its own: a picture, a link-like word, a swatch
import { Button as Base } from "@base-ui/react/button"
import type { ComponentProps } from "react"

export type Look = "key" | "go" | "danger" | "flat" | "plate" | "row" | "bare"

const LOOKS: Record<Look, string> = {
  key: "h-key rounded-key border border-key-border bg-bg px-2 text-small font-medium text-ink hover:lit active:translate-y-px data-[pressed]:translate-y-px",
  go: "h-key rounded-key border border-go-border bg-go px-2 text-small font-medium text-white hover:bg-go-press active:translate-y-px",
  danger:
    "h-key rounded-key border border-key-border bg-bg px-2 text-small font-medium text-red hover:lit active:translate-y-px",
  flat: "h-key rounded-key px-1.5 text-small font-medium text-ink2 hover:lit active:held data-[popup-open]:held data-[popup-open]:text-ink aria-pressed:text-ink",
  plate:
    "h-key rounded-key px-1.5 text-small font-medium text-ink2 hover:lit active:held data-[popup-open]:held aria-pressed:text-ink",
  bare: "",
  row: "relative h-line w-full justify-start gap-2 px-inset text-left text-ui text-ink hover:lit active:held aria-[current=page]:held",
}

const BASE =
  "outline-none select-none focus-visible:focused disabled:opacity-40 disabled:pointer-events-none"
/** Every look but bare: words and glyphs in a row, centred. */
const LAID = "inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap"

export const Button = ({
  look = "key",
  className = "",
  children,
  ...props
}: { look?: Look; className?: string } & Omit<ComponentProps<typeof Base>, "className">) => (
  <Base {...props} className={`${BASE} ${look === "bare" ? "" : LAID} ${LOOKS[look]} ${className}`}>
    {/* Words in a button sit on their capitals, so they centre optically. */}
    {typeof children === "string" ? <span className="trim">{children}</span> : children}
  </Base>
)

/** A button's classes, for a Base UI trigger that renders its own (a popover's, a menu's). */
export const buttonLook = (look: Look, className = "") =>
  `${BASE} ${look === "bare" ? "" : LAID} ${LOOKS[look]} ${className}`
