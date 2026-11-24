// The models an account offers (T3 Code's models section): how many, Find past eight, a line each,
// in a list that stops at sixteen lines and scrolls.
import { useForm, useSelector } from "@tanstack/react-form"

export const ProviderModels = ({ models }: { models: readonly string[] }) => {
  const form = useForm({ defaultValues: { find: "" } })
  const find = useSelector(form.store, (s) => s.values.find.trim().toLowerCase())
  const shown = find === "" ? models : models.filter((m) => m.toLowerCase().includes(find))
  return (
    <section className="flex flex-col">
      <h4 className="m-0 flex h-line items-center gap-2 px-inset text-ui font-semibold text-ink line-2-b">
        <span className="trim">Models</span>
        <span className="trim ml-auto text-caption font-normal tabular-nums text-ink3">
          {models.length}
        </span>
      </h4>
      {models.length > 8 && (
        <form.Field name="find">
          {(field) => (
            <div className="flex h-9 items-center px-inset line-2-b">
              <input
                aria-label="Find a model"
                placeholder="Find…"
                spellCheck={false}
                autoComplete="off"
                className="w-full border-0 bg-transparent p-0 text-ui text-ink outline-none select-text"
                value={field.state.value}
                onChange={(e) => {
                  field.handleChange(e.target.value)
                }}
                onBlur={field.handleBlur}
              />
            </div>
          )}
        </form.Field>
      )}
      <ul className="m-0 flex max-h-96 list-none flex-col overflow-y-auto p-0">
        {shown.map((m) => (
          <li
            key={m}
            className="flex h-line flex-none items-center px-inset text-ui text-ink line-2-b"
          >
            <span className="trim min-w-0 truncate selectable">{m}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
