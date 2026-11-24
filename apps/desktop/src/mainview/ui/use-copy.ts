// Copying to the clipboard as a mutation: `copied` holds a moment after it lands.
import { useMutation } from "@tanstack/react-query"

const HELD_MS = 1200

export const useCopy = () => {
  const copy = useMutation({
    mutationFn: async (text: string) => {
      await navigator.clipboard.writeText(text)
    },
    onSuccess: () => {
      setTimeout(() => {
        copy.reset()
      }, HELD_MS)
    },
  })
  return { copy: copy.mutate, copied: copy.isSuccess }
}

/** Nothing selected: a click that copies needn't fight a drag that selects. */
export const nothingSelected = () => (window.getSelection()?.toString() ?? "") === ""
