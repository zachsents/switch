/** Provider failures are useful without exposing callback URLs or credential values. */
export const safeError = (error: Error) => {
  if (/^No google client$/u.test(error.message)) {
    return "Google connection is not configured on the server. Add a compatible Google OAuth client, then try Connect again."
  }
  return (
    error.message
      .replaceAll(/https?:\/\/[^\s<>"']+/giu, "[URL hidden]")
      .replaceAll(/\bBearer\s+\S+/giu, "Bearer [hidden]")
      .replaceAll(
        /\b(?<field>["']?(?:(?:access|refresh|id)[_-]?token|token|secret|client[_-]?secret|api[_-]?key|authorization|password|code)["']?)\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu,
        "$<field>=[hidden]",
      )
      .replaceAll(/[A-Za-z0-9_+/=-]{48,}/gu, "[hidden]")
      .slice(0, 400) || "The action failed. Try again or check the connection in Settings."
  )
}
