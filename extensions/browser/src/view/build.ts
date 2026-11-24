// The tab view as one HTML document, its script bundled in: an MCP App view loads nothing from outside.
import path from "node:path"
import { view } from "switch-ext-kit"

const STYLE = [
  "html,body{margin:0;height:100%;background:#000;overflow:hidden;font:13px -apple-system,system-ui,sans-serif;color:#fff}",
  "img{display:block;width:100%;height:100%;object-fit:contain;cursor:pointer}",
  "#keys{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0}",
  "#none{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.6);pointer-events:none}",
].join("")

const BODY =
  '<img id="frame" alt=""><input id="keys" autocomplete="off" autocapitalize="off"><div id="none"></div>'

export const tabHtml = (app: string): string =>
  view(path.join(import.meta.dir, "tab.ts"), { style: STYLE, body: BODY }).replace(
    "<body>",
    `<body data-app="${app}">`,
  )
