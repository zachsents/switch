// The charts in the gallery (`#gallery`, dev builds): each in its states, from the messages a widget
// would send.
import { FIXTURES } from "./fixtures.ts"
import { Held } from "./held.tsx"

export const ChartsGallery = () =>
  FIXTURES.map(([name, fixtures]) => (
    <section key={name} className="flex flex-col line-1-b">
      <h2 className="m-0 flex h-line items-center px-inset text-small font-semibold text-ink2">
        <span className="trim">{name}</span>
      </h2>
      <div className="flex flex-wrap items-start gap-4 px-inset pb-4">
        {fixtures.map((f) => (
          <Held key={f.id} fixture={f} />
        ))}
      </div>
    </section>
  ))
