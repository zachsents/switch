//! A streaming reply's words at an even pace (the desktop's `ui/smooth.ts`, markstream-core's
//! controller): tokens land in bursts, and each frame spends the backlog, faster the further behind
//! it is, so the text flows instead of jumping; a cut falls between words. What was there when it
//! started, and text that never streamed, shows at once. When a reply's final text replaces its
//! draft, what's already shown stays and only the rest is paced.

use std::time::Instant;

const MIN_CPS: f32 = 60.;
const MAX_CPS: f32 = 3000.;
/// About two bursts behind: enough to even them out, close enough to feel live.
const TARGET_LATENCY: f32 = 0.3;
const CATCH_UP_LATENCY: f32 = 0.15;
const CATCH_UP_THRESHOLD: usize = 400;
const MAX_PER_COMMIT: usize = 120;

pub struct Pacer {
    /// The text it was last given, and how much of it shows.
    source: String,
    visible: usize,
    last: Instant,
    /// Fractional characters owed from the last frame.
    owed: f32,
}

/// How many leading bytes `a` and `b` share, on a character boundary.
fn shared(a: &str, b: &str) -> usize {
    a.char_indices().zip(b.chars()).take_while(|((_, x), y)| x == y).last().map(|((i, c), _)| i + c.len_utf8()).unwrap_or(0)
}

impl Pacer {
    /// A pacer with `shown` already on screen; a short start of a live reply is paced from its
    /// first word.
    pub fn new(text: &str, live: bool) -> Self {
        let start = if live && text.len() <= MAX_PER_COMMIT { 0 } else { text.len() };
        Pacer { source: text.to_string(), visible: start, last: Instant::now(), owed: 0. }
    }

    /// Takes the text as it stands now: rewritten while it streams (the gate's trimmed reply), what
    /// on screen still stands stays.
    pub fn take(&mut self, text: &str, live: bool) {
        if text.starts_with(&self.source) {
            self.source = text.to_string();
            return;
        }
        let shown = self.source[..self.visible].to_string();
        let lead = text.len() - text.trim_start().len();
        self.visible = if live { lead + shared(&text[lead..], shown.trim_start()) } else { text.len() };
        self.source = text.to_string();
    }

    /// One frame's worth; answers whether more is still to come.
    pub fn tick(&mut self) -> bool {
        // With Reduce motion on, words show as they come, unpaced.
        if reduce_motion() {
            self.visible = self.source.len();
            return false;
        }
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32().min(0.1);
        self.last = now;
        let backlog = self.source.len() - self.visible;
        if backlog == 0 {
            return false;
        }
        let latency = if backlog > CATCH_UP_THRESHOLD { CATCH_UP_LATENCY } else { TARGET_LATENCY };
        let cps = (backlog as f32 / latency).clamp(MIN_CPS, MAX_CPS);
        self.owed += cps * dt;
        let mut n = (self.owed as usize).min(MAX_PER_COMMIT);
        self.owed -= n as f32;
        let mut at = self.visible;
        while n > 0 && at < self.source.len() {
            at += self.source[at..].chars().next().map(char::len_utf8).unwrap_or(1);
            n -= 1;
        }
        self.visible = at;
        self.visible < self.source.len()
    }

    /// What to show now: back to the last whole word, unless the cut falls between words.
    pub fn shown(&self) -> &str {
        let visible = &self.source[..self.visible];
        if self.visible == self.source.len() || self.source[self.visible..].starts_with(char::is_whitespace) {
            return visible;
        }
        let cut = visible.trim_end_matches(|c: char| !c.is_whitespace());
        cut
    }

    pub fn coming(&self) -> bool {
        self.visible < self.source.len()
    }
}

/// The Mac's Reduce motion (Accessibility ▸ Display), as `prefers-reduced-motion` reads it.
fn reduce_motion() -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

