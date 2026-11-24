// `switch event <name> [json]`: a script's event, recorded by the core in the space and work that
// set the script (scripts.ts), through the credential its host gave it.
const core = process.env.SWITCH_URL ?? process.env.SWITCH_CORE ?? "http://127.0.0.1:4871"

const dataOf = (given: string | undefined): { readonly data?: unknown } | Error => {
  if (given === undefined) {
    return {}
  }
  try {
    const data: unknown = JSON.parse(given)
    return { data }
  } catch {
    return new Error(`Not JSON: ${given}`)
  }
}

export const event = async (args: readonly string[]) => {
  const [name, given] = args
  const token = process.env.SWITCH_TOKEN ?? ""
  const data = dataOf(given)
  if (name === undefined || name === "") {
    process.stderr.write("switch event <name> [json]\n")
    process.exitCode = 2
    return
  }
  if (data instanceof Error) {
    process.stderr.write(`switch event: ${data.message}\n`)
    process.exitCode = 2
    return
  }
  const res = await fetch(new URL("/events", core), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, ...data }),
  }).catch((error: unknown) => new Error(String(error)))
  if (res instanceof Error) {
    process.stderr.write(`switch event: can't reach the core at ${core}\n`)
    process.exitCode = 1
    return
  }
  if (!res.ok) {
    process.stderr.write(`switch event: ${await res.text()}\n`)
    process.exitCode = 1
  }
}
