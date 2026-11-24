// The viewer's page (@switch/portal's view.ts) as one HTML document, built when the core is: a Bun
// macro (portal.ts imports it so), since the compiled core carries no sources to build from.
import path from "node:path"
import { view } from "switch-ext-kit"

const STYLE = [
  "html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}",
  "#stage{position:fixed;inset:0;cursor:default}",
  "#screen{position:absolute;left:0;top:0;transform-origin:0 0;image-rendering:auto}",
  "#keys{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;font-size:16px}",
  "#bar{position:fixed;left:0;right:0;bottom:0;display:flex;background:#000;border-top:1px solid rgba(255,255,255,.12)}",
  "#bar[hidden]{display:none}",
  "#bar button{flex:1;height:44px;background:none;border:0;border-right:1px solid rgba(255,255,255,.12);color:#fff;font:15px -apple-system,system-ui,sans-serif}",
  "#bar button:last-child{border-right:0}",
].join("")

const BODY =
  '<div id="stage"><canvas id="screen"></canvas></div><textarea id="keys" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea><div id="bar" hidden></div>'

const HEAD =
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">'

export const viewerHtml = () =>
  view(path.join(import.meta.dir, "../../portal/src/view.ts"), {
    style: STYLE,
    body: BODY,
    head: HEAD,
  })
