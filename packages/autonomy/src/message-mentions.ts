import type { Space } from "@switch/brain"

/** A chat's cross-space reference belongs to its words, never its harness or surrounding context. */
export const messageReferences = (text: string, space: Pick<Space, "id" | "name">) =>
  [space.id, space.name].some(
    (name) =>
      name !== "" &&
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${RegExp.escape(name)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(
        text,
      ),
  )
