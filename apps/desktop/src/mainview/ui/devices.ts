// Credentials as the client changes them: approving or denying a pairing, revoking, and offering a
// one-time QR for an iPhone. The list itself comes by sync. Each is a mutation on the core's /auth
// routes, which check this app's own credential.
import { mutationOptions } from "@tanstack/react-query"
import { Schema } from "effect"

import { coreUrl } from "../brain/auth.ts"

const post = async (route: string, body: unknown) => {
  const res = await fetch(coreUrl(`/auth/${route}`), {
    method: "POST",
    // Plain text, so the browser sends it without asking first (no CORS preflight).
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error("Can't reach the core")
  })
  if (!res.ok) {
    const said = await res.text()
    throw new Error(said === "" ? "Didn't go through" : said)
  }
  const answer: unknown = await res.json()
  return answer
}

export const approveMutation = mutationOptions({
  mutationKey: ["auth", "approve"],
  mutationFn: async (id: string) => {
    await post("approve", { id })
  },
})

export const denyMutation = mutationOptions({
  mutationKey: ["auth", "deny"],
  mutationFn: async (id: string) => {
    await post("deny", { id })
  },
})

export const revokeMutation = mutationOptions({
  mutationKey: ["auth", "revoke"],
  mutationFn: async (id: string) => {
    await post("revoke", { id })
  },
})

const Offered = Schema.Struct({ offer: Schema.String, until: Schema.Number, core: Schema.String })
const decodeOffered = Schema.decodeUnknownSync(Offered)

/** The link an iPhone pairs by: this core's address and a one-time offer. */
export const offerMutation = mutationOptions({
  mutationKey: ["auth", "offer"],
  mutationFn: async () => {
    const { offer, until, core } = decodeOffered(await post("offer", { scopes: ["client"] }))
    const link = `switchboard://pair?core=${encodeURIComponent(core)}&offer=${encodeURIComponent(offer)}`
    return { link, until, made: Date.now() }
  },
})
