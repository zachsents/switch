// A filter over the list, as a cell of the line under the search: its name while it's off.
export const FilterSelect = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) => (
  <span className="flex min-w-0 flex-1 odd:hairline-r">
    <select
      aria-label={label}
      value={value}
      onChange={(e) => {
        onChange(e.target.value)
      }}
      className={`h-full min-w-0 flex-1 appearance-none truncate border-0 bg-transparent px-inset text-small outline-none hover:bg-wash focus-visible:bg-selection ${value === "" ? "text-ink3" : "text-ink"}`}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </span>
)
