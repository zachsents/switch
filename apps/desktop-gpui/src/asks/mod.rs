//! Asks (the desktop's `ask-*.tsx`, `chat-asks.ts`, `item-window.tsx`): the card, in a chat where it
//! was raised and in a window of its own; answering it (choices, a typed answer, approving drafts as
//! edited, a sealed secret, a reply); closed asks as a mark and what came of them; and an ask's live
//! view (the portal).

pub mod card;
pub mod chat;
mod files;
mod portal;
pub mod terminal;
pub mod window;
