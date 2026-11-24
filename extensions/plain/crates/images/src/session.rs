//! An image's edits since it was opened or last saved, with their history for undo and redo.

use std::time::{Duration, Instant};

use crate::edits::Edits;

/// Changes of the same kind this close together are one step to undo, like a run of arrow-key
/// nudges to a crop.
const MERGE_WITHIN: Duration = Duration::from_millis(1500);

/// What a change did, to tell which ones merge into one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Crop,
    Turn,
    Flip,
    Resize,
    AddMark,
    /// Moving, restyling or rewording a mark.
    EditMark,
    DeleteMark,
}

impl Change {
    /// Whether a run of these is one step: each replaces the last, rather than adding to it.
    fn merges(self) -> bool {
        matches!(self, Self::Crop | Self::Resize | Self::EditMark)
    }
}

/// One image's edits and their history.
#[derive(Debug, Default)]
pub struct Session {
    edits: Edits,
    undo: Vec<Edits>,
    redo: Vec<Edits>,
    /// The last change and when it was made, while it can still merge with the next.
    last: Option<(Change, Instant)>,
}

impl Session {
    pub fn edits(&self) -> &Edits {
        &self.edits
    }

    /// Whether there's anything to save.
    pub fn is_edited(&self) -> bool {
        !self.edits.is_unchanged()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Makes `edits` current. It's a new step to undo unless it continues a run of the same
    /// change made just before. Returns false when nothing changed.
    pub fn change(&mut self, change: Change, edits: Edits, now: Instant) -> bool {
        if edits == self.edits {
            return false;
        }
        let continues = self.last.is_some_and(|(last, at)| {
            last == change && change.merges() && now.duration_since(at) < MERGE_WITHIN
        });
        let previous = std::mem::replace(&mut self.edits, edits);
        if !continues {
            self.undo.push(previous);
        }
        self.redo.clear();
        self.last = Some((change, now));
        true
    }

    /// Steps back. Returns false when there's nothing to undo.
    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        self.redo.push(std::mem::replace(&mut self.edits, previous));
        self.last = None;
        true
    }

    /// Steps forward again. Returns false when there's nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.undo.push(std::mem::replace(&mut self.edits, next));
        self.last = None;
        true
    }

    /// Drops every edit, as after saving them into the file or reverting. Undo starts over.
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}
