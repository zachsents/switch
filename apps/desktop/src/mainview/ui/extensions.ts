// Extensions as the client changes them: installing from a git URL or package name, updating and
// removing, as mutations on the core's extensions tools. What's installed comes by sync.
import { mutationOptions } from "@tanstack/react-query"

import { callChecked } from "../widgets/call.ts"

export const installMutation = mutationOptions({
  mutationKey: ["extensions", "install"],
  mutationFn: async (source: string) => {
    await callChecked("extensions", "install", { source })
  },
})

export const updateMutation = mutationOptions({
  mutationKey: ["extensions", "update"],
  mutationFn: async (extension: string) => {
    await callChecked("extensions", "update", { extension })
  },
})

export const removeMutation = mutationOptions({
  mutationKey: ["extensions", "remove"],
  mutationFn: async (extension: string) => {
    await callChecked("extensions", "remove", { extension })
  },
})
