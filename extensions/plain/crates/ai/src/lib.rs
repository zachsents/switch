//! AI for the suite's apps: finding the user's API keys, quick decisions by a fast model, and
//! transcription, all through Vercel's AI Gateway. No UI. Calls block, so run them off the main thread.

pub mod decide;
pub mod gateway;
pub mod keys;
mod shell;

pub use decide::{DECISION_MODEL, decide};
pub use gateway::{Phrase, Transcription, TranscriptionRequest, Word, transcribe};
pub use keys::{Key, Provider, Source};
