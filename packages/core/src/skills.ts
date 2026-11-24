// The agent's skills, in Claude Code's format (a SKILL.md each: frontmatter `name` and
// `description`, then the body), built into the core. Every turn's system prompt lists them by
// description; `skills_read` gives one's body when the work calls for it.
import { defineApp, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"

import extensions from "../skills/extensions/SKILL.md" with { type: "text" }
import change from "../skills/switch/SKILL.md" with { type: "text" }

interface Skill {
  readonly name: string
  readonly description: string
  readonly body: string
}

const FRONT = /^---\n(?<head>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u

const parse = (file: string): Skill => {
  const m = FRONT.exec(file)
  const head = m?.groups?.head ?? ""
  const field = (key: string) =>
    head
      .split("\n")
      .find((l) => l.startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim() ?? ""
  return {
    name: field("name"),
    description: field("description"),
    body: (m?.groups?.body ?? file).trim(),
  }
}

const SKILLS = [extensions, change].map(parse)

/** For the system prompt: each skill by its description. */
export const skillsLine = `Skills: read one with skills_read before work it covers.\n${SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`

export const skillsApp = defineApp({
  name: "skills",
  version: "1",
  instructions: "How to do what Switch's agent does rarely but must do right.",
  tools: [
    tool(
      "read",
      {
        description: `A skill's instructions: ${SKILLS.map((s) => s.name).join(", ")}.`,
        readOnly: true,
        input: Schema.Struct({ name: Schema.String }),
      },
      (input) => {
        const skill = SKILLS.find((s) => s.name === input.name)
        return skill ? Effect.succeed(skill.body) : Effect.fail(new Error(`No skill ${input.name}`))
      },
    ),
  ],
})
