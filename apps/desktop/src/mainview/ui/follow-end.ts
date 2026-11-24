// Each mounted conversation's way back to its end, by conversation: the user sent something there.

const followers = new Map<string, () => void>()

/** Registers a column's way back to its end; returns its removal. */
export const onFollow = (conversation: string, toEnd: () => void) => {
  followers.set(conversation, toEnd)
  return () => {
    if (followers.get(conversation) === toEnd) {
      followers.delete(conversation)
    }
  }
}

/** Back to a conversation's end, following it again. */
export const followScroll = (conversation: string) => {
  followers.get(conversation)?.()
}
