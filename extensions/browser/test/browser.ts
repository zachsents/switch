// A headless Chrome of its own (a fresh profile in a temporary folder, never the user's) that loads a
// local fixture with the page script, runs a probe after it and answers what the probe returned.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const SCRIPT = readFileSync(path.join(import.meta.dir, "..", "src", "page.js"), "utf-8")

/** `probe`'s body runs in the fixture once it's laid out, with `__switch` installed; what it returns comes back. */
export const probe = async (fixture: string, body: string, width = 1000, height = 700) => {
  const dir = mkdtempSync(path.join(tmpdir(), "page-test-"))
  try {
    const html = readFileSync(path.join(import.meta.dir, "fixtures", fixture), "utf-8").replace(
      "</body>",
      `<script>${SCRIPT}</script><script>
        let said
        try { said = { value: (() => { ${body} })() } } catch (e) { said = { error: String(e) } }
        const out = document.createElement("pre")
        out.id = "probe"
        out.textContent = btoa(encodeURIComponent(JSON.stringify(said)))
        document.body.append(out)
      </script></body>`,
    )
    const page = path.join(dir, fixture)
    writeFileSync(page, html)
    const proc = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--window-size=${width},${height}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "--password-store=basic",
        "--dump-dom",
        `file://${page}`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    const [code, dom] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    const found = /<pre id="probe">(?<said>[^<]*)<\/pre>/u.exec(dom)?.groups?.said
    if (code !== 0 || found === undefined) {
      throw new Error(`Chrome exited ${code} without the probe's answer`)
    }
    const said: unknown = JSON.parse(decodeURIComponent(atob(found)))
    if (typeof said !== "object" || said === null) {
      throw new TypeError("The probe answered nothing")
    }
    if ("error" in said) {
      throw new Error(String(said.error))
    }
    return "value" in said ? said.value : undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
