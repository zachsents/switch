// Markdown imported `with { type: "text" }`: its text, built into the core.
declare module "*.md" {
  const text: string
  export default text
}

// A stylesheet imported `with { type: "text" }`, and a font `with { type: "file" }` (its path).
declare module "*.css" {
  const text: string
  export default text
}
declare module "*.woff2" {
  const path: string
  export default path
}
