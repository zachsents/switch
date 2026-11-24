// Every component desktop's catalogs draw, the iPhone's draw too: Switch's own and its charts
// (Catalogs.swift, Charts.swift), and A2UI's basic one (Basic.swift). A name only desktop has fails.
const read = async (path: string) => await Bun.file(path).text()
const listed = (text: string, list: RegExp) =>
  list.exec(text)?.groups?.list?.match(/(?<!\.)\b[A-Z]\w+/gu) ?? []
const named = (text: string, name: RegExp) =>
  [...text.matchAll(name)].map((m) => m.groups?.name ?? "")

const desktop = "apps/desktop/src/mainview/widgets"
const iphone = "apps/iphone/Switchboard/Widgets"
const catalogList = /"1\.0",\s*\[(?<list>[^\]]*)\]/u
const switchNames = /ComponentImplementation\(\s*name: "(?<name>\w+)"/gu
const pairs = [
  {
    catalog: "Switch's",
    desktop: [
      ...listed(await read(`${desktop}/catalog.tsx`), catalogList),
      ...listed(await read(`${desktop}/charts/charts.ts`), /\[\] [=] \[(?<list>[^\]]*)\]/u),
    ],
    iphone: [
      ...named(await read(`${iphone}/Catalogs.swift`), switchNames),
      ...named(await read(`${iphone}/Charts.swift`), switchNames),
    ],
  },
  {
    catalog: "the basic",
    desktop: listed(await read(`${desktop}/basic/catalog.ts`), catalogList),
    iphone: named(await read(`${iphone}/Basic.swift`), /"(?<name>\w+)": \{ AnyView/gu),
  },
]

for (const p of pairs) {
  const missing = p.desktop.filter((n) => !p.iphone.includes(n))
  if (p.desktop.length === 0 || missing.length > 0) {
    console.error(
      `The iPhone's ${p.catalog} catalog lacks ${missing.join(", ") || "desktop's (none read)"}`,
    )
    process.exitCode = 1
  }
}
