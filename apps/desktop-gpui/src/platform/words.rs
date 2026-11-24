//! What's in a field: its text and which stretches of it were dictated, kept through every edit, so
//! the message says which words may be misheard (`dictated` beside `text`). What they type over or
//! add counts as typed, so a name they fixed by hand is their own. (The desktop's
//! `mainview/dictation/words.ts`.) Places are UTF-8 byte offsets on character boundaries, as the
//! text field's; a message's record counts code points, as every other client does.

use serde_json::{Value, json};

/// A dictated stretch: `start` to `end` in the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// In order, the ones that overlap or touch made one, empty ones dropped.
fn merged(spans: impl IntoIterator<Item = Span>) -> Vec<Span> {
    let mut sorted: Vec<Span> = spans.into_iter().filter(|s| s.end > s.start).collect();
    sorted.sort_by_key(|s| s.start);
    let mut out: Vec<Span> = vec![];
    for s in sorted {
        match out.last_mut() {
            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Where `before` and `after` differ, as one change: where it starts, and how much it took out and
/// put in there. `cursor`, the caret in `after`, settles where a change among repeated characters
/// was: typing leaves what follows the caret as it was.
fn change(before: &str, after: &str, cursor: Option<usize>) -> (usize, usize, usize) {
    let (b, a) = (before.as_bytes(), after.as_bytes());
    let shorter = b.len().min(a.len());
    let prefix = |limit: usize| {
        let mut same = 0;
        while same < limit && b[same] == a[same] {
            same += 1;
        }
        floor_boundary(after, same)
    };
    let suffix = |limit: usize| {
        let mut same = 0;
        while same < limit && b[b.len() - 1 - same] == a[a.len() - 1 - same] {
            same += 1;
        }
        // Back to where a character starts in both.
        while same > 0 && !(after.is_char_boundary(a.len() - same) && before.is_char_boundary(b.len() - same)) {
            same -= 1;
        }
        same
    };
    let (head, tail) = match cursor.filter(|c| *c <= a.len()) {
        Some(c) => {
            let tail = suffix((a.len() - c).min(shorter));
            (prefix(shorter - tail), tail)
        }
        None => {
            let head = prefix(shorter);
            (head, suffix(shorter - head))
        }
    };
    (head, b.len() - head - tail, a.len() - head - tail)
}

/// Follows an edit from `before` to `after`: what it took out loses its mark, what it put in is typed.
pub fn edit(spans: &[Span], before: &str, after: &str, cursor: Option<usize>) -> Vec<Span> {
    if before == after || spans.is_empty() {
        return spans.to_vec();
    }
    let (start, removed, inserted) = change(before, after, cursor);
    let end = start + removed;
    let moved = |at: usize| at + inserted - removed;
    merged(spans.iter().flat_map(|s| {
        [Span { start: s.start, end: s.end.min(start) }, Span { start: moved(s.start.max(end)), end: moved(s.end.max(end)) }]
    }))
}

/// Spans as a draft keeps them, in UTF-16 units as the desktop's textarea counts (and an
/// Electrobun draft carried over has them).
pub fn to_utf16(text: &str, spans: &[Span]) -> Vec<Span> {
    let at = |i: usize| text[..floor_boundary(text, i.min(text.len()))].encode_utf16().count();
    spans.iter().map(|s| Span { start: at(s.start), end: at(s.end) }).collect()
}

/// A draft's spans (UTF-16 units) as places in `text`, on character boundaries.
pub fn from_utf16(text: &str, spans: &[Span]) -> Vec<Span> {
    let at = |units: usize| {
        let mut n = 0;
        for (i, c) in text.char_indices() {
            if n >= units {
                return i;
            }
            n += c.len_utf16();
        }
        text.len()
    };
    merged(spans.iter().map(|s| Span { start: at(s.start), end: at(s.end) }))
}

/// Marks `span` dictated.
pub fn add(spans: &[Span], span: Span) -> Vec<Span> {
    merged(spans.iter().copied().chain([span]))
}

/// The text to send, trimmed, and its stretches as they fall in what's left, as a message has them:
/// `dictated`, `[{ start, text }]` with `start` in code points, or None when there are none.
pub fn said(text: &str, spans: &[Span]) -> (String, Option<Value>) {
    let lead = text.len() - text.trim_start().len();
    let kept = text.trim();
    let end = lead + kept.len();
    let mut dictated = vec![];
    for s in spans {
        let (from, to) = (s.start.max(lead), s.end.min(end));
        if to <= from {
            continue;
        }
        let words = &text[from..to];
        let trimmed = words.trim();
        if trimmed.is_empty() {
            continue;
        }
        let at = from - lead + (words.len() - words.trim_start().len());
        dictated.push(json!({ "start": kept[..at].chars().count(), "text": trimmed }));
    }
    (kept.to_string(), (!dictated.is_empty()).then(|| Value::Array(dictated)))
}

/// `words` carrying on a sentence. The recognizer capitalizes what it hears as if it started one, so
/// a first word capitalized only for that goes lowercase, while "I" and names in capitals like
/// "NASA" stay.
fn carry_on(words: &str) -> String {
    let word = words.split(|c: char| c.is_whitespace() || ",.?!;:)".contains(c)).next().unwrap_or_default();
    let mut chars = words.chars();
    let Some(first) = chars.next() else { return String::new() };
    let rest_of_word: String = word.chars().skip(1).collect();
    let for_a_sentence = first.to_lowercase().to_string() != first.to_string() && rest_of_word == rest_of_word.to_lowercase();
    if !for_a_sentence || word == "I" || word.starts_with("I'") || word.starts_with("I\u{2019}") {
        return words.to_string();
    }
    format!("{}{}", first.to_lowercase(), chars.as_str())
}

/// What goes after `text` for dictated `words`, spaced from it and carrying on any sentence it ends
/// in, and where the words sit then; None when nothing was said. Words go after the text, never over
/// it, so several dictations build one message.
pub fn insertion(text: &str, words: &str) -> Option<(String, Span)> {
    let heard = words.trim();
    if heard.is_empty() {
        return None;
    }
    let lead = if text.chars().last().is_some_and(|c| !c.is_whitespace()) { " " } else { "" };
    let open = text.trim_end_matches([' ', '\t']).chars().last().is_some_and(|c| !".!?\n".contains(c));
    let put = if open { carry_on(heard) } else { heard.to_string() };
    let start = text.len() + lead.len();
    let end = start + put.len();
    Some((format!("{lead}{put}"), Span { start, end }))
}
