// Parts Switch's catalog had before A2UI's basic catalog drew them in its look, read as what replaced
// them, so a widget written for them draws as it did: Picture{src} as Image{url}, Stack as Column,
// Lines as List, Head{label} as a Markdown heading, Empty{label} as a caption.
import { BASIC_CATALOG } from "switch-ext-kit"

import { rec } from "../brain/json.ts"

/** A heading's words as Text takes them: `# ` before a label, or before what a label is bound to. */
const heading = (label: unknown) => {
  const path = rec(label)["@path"]
  if (typeof path === "string") {
    return {
      "@call": "formatString",
      catalogId: BASIC_CATALOG,
      args: { value: `# \${${path}}` },
    }
  }
  return typeof label === "string" ? `# ${label}` : label
}

export const current = (component: Record<string, unknown>): Record<string, unknown> => {
  const basic = { id: component.id, catalogId: BASIC_CATALOG }
  switch (component.component) {
    case "Picture": {
      return { ...basic, component: "Image", url: component.src }
    }
    case "Stack": {
      return { ...basic, component: "Column", children: component.children }
    }
    case "Lines": {
      return { ...basic, component: "List", children: component.children }
    }
    case "Head": {
      return { ...basic, component: "Text", text: heading(component.label) }
    }
    case "Empty": {
      return { ...basic, component: "Text", text: component.label, variant: "caption" }
    }
    default: {
      return component
    }
  }
}
