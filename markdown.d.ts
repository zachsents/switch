// Markdown imported `with { type: "text" }`: its text, built into the core.
declare module "*.md" {
  const text: string
  export default text
}
