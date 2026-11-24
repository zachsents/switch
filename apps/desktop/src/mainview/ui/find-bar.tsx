// ⌘F's bar, the chat's top cell: the words, which match of how many, Enter and ⇧Enter between
// them, Esc to close.
import type { FindIn } from "./use-find-in.ts"

/** Puts the cursor back in the open find bar, its words selected. */
export const focusFind = () => {
  document.querySelector<HTMLInputElement>("[data-find]")?.select()
}

export const FindBar = ({ find, onClose }: { find: FindIn; onClose: () => void }) => (
  <div className="flex h-line flex-none items-center gap-3 line-2-b bg-bg px-inset">
    <find.form.Field name="query">
      {(field) => (
        <input
          data-find
          autoFocus
          name={field.name}
          value={field.state.value}
          onChange={(e) => {
            field.handleChange(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              find.step(e.shiftKey ? -1 : 1)
            } else if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
          placeholder="Find"
          aria-label="Find in chat"
          className="min-w-0 flex-1 border-0 bg-transparent text-ui text-ink outline-none"
        />
      )}
    </find.form.Field>
    <find.form.Subscribe selector={(f) => f.values.query.trim() !== ""}>
      {(asked) =>
        asked &&
        find.ready && (
          <span className="flex-none text-caption tabular-nums text-ink3">
            {find.count === 0 ? "None" : `${find.current}/${find.count}`}
          </span>
        )
      }
    </find.form.Subscribe>
  </div>
)
