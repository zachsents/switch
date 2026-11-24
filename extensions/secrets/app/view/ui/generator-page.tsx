// The generator on its own page: a password to copy.
import { Generator } from "./generator.tsx"
import { Section } from "./parts.tsx"

export const GeneratorPage = () => (
  <article className="min-h-full bg-paper">
    <Section label="Generator">
      <li className="list-none">
        <Generator />
      </li>
    </Section>
  </article>
)
