//! Self-healing Markdown for a streaming reply: closes or drops the half-written marks at its end
//! (emphasis, code, links, math, tags) so each frame renders the way the finished text will. A
//! port of Streamdown's `remend` 1.5.0 with its default options. Like the original it works on
//! UTF-16 code units, so positions and per-character tests match it on any text.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

type Text = [u16];

/// What reading past either end of the text gives.
const NONE: u16 = 0xFFFF;

const LINK_PLACEHOLDER: &str = "](streamdown:incomplete-link)";
const IMAGE_PLACEHOLDER: &str = "](streamdown:incomplete-image)";

/// The text with its incomplete marks healed, as `remend(text)` returns it.
pub fn remend(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let text: Vec<u16> = text.encode_utf16().collect();
    let result = strip_lone_trailing_space(&text);
    let healed = if !is_trailing_escape(result) {
        run_handlers(result.to_vec())
    } else {
        // A closer after a trailing backslash would be escaped, so heal with it escaped
        let mut escaped = result.to_vec();
        escaped.push(u('\\'));
        let healed = run_handlers(escaped.clone());
        if healed == escaped { result.to_vec() } else { healed }
    };
    String::from_utf16_lossy(&healed)
}

fn run_handlers(text: Vec<u16>) -> Vec<u16> {
    let text = escape_single_tildes(&text);
    let text = escape_comparisons(&text);
    let text = strip_incomplete_html_tag(&text);
    let text = break_setext_heading(&text);
    let text = heal_links_and_images(&text);
    if ends_with(&text, &utf16(LINK_PLACEHOLDER)) || ends_with(&text, &utf16(IMAGE_PLACEHOLDER)) {
        return text;
    }
    let text = heal_emphasis_with_code(&text);
    let text = close_inline_code(&text);
    let text = close_block_math(&text);
    strip_lone_trailing_space(&text).to_vec()
}

/// A single trailing space is dropped; two are a hard line break and stay.
fn strip_lone_trailing_space(t: &Text) -> &Text {
    if ends_with(t, &[u(' ')]) && !ends_with(t, &[u(' '), u(' ')]) { &t[..t.len() - 1] } else { t }
}

/// Whether the text ends with an unescaped backslash in prose.
fn is_trailing_escape(t: &Text) -> bool {
    let Some(last) = t.len().checked_sub(1) else { return false };
    if t[last] != u('\\') || is_escaped(t, last) {
        return false;
    }
    let scan = Scan::new(t);
    scan.regions[last] == PROSE && !scan.in_math_at(last as isize, true)
}

// ---- Text helpers, with JavaScript's string semantics ----

const fn u(c: char) -> u16 {
    c as u16
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn at(t: &Text, i: usize) -> u16 {
    t.get(i).copied().unwrap_or(NONE)
}

/// The unit before `i`, or `NONE` at the start.
fn prev(t: &Text, i: usize) -> u16 {
    at(t, i.wrapping_sub(1))
}

fn is(t: &Text, i: usize, c: char) -> bool {
    at(t, i) == u(c)
}

fn is_digit(c: u16) -> bool {
    (u('0')..=u('9')).contains(&c)
}

fn is_ascii_letter(c: u16) -> bool {
    (u('a')..=u('z')).contains(&c) || (u('A')..=u('Z')).contains(&c)
}

fn is_ascii_alnum(c: u16) -> bool {
    is_ascii_letter(c) || is_digit(c)
}

/// JavaScript's `\s`, which is also what `trim` removes.
fn is_space(c: u32) -> bool {
    matches!(c, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

fn is_space_unit(c: u16) -> bool {
    is_space(c as u32)
}

/// The code point at `i` and how many units it takes.
fn code_point_at(t: &Text, i: usize) -> (u32, usize) {
    let c = t[i];
    if (0xD800..0xDC00).contains(&c) && i + 1 < t.len() && (0xDC00..0xE000).contains(&t[i + 1]) {
        (0x10000 + ((c as u32 - 0xD800) << 10) + (t[i + 1] as u32 - 0xDC00), 2)
    } else {
        (c as u32, 1)
    }
}

static CLASSES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [r"\A[\p{L}\p{N}]\z", r"\A[\p{P}\p{S}]\z", r"(?i)\A[\p{L}\p{N}_]\z"].map(|p| Regex::new(p).expect("valid class"))
});

fn in_class(class: usize, c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| CLASSES[class].is_match(c.encode_utf8(&mut [0; 4])))
}

/// `[\p{L}\p{N}]`
fn is_letter_or_number(c: u32) -> bool {
    if c < 0x80 { is_ascii_alnum(c as u16) } else { in_class(0, c) }
}

/// `[\p{P}\p{S}]`
fn is_punctuation(c: u32) -> bool {
    if c < 0x80 { (c as u8).is_ascii_punctuation() } else { in_class(1, c) }
}

/// `[\p{L}\p{N}_]` matched case-insensitively.
fn is_word_folded(c: u32) -> bool {
    if c < 0x80 { is_ascii_alnum(c as u16) || c == u32::from(u('_')) } else { in_class(2, c) }
}

/// `[a-z]` matched case-insensitively with Unicode case folding.
fn is_folded_ascii_letter(c: u32) -> bool {
    (c < 0x80 && is_ascii_letter(c as u16)) || c == 0x17F || c == 0x212A
}

fn index_of(t: &Text, pat: &[u16], from: usize) -> Option<usize> {
    if pat.len() > t.len() {
        return None;
    }
    (from..=t.len() - pat.len()).find(|&i| t[i..].starts_with(pat))
}

fn index_of_unit(t: &Text, c: char, from: usize) -> Option<usize> {
    t.get(from..)?.iter().position(|&x| x == u(c)).map(|p| p + from)
}

/// `lastIndexOf(pat, from)`: the last match starting at or before `from`, which clamps to the text.
fn last_index_of(t: &Text, pat: &[u16], from: isize) -> Option<usize> {
    let max = t.len().checked_sub(pat.len())?;
    let start = (from.max(0) as usize).min(max);
    (0..=start).rev().find(|&i| t[i..].starts_with(pat))
}

fn contains(t: &Text, pat: &[u16]) -> bool {
    index_of(t, pat, 0).is_some()
}

fn ends_with(t: &Text, pat: &[u16]) -> bool {
    t.ends_with(pat)
}

/// `slice(from, to)`: empty when `from` is past `to`.
fn slice(t: &Text, from: usize, to: usize) -> &Text {
    let to = to.min(t.len());
    if from >= to { &[] } else { &t[from..to] }
}

fn trim(t: &Text) -> &Text {
    trim_end(trim_start(t))
}

fn trim_start(t: &Text) -> &Text {
    let start = t.iter().position(|&c| !is_space_unit(c)).unwrap_or(t.len());
    &t[start..]
}

fn trim_end(t: &Text) -> &Text {
    let end = t.iter().rposition(|&c| !is_space_unit(c)).map_or(0, |p| p + 1);
    &t[..end]
}

fn concat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}

fn repeat(c: u16, n: usize) -> Vec<u16> {
    vec![c; n]
}

/// Whether the unit at `position` follows an odd run of backslashes.
fn is_escaped(t: &Text, position: usize) -> bool {
    let position = position.min(t.len());
    t[..position].iter().rev().take_while(|&&c| c == u('\\')).count() % 2 == 1
}

// ---- Scan: code and prose regions, and lazy masks for math, link URLs and tags ----

const PROSE: u8 = 0;
/// The ``` or ~~~ run that opens or closes a fence.
const FENCE_MARKER: u8 = 1;
/// The info string on a fence opener line.
const FENCE_INFO: u8 = 2;
const FENCE_BODY: u8 = 3;
/// A complete inline code span, markers included.
const CODE_SPAN: u8 = 4;
/// An inline code span whose closing run hasn't arrived.
const CODE_SPAN_OPEN: u8 = 5;

struct OpenFence {
    ch: u16,
    /// A closer must be at least this long.
    length: usize,
    /// Content column of the list item the opener line starts; zero when it starts none.
    list_indent: usize,
    /// Block quote markers each body line must repeat.
    quote_depth: usize,
}

struct OpenSpan {
    /// The closer must match this length exactly.
    run_length: usize,
    start: usize,
}

/// A text's regions, computed once and queried per position.
struct Scan<'a> {
    text: &'a Text,
    regions: Vec<u8>,
    open_fence: Option<OpenFence>,
    open_span: Option<OpenSpan>,
    math: OnceCell<Vec<u8>>,
    math_without_dollar: OnceCell<Vec<u8>>,
    link_url: OnceCell<Vec<u8>>,
    html_tag: OnceCell<Vec<u8>>,
}

fn fill(regions: &mut [u8], value: u8, from: usize, to: usize) {
    let to = to.min(regions.len());
    if from < to {
        regions[from..to].fill(value);
    }
}

/// Index just past a list marker and its space at `start`.
fn skip_list_marker(t: &Text, start: usize) -> Option<usize> {
    let mut i = start;
    if is(t, i, '-') || is(t, i, '*') || is(t, i, '+') {
        i += 1;
    } else {
        while is_digit(at(t, i)) && i - start < 9 {
            i += 1;
        }
        if i == start || !(is(t, i, '.') || is(t, i, ')')) {
            return None;
        }
        i += 1;
    }
    is(t, i, ' ').then_some(i + 1)
}

/// Where a line's content starts after its block quote and list markers.
struct ContainerPrefix {
    content_start: usize,
    list_indent: usize,
    quote_depth: usize,
}

fn skip_container_prefix(t: &Text, line_start: usize, line_end: usize) -> ContainerPrefix {
    let mut quote_depth = 0;
    let mut after_quotes = line_start;
    let mut starts_item = false;
    let mut i = line_start;
    loop {
        while i < line_end && is(t, i, ' ') {
            i += 1;
        }
        if is(t, i, '>') {
            quote_depth += 1;
            i += if is(t, i + 1, ' ') { 2 } else { 1 };
            after_quotes = i;
            starts_item = false;
            continue;
        }
        let after_marker = if i < line_end { skip_list_marker(t, i) } else { None };
        match after_marker {
            None => {
                return ContainerPrefix {
                    content_start: i,
                    list_indent: if starts_item { i - after_quotes } else { 0 },
                    quote_depth,
                };
            }
            Some(after) => {
                i = after;
                starts_item = true;
            }
        }
    }
}

/// Index just past `depth` block quote markers, or none if the line carries fewer.
fn skip_quote_markers(t: &Text, line_start: usize, line_end: usize, depth: usize) -> Option<usize> {
    let mut i = line_start;
    for _ in 0..depth {
        while i < line_end && is(t, i, ' ') {
            i += 1;
        }
        if !is(t, i, '>') {
            return None;
        }
        i += 1;
        if is(t, i, ' ') {
            i += 1;
        }
    }
    Some(i)
}

fn is_fence_closer(t: &Text, content_start: usize, line_end: usize, fence: &OpenFence) -> bool {
    let mut i = content_start;
    while i < line_end && is(t, i, ' ') {
        i += 1;
    }
    let mut run = 0;
    while i < line_end && at(t, i) == fence.ch {
        i += 1;
        run += 1;
    }
    run >= fence.length && slice(t, i, line_end).iter().all(|&c| c == u(' ') || c == u('\t') || c == u('\r'))
}

fn open_fence_at(t: &Text, regions: &mut [u8], line_start: usize, line_end: usize) -> Option<OpenFence> {
    let content_end = if line_end > line_start && is(t, line_end - 1, '\r') { line_end - 1 } else { line_end };
    let prefix = skip_container_prefix(t, line_start, content_end);
    let line = slice(t, prefix.content_start, content_end);
    let ch = *line.first()?;
    if ch != u('`') && ch != u('~') {
        return None;
    }
    let run = line.iter().take_while(|&&c| c == ch).count();
    let info = &line[run..];
    if run < 3 || info.iter().any(|&c| matches!(c, 0x0D | 0x2028 | 0x2029)) {
        return None;
    }
    // A backtick fence's info string can't hold a backtick; such a line is inline code
    if ch == u('`') && info.contains(&u('`')) {
        return None;
    }
    let marker_start = prefix.content_start;
    fill(regions, FENCE_MARKER, marker_start, marker_start + run);
    fill(regions, FENCE_INFO, marker_start + run, line_end + 1);
    Some(OpenFence { ch, length: run, list_indent: prefix.list_indent, quote_depth: prefix.quote_depth })
}

/// Where a body line's content starts inside its fence's containers, or none if it leaves them.
fn fence_content_start(t: &Text, line_start: usize, line_end: usize, fence: &OpenFence) -> Option<usize> {
    let content_start = skip_quote_markers(t, line_start, line_end, fence.quote_depth)?;
    if fence.list_indent == 0 {
        return Some(content_start);
    }
    let mut i = content_start;
    while i < line_end && is(t, i, ' ') {
        i += 1;
    }
    let blank = i == line_end || (is(t, i, '\r') && i + 1 == line_end);
    (blank || i - content_start >= fence.list_indent).then_some(content_start)
}

fn paint_fences(t: &Text, regions: &mut [u8]) -> Option<OpenFence> {
    let n = t.len();
    let mut open: Option<OpenFence> = None;
    let mut line_start = 0;
    while line_start < n {
        let line_end = index_of_unit(t, '\n', line_start).unwrap_or(n);
        let content_start = open.as_ref().and_then(|f| fence_content_start(t, line_start, line_end, f));
        if content_start.is_none() {
            open = None;
        }
        match (&open, content_start) {
            (Some(fence), Some(start)) if is_fence_closer(t, start, line_end, fence) => {
                fill(regions, FENCE_MARKER, line_start, line_end);
                open = None;
            }
            (Some(_), _) => fill(regions, FENCE_BODY, line_start, line_end + 1),
            (None, _) => open = open_fence_at(t, regions, line_start, line_end),
        }
        line_start = line_end + 1;
    }
    open
}

fn backtick_run_end(t: &Text, start: usize) -> usize {
    let mut end = start + 1;
    while end < t.len() && is(t, end, '`') {
        end += 1;
    }
    end
}

/// A blank line ends the paragraph, and with it any chance of closing a span.
fn is_paragraph_break_at(t: &Text, newline: usize) -> bool {
    let mut j = newline + 1;
    while j < t.len() && (is(t, j, ' ') || is(t, j, '\t') || is(t, j, '\r')) {
        j += 1;
    }
    is(t, j, '\n')
}

/// The next prose backtick that could open a span.
fn next_span_opener(t: &Text, regions: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    loop {
        let next = index_of_unit(t, '`', i)?;
        let escaped = next > i && regions[next - 1] == PROSE && is_escaped(t, next);
        if regions[next] == PROSE && !escaped {
            return Some(next);
        }
        i = next + 1;
    }
}

fn paint_spans(t: &Text, regions: &mut [u8]) -> Option<OpenSpan> {
    let n = t.len();
    let mut span_start: Option<usize> = None;
    let mut run_length = 0;
    let mut i = 0;
    while i < n {
        let Some(start) = span_start else {
            let Some(opener) = next_span_opener(t, regions, i) else { break };
            let end = backtick_run_end(t, opener);
            span_start = Some(opener);
            run_length = end - opener;
            i = end;
            continue;
        };
        if regions[i] != PROSE {
            // A span can't cross into a fence
            fill(regions, CODE_SPAN_OPEN, start, i);
            span_start = None;
            i += 1;
            continue;
        }
        if is(t, i, '\n') && is_paragraph_break_at(t, i) {
            span_start = None;
            i += 1;
            continue;
        }
        if !is(t, i, '`') {
            i += 1;
            continue;
        }
        let run_end = backtick_run_end(t, i);
        if run_end - i == run_length {
            fill(regions, CODE_SPAN, start, run_end);
            span_start = None;
        }
        i = run_end;
    }
    let start = span_start?;
    fill(regions, CODE_SPAN_OPEN, start, n);
    Some(OpenSpan { start, run_length })
}

#[derive(Clone, Copy, PartialEq)]
enum MathContext {
    None,
    InlineDollar,
    BlockDollar,
    InlineLatex,
    BlockLatex,
}

/// A math delimiter or escaped dollar at `i`: the context after it and its length.
fn math_delimiter_at(t: &Text, i: usize, context: MathContext, single_dollar: bool) -> Option<(MathContext, usize)> {
    let next = at(t, i + 1);
    if is(t, i, '\\') {
        if next == u('$') {
            return Some((context, 2));
        }
        let latex = match (next, context) {
            (c, MathContext::None) if c == u('[') => MathContext::BlockLatex,
            (c, MathContext::BlockLatex) if c == u(']') => MathContext::None,
            (c, MathContext::None) if c == u('(') => MathContext::InlineLatex,
            (c, MathContext::InlineLatex) if c == u(')') => MathContext::None,
            _ => return None,
        };
        return Some((latex, 2));
    }
    if is(t, i, '$') && !matches!(context, MathContext::InlineLatex | MathContext::BlockLatex) {
        let block = next == u('$');
        if !(block || single_dollar) {
            return None;
        }
        let after = if block {
            if context == MathContext::BlockDollar { MathContext::None } else { MathContext::BlockDollar }
        } else if context == MathContext::BlockDollar {
            context
        } else if context == MathContext::InlineDollar {
            MathContext::None
        } else {
            MathContext::InlineDollar
        };
        return Some((after, if block { 2 } else { 1 }));
    }
    None
}

impl<'a> Scan<'a> {
    fn new(text: &'a Text) -> Self {
        let mut regions = vec![PROSE; text.len()];
        let open_fence = paint_fences(text, &mut regions);
        let open_span = paint_spans(text, &mut regions);
        Scan {
            text,
            regions,
            open_fence,
            open_span,
            math: OnceCell::new(),
            math_without_dollar: OnceCell::new(),
            link_url: OnceCell::new(),
            html_tag: OnceCell::new(),
        }
    }

    /// Whether a fence or inline span holds the position.
    fn is_code_at(&self, position: isize) -> bool {
        if position >= self.regions.len() as isize {
            return self.open_fence.is_some() || self.open_span.is_some();
        }
        position >= 0 && self.regions[position as usize] != PROSE
    }

    /// Whether a fenced code block holds the position (marker, info or body).
    fn is_fence_at(&self, position: usize) -> bool {
        match self.regions.get(position) {
            None => self.open_fence.is_some(),
            Some(&r) => matches!(r, FENCE_MARKER | FENCE_INFO | FENCE_BODY),
        }
    }

    fn is_complete_span_at(&self, position: usize) -> bool {
        self.regions.get(position) == Some(&CODE_SPAN)
    }

    /// Whether the position is in math, where `single_dollar` decides if a lone `$` opens it.
    fn in_math_at(&self, position: isize, single_dollar: bool) -> bool {
        if position < 0 || position as usize >= self.text.len() {
            return false;
        }
        let cell = if single_dollar { &self.math } else { &self.math_without_dollar };
        let mask = cell.get_or_init(|| {
            let t = self.text;
            if contains(t, &[u('$')]) || contains(t, &[u('\\'), u('(')]) || contains(t, &[u('\\'), u('[')]) {
                self.build_math_mask(single_dollar)
            } else {
                Vec::new()
            }
        });
        mask.get(position as usize) == Some(&1)
    }

    fn build_math_mask(&self, single_dollar: bool) -> Vec<u8> {
        let n = self.text.len();
        let mut mask = vec![0; n];
        let mut context = MathContext::None;
        let mut i = 0;
        while i < n {
            mask[i] = u8::from(context != MathContext::None);
            let delimiter = if self.regions[i] == PROSE {
                math_delimiter_at(self.text, i, context, single_dollar)
            } else {
                None
            };
            let Some((after, length)) = delimiter else {
                i += 1;
                continue;
            };
            context = after;
            if length == 2 {
                mask[i + 1] = u8::from(context != MathContext::None);
            }
            i += length;
        }
        mask
    }

    /// Whether the position is inside the (url) of a [text](url).
    fn in_link_url_at(&self, position: usize) -> bool {
        if position >= self.text.len() {
            return false;
        }
        let mask = self.link_url.get_or_init(|| {
            if contains(self.text, &[u(']'), u('(')]) { self.build_link_url_mask() } else { Vec::new() }
        });
        mask.get(position) == Some(&1)
    }

    fn build_link_url_mask(&self) -> Vec<u8> {
        let t = self.text;
        let n = t.len();
        let mut mask = vec![0; n];
        let mut line_start = 0;
        while line_start < n {
            let line_end = index_of_unit(t, '\n', line_start).unwrap_or(n);
            // Whether a ")" still follows each position on the line
            let mut closer_follows = vec![false; line_end - line_start];
            let mut seen = false;
            for i in (line_start..line_end).rev() {
                if t[i] == u(')') && self.regions[i] == PROSE {
                    seen = true;
                }
                closer_follows[i - line_start] = seen;
            }
            let mut in_url = false;
            for i in line_start..line_end {
                if in_url && closer_follows[i - line_start] {
                    mask[i] = 1;
                }
                if self.regions[i] != PROSE {
                    continue;
                }
                if t[i] == u(')') {
                    in_url = false;
                } else if t[i] == u('(') {
                    in_url = i > 0 && t[i - 1] == u(']');
                }
            }
            line_start = line_end + 1;
        }
        mask
    }

    /// Whether the position is inside an HTML tag, after its `<` through its `>`.
    fn in_html_tag_at(&self, position: usize) -> bool {
        if position >= self.text.len() {
            return false;
        }
        let mask = self.html_tag.get_or_init(|| {
            if contains(self.text, &[u('<')]) { self.build_html_tag_mask() } else { Vec::new() }
        });
        mask.get(position) == Some(&1)
    }

    fn build_html_tag_mask(&self) -> Vec<u8> {
        let t = self.text;
        let mut mask = vec![0; t.len()];
        let mut in_tag = false;
        for i in 0..t.len() {
            if t[i] == u('\n') {
                in_tag = false;
                continue;
            }
            mask[i] = u8::from(in_tag);
            if self.regions[i] != PROSE {
                continue;
            }
            if t[i] == u('>') {
                in_tag = false;
            } else if t[i] == u('<') {
                let next = at(t, i + 1);
                in_tag = is_ascii_letter(next) || next == u('/');
            }
        }
        mask
    }

    /// Counts non-overlapping `$$` pairs in prose.
    fn count_dollar_pairs(&self) -> usize {
        let pair = [u('$'), u('$')];
        let mut count = 0;
        let mut i = index_of(self.text, &pair, 0);
        while let Some(at) = i {
            let next = if self.regions[at] == PROSE {
                count += 1;
                at + 2
            } else {
                at + 1
            };
            i = index_of(self.text, &pair, next);
        }
        count
    }
}

// ---- The last inline block ----

fn is_heading(c: &Text) -> bool {
    let hashes = c.iter().take_while(|&&x| x == u('#')).count();
    (1..=6).contains(&hashes) && (hashes == c.len() || c[hashes] == u(' ') || c[hashes] == u('\t'))
}

fn is_thematic_break(c: &Text) -> bool {
    let Some(&marker) = c.first() else { return false };
    (marker == u('*') || marker == u('-') || marker == u('_'))
        && c.iter().all(|&x| x == marker || x == u(' ') || x == u('\t'))
        && c.iter().filter(|&&x| x == marker).count() >= 3
}

fn is_setext_underline(c: &Text) -> bool {
    let Some(&marker) = c.first() else { return false };
    let run = c.iter().take_while(|&&x| x == marker).count();
    (marker == u('=') || marker == u('-')) && c[run..].iter().all(|&x| x == u(' ') || x == u('\t'))
}

fn is_empty_item(c: &Text) -> bool {
    if c.len() == 1 && (c[0] == u('*') || c[0] == u('+') || c[0] == u('-')) {
        return true;
    }
    let digits = c.iter().take_while(|&&x| is_digit(x)).count();
    (1..=9).contains(&digits) && c.len() == digits + 1 && (c[digits] == u('.') || c[digits] == u(')'))
}

/// The setext handler's zero-width space after a streaming dash.
fn is_dash_placeholder(c: &Text) -> bool {
    c == [u('-'), 0x200B] || c == [u('-'), u('-'), 0x200B]
}

#[derive(Clone, Copy, PartialEq)]
enum Paragraph {
    None,
    Top,
    Contained,
}

fn paragraph_in(prefix: &ContainerPrefix) -> Paragraph {
    if prefix.list_indent > 0 || prefix.quote_depth > 0 { Paragraph::Contained } else { Paragraph::Top }
}

/// Index where the text's last inline block starts, since emphasis, spans and links never cross
/// paragraphs, list items, headings, table rows or code blocks.
fn find_inline_block_start(scan: &Scan) -> usize {
    let t = scan.text;
    let mut start = 0;
    let mut quote_depth = 0;
    let mut ends_block = false;
    let mut paragraph = Paragraph::None;
    let mut line_start = 0;
    while line_start <= t.len() {
        let line_end = index_of_unit(t, '\n', line_start).unwrap_or(t.len());
        let next = line_end + 1;
        let prefix = skip_container_prefix(t, line_start, line_end);
        let content = trim(slice(t, prefix.content_start, line_end));
        if line_end == t.len() && content.is_empty() {
            break;
        }
        let starts_empty_item = line_end < t.len()
            && is_empty_item(content)
            && (paragraph == Paragraph::None
                || (paragraph == Paragraph::Contained && prefix.quote_depth == 0 && prefix.content_start == line_start));
        let heading = is_heading(content);
        let row = content.first() == Some(&u('|'));
        if content.is_empty()
            || scan.is_fence_at(prefix.content_start)
            || is_thematic_break(trim(slice(t, line_start, line_end)))
            || is_thematic_break(content)
            || (is_setext_underline(content) && !ends_block)
            || starts_empty_item
        {
            start = next;
            ends_block = false;
            paragraph = Paragraph::None;
        } else if ends_block
            || prefix.list_indent > 0
            || prefix.quote_depth > quote_depth
            || is_dash_placeholder(content)
            || heading
            || row
        {
            start = prefix.content_start;
            ends_block = heading || row;
            paragraph = if ends_block { Paragraph::None } else { paragraph_in(&prefix) };
        } else if paragraph == Paragraph::None {
            paragraph = paragraph_in(&prefix);
        }
        quote_depth = prefix.quote_depth;
        line_start = next;
    }
    start.min(t.len())
}

// ---- Single tilde ----

/// `[^\s"'<>\x60()\[\]]`
fn is_url_char(c: u32) -> bool {
    !is_space(c) && !matches!(char::from_u32(c), Some('"' | '\'' | '<' | '>' | '`' | '(' | ')' | '[' | ']'))
}

/// The end of a URL's rest from `i`, keeping parentheses that open and close inside it.
fn url_rest_end(t: &Text, mut i: usize) -> usize {
    while i < t.len() {
        let (c, len) = code_point_at(t, i);
        if is_url_char(c) {
            i += len;
            continue;
        }
        if c != u32::from(u('(')) {
            break;
        }
        let mut j = i + 1;
        while j < t.len() {
            let (c, len) = code_point_at(t, j);
            if !is_url_char(c) {
                break;
            }
            j += len;
        }
        if !is(t, j, ')') {
            break;
        }
        i = j + 1;
    }
    i
}

fn is_ci(t: &Text, i: usize, lower: char) -> bool {
    let c = at(t, i);
    c == u(lower) || c == u(lower.to_ascii_uppercase())
}

/// The end of `https?://` and its URL at `i`, case-insensitively.
fn protocol_url_at(t: &Text, i: usize) -> Option<usize> {
    if !(is_ci(t, i, 'h') && is_ci(t, i + 1, 't') && is_ci(t, i + 2, 't') && is_ci(t, i + 3, 'p')) {
        return None;
    }
    let mut j = i + 4;
    if is_ci(t, j, 's') || at(t, j) == 0x17F {
        j += 1;
    }
    (is(t, j, ':') && is(t, j + 1, '/') && is(t, j + 2, '/')).then(|| url_rest_end(t, j + 3))
}

/// The end of `www.` and its URL at `i`, case-insensitively.
fn www_url_at(t: &Text, i: usize) -> Option<usize> {
    (is_ci(t, i, 'w') && is_ci(t, i + 1, 'w') && is_ci(t, i + 2, 'w') && is(t, i + 3, '.')).then(|| url_rest_end(t, i + 4))
}

/// The end of an HTML tag with attributes at `i`: `<[a-z][\w-]*\s[^<>\n]*>`, case-insensitively.
fn html_tag_at(t: &Text, i: usize) -> Option<usize> {
    if !is(t, i, '<') || i + 1 >= t.len() {
        return None;
    }
    let (first, len) = code_point_at(t, i + 1);
    if !is_folded_ascii_letter(first) {
        return None;
    }
    let mut j = i + 1 + len;
    while j < t.len() {
        let (c, len) = code_point_at(t, j);
        if !(is_folded_ascii_letter(c) || c < 0x80 && is_digit(c as u16) || c == 0x5F || c == 0x2D) {
            break;
        }
        j += len;
    }
    if j >= t.len() || !is_space_unit(t[j]) {
        return None;
    }
    j += 1;
    while j < t.len() && !matches!(char::from_u32(t[j] as u32), Some('<' | '>' | '\n')) {
        j += 1;
    }
    is(t, j, '>').then_some(j + 1)
}

/// The end of a tag or a URL GFM autolinks, starting at `i` (with the character before the URL).
fn kept_as_is_at(t: &Text, i: usize) -> Option<usize> {
    if let Some(end) = html_tag_at(t, i) {
        return Some(end);
    }
    if i == 0
        && let Some(end) = protocol_url_at(t, 0)
    {
        return Some(end);
    }
    let (c, len) = code_point_at(t, i);
    if !is_folded_ascii_letter(c)
        && let Some(end) = protocol_url_at(t, i + len)
    {
        return Some(end);
    }
    if i == 0
        && let Some(end) = www_url_at(t, 0)
    {
        return Some(end);
    }
    if matches!(char::from_u32(c), Some('\t' | '\n' | '\r' | ' ' | '(' | '*' | '_' | '[' | ']' | '~')) {
        return www_url_at(t, i + 1);
    }
    None
}

/// Escapes a single `~` between word characters so it isn't read as strikethrough (`20~25`).
fn escape_single_tildes(t: &Text) -> Vec<u16> {
    if !t.contains(&u('~')) {
        return t.to_vec();
    }
    let scan = Scan::new(t);
    let mut out = Vec::with_capacity(t.len() + 4);
    let mut copied = 0;
    let mut i = 0;
    while i < t.len() {
        if let Some(end) = kept_as_is_at(t, i) {
            i = end;
            continue;
        }
        let (c, len) = code_point_at(t, i);
        let tilde = i + len;
        if is_word_folded(c)
            && is(t, tilde, '~')
            && tilde + 1 < t.len()
            && is_word_folded(code_point_at(t, tilde + 1).0)
        {
            if !scan.is_code_at(tilde as isize) {
                out.extend_from_slice(&t[copied..tilde]);
                out.push(u('\\'));
                copied = tilde;
            }
            i = tilde + 1;
            continue;
        }
        i += len;
    }
    out.extend_from_slice(&t[copied..]);
    out
}

// ---- Comparison operators ----

/// Escapes a `>` that's a comparison in a list item (`- > 25`), not a block quote.
fn escape_comparisons(t: &Text) -> Vec<u16> {
    if !t.contains(&u('>')) {
        return t.to_vec();
    }
    let scan = Scan::new(t);
    let mut out = Vec::with_capacity(t.len() + 2);
    let mut copied = 0;
    let mut p = 0;
    while p < t.len() {
        if p > 0 && !matches!(t[p - 1], 0x0A | 0x0D | 0x2028 | 0x2029) {
            p += 1;
            continue;
        }
        let mut j = p;
        while j < t.len() && is_space_unit(t[j]) {
            j += 1;
        }
        match comparison_after_indent(t, j) {
            Some((gt, end)) => {
                if !scan.is_code_at(p as isize) {
                    out.extend_from_slice(&t[copied..gt]);
                    out.push(u('\\'));
                    copied = gt;
                }
                p = end;
            }
            // Every line start up to `j` reaches the same content, so fails the same way
            None => p = j + 1,
        }
    }
    out.extend_from_slice(&t[copied..]);
    out
}

/// For a list marker at `i` followed by `>` and a number: the `>`'s index and the match's end.
fn comparison_after_indent(t: &Text, i: usize) -> Option<(usize, usize)> {
    let mut j = i;
    if is(t, j, '-') || is(t, j, '*') || is(t, j, '+') {
        j += 1;
    } else {
        while is_digit(at(t, j)) {
            j += 1;
        }
        if j == i || !(is(t, j, '.') || is(t, j, ')')) {
            return None;
        }
        j += 1;
    }
    if !is(t, j, ' ') {
        return None;
    }
    while is(t, j, ' ') {
        j += 1;
    }
    if !is(t, j, '>') {
        return None;
    }
    let gt = j;
    j += 1;
    if is(t, j, '=') {
        j += 1;
    }
    while j < t.len() && is_space_unit(t[j]) {
        j += 1;
    }
    if is(t, j, '$') && is_digit(at(t, j + 1)) {
        return Some((gt, j + 2));
    }
    is_digit(at(t, j)).then_some((gt, j + 1))
}

// ---- HTML tags ----

/// Drops an incomplete HTML tag at the end (`text <custom`), outside code and math.
fn strip_incomplete_html_tag(t: &Text) -> Vec<u16> {
    let from = t.iter().rposition(|&c| c == u('>')).map_or(0, |p| p + 1);
    let starts_tag = |i: usize| t[i] == u('<') && (is_ascii_letter(at(t, i + 1)) || at(t, i + 1) == u('/'));
    if !(from..t.len()).any(starts_tag) {
        return t.to_vec();
    }
    let scan = Scan::new(t);
    let check_math = contains(t, &[u('$')]) || contains(t, &[u('\\'), u('(')]) || contains(t, &[u('\\'), u('[')]);
    for i in from..t.len() {
        if !starts_tag(i) || scan.is_code_at(i as isize) || (check_math && scan.in_math_at(i as isize, true)) {
            continue;
        }
        return trim_end(&t[..i]).to_vec();
    }
    t.to_vec()
}

// ---- Setext headings ----

/// `^ {0,3}(?:[-+*]|(\d{1,9})[.)])(?: +|\t)`: the match's length, and whether the marker is
/// ordered and exactly "1".
struct ListItem {
    length: usize,
    ordered: Option<bool>,
}

fn list_item(line: &Text) -> Option<ListItem> {
    let indent = line.iter().take(4).take_while(|&&c| c == u(' ')).count();
    if indent > 3 {
        return None;
    }
    let mut j = indent;
    let ordered = if matches!(char::from_u32(at(line, j) as u32), Some('-' | '+' | '*')) {
        j += 1;
        None
    } else {
        let digits = line[j..].iter().take_while(|&&c| is_digit(c)).count();
        if !(1..=9).contains(&digits) || !(is(line, j + digits, '.') || is(line, j + digits, ')')) {
            return None;
        }
        let one = line[j..j + digits] == [u('1')];
        j += digits + 1;
        Some(one)
    };
    if is(line, j, ' ') {
        while is(line, j, ' ') {
            j += 1;
        }
    } else if is(line, j, '\t') {
        j += 1;
    } else {
        return None;
    }
    Some(ListItem { length: j, ordered })
}

fn is_blockquote_line(line: &Text) -> bool {
    let indent = line.iter().take_while(|&&c| c == u(' ')).count();
    indent <= 3 && is(line, indent, '>')
}

/// Column width of leading whitespace, tabs to the next multiple of 4.
fn indentation_width(line: &Text) -> usize {
    let mut width = 0;
    for &c in line.iter().take_while(|&&c| c == u(' ') || c == u('\t')) {
        width += if c == u('\t') { 4 - width % 4 } else { 1 };
    }
    width
}

/// Whether the ordered run ending the lines may start a list: an ordered marker other than 1
/// can't interrupt a paragraph.
fn starts_ordered_list(lines: &[&Text]) -> bool {
    for line in lines.iter().rev() {
        let item = list_item(line);
        match item.as_ref().and_then(|i| i.ordered) {
            None => return trim(line).is_empty() || item.is_some() || is_blockquote_line(line),
            Some(true) => return true,
            Some(false) => {}
        }
    }
    true
}

/// Whether the dash starts a new list item or leaves a block quote, so no heading can form.
fn is_outside_previous_container(previous: &Text, last: &Text, lines: &[&Text]) -> bool {
    if let Some(item) = list_item(previous) {
        if item.ordered.is_some() && !starts_ordered_list(lines) {
            return false;
        }
        return indentation_width(last) < item.length;
    }
    is_blockquote_line(previous)
}

/// Adds a zero-width space after a trailing `-`, `--`, `=` or `==` under text, which would
/// otherwise make the text a setext heading while the line streams.
fn break_setext_heading(t: &Text) -> Vec<u16> {
    let Some(newline) = t.iter().rposition(|&c| c == u('\n')) else { return t.to_vec() };
    let last = &t[newline + 1..];
    let lines: Vec<&Text> = t[..newline].split(|&c| c == u('\n')).collect();
    let previous = lines[lines.len() - 1];
    let trimmed = trim(last);
    let has_trailing_space = last.last().is_some_and(|&c| is_space_unit(c));
    let only = |c: char| (1..=2).contains(&trimmed.len()) && trimmed.iter().all(|&x| x == u(c));
    let broken = concat(&[t, &[0x200B]]);
    if only('-') && !has_trailing_space && !trim(previous).is_empty() && !is_outside_previous_container(previous, last, &lines) {
        return broken;
    }
    if only('=') && !has_trailing_space && !trim(previous).is_empty() {
        return broken;
    }
    t.to_vec()
}

// ---- Links and images ----

/// The `[` matching the `]` at `close`, skipping brackets inside complete code spans.
fn matching_opening_bracket(scan: &Scan, close: usize) -> Option<usize> {
    let mut depth = 1;
    for i in (0..close).rev() {
        if scan.is_complete_span_at(i) {
            continue;
        }
        if scan.text[i] == u(']') {
            depth += 1;
        } else if scan.text[i] == u('[') {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// The `]` matching the `[` at `open`, skipping brackets inside complete code spans.
fn matching_closing_bracket(scan: &Scan, open: usize) -> Option<usize> {
    let mut depth = 1;
    for i in open + 1..scan.text.len() {
        if scan.is_complete_span_at(i) {
            continue;
        }
        if scan.text[i] == u('[') {
            depth += 1;
        } else if scan.text[i] == u(']') {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn placeholder_link(before: &Text, label: &Text, image: bool) -> Vec<u16> {
    if image {
        concat(&[before, &utf16("!["), label, &utf16(IMAGE_PLACEHOLDER)])
    } else {
        concat(&[before, &utf16("["), label, &utf16(LINK_PLACEHOLDER)])
    }
}

/// A link or image whose `](` has no `)` yet, given the `]` at `bracket`.
fn heal_incomplete_url(scan: &Scan, bracket: usize, block_start: usize) -> Option<Vec<u16>> {
    let t = scan.text;
    if t[bracket + 2..].contains(&u(')')) {
        return None;
    }
    let open = matching_opening_bracket(scan, bracket)?;
    if open < block_start || scan.is_code_at(open as isize) {
        return None;
    }
    let image = open > 0 && t[open - 1] == u('!');
    let start = if image { open - 1 } else { open };
    Some(placeholder_link(&t[..start], &t[open + 1..bracket], image))
}

/// A link or image whose `[` at `i` has no matching `]`.
fn heal_incomplete_label(scan: &Scan, i: usize) -> Option<Vec<u16>> {
    let t = scan.text;
    let image = i > 0 && t[i - 1] == u('!');
    if t[i + 1..].contains(&u(']')) && matching_closing_bracket(scan, i).is_some() {
        return None;
    }
    if image {
        return Some(placeholder_link(&t[..i - 1], &t[i + 1..], true));
    }
    Some(concat(&[t, &utf16(LINK_PLACEHOLDER)]))
}

fn opens_complete_link(scan: &Scan, open: usize) -> bool {
    matching_closing_bracket(scan, open)
        .is_some_and(|close| is(scan.text, close + 1, '(') && index_of_unit(scan.text, ')', close + 2).is_some())
}

/// One healing step over the trailing incomplete link or image, if any.
fn heal_trailing_link_or_image(t: &Text) -> Vec<u16> {
    let scan = Scan::new(t);
    let block_start = find_inline_block_start(&scan);
    if let Some(bracket) = last_index_of(t, &[u(']'), u('(')], t.len() as isize)
        && bracket >= block_start
        && !scan.is_code_at(bracket as isize)
        && let Some(healed) = heal_incomplete_url(&scan, bracket, block_start)
    {
        return healed;
    }
    let mut encloses_link = false;
    let mut next = last_index_of(t, &[u('[')], t.len() as isize);
    while let Some(i) = next
        && i >= block_start
    {
        next = if i == 0 { None } else { last_index_of(t, &[u('[')], i as isize - 1) };
        let is_link = !((i > 0 && t[i - 1] == u('!')) || scan.is_fence_at(i) || scan.is_complete_span_at(i));
        // Links can't contain links, so a link bracket before one is literal text
        if is_link && encloses_link {
            continue;
        }
        let closes_here = is_link && opens_complete_link(&scan, i);
        encloses_link |= closes_here;
        if !(closes_here || scan.is_code_at(i as isize))
            && let Some(healed) = heal_incomplete_label(&scan, i)
        {
            return healed;
        }
    }
    t.to_vec()
}

/// Bounds the passes, each a full rescan, on a tail of many nested incomplete constructs.
const MAX_LINK_PASSES: usize = 32;

/// Heals until the text re-heals to itself: dropping an image can expose another before it.
fn heal_links_repeatedly(t: &Text) -> Vec<u16> {
    let mut current = t.to_vec();
    for _ in 0..MAX_LINK_PASSES {
        let next = heal_trailing_link_or_image(&current);
        if next.len() >= current.len() {
            return next;
        }
        current = next;
    }
    current
}

/// Closes incomplete links and images with a placeholder URL.
fn heal_links_and_images(t: &Text) -> Vec<u16> {
    let healed = heal_links_repeatedly(t);
    if healed != t || ends_with(t, &utf16(LINK_PLACEHOLDER)) || ends_with(t, &utf16(IMAGE_PLACEHOLDER)) {
        return healed;
    }
    let scan = Scan::new(t);
    let Some(span) = &scan.open_span else { return t.to_vec() };
    if last_index_of(t, &[u('[')], span.start as isize).is_none() {
        return t.to_vec();
    }
    // Closing an open code span can swallow brackets and leave a link opener unclosed, so heal
    // against the span the inline code handler will close, and keep that only when a link needed it
    let body = trim_end(t);
    let closed = close_inline_code(body);
    if closed == body {
        return t.to_vec();
    }
    let relinked = heal_links_repeatedly(&closed);
    if relinked == closed { t.to_vec() } else { concat(&[&relinked, &t[body.len()..]]) }
}

// ---- Inline code ----

fn is_space_or_marker(c: u16) -> bool {
    is_space_unit(c) || c == u('_') || c == u('~') || c == u('*') || c == u('`')
}

/// Closes an unclosed inline code span with the rest of its closing run.
fn close_inline_code(t: &Text) -> Vec<u16> {
    let scan = Scan::new(t);
    // Inside an unterminated fence, backticks are content
    if scan.open_fence.is_some() {
        return t.to_vec();
    }
    let Some(span) = &scan.open_span else { return t.to_vec() };
    if span.start < find_inline_block_start(&scan) {
        return t.to_vec();
    }
    // The closing run goes before trailing whitespace
    let mut end = t.len();
    while end > 0 && is_space_unit(t[end - 1]) {
        end -= 1;
    }
    let content = slice(t, span.start + span.run_length, end);
    if content.iter().all(|&c| is_space_or_marker(c)) {
        return t.to_vec();
    }
    let trailing_run = t[..end].iter().rev().take_while(|&&c| c == u('`')).count();
    // A trailing run at least as long as the opener is literal inside the span
    if trailing_run >= span.run_length {
        return t.to_vec();
    }
    // A run starting its line with three or more backticks would open a fence
    let run_start = end - trailing_run;
    let line_start = last_index_of(t, &[u('\n')], run_start as isize - 1).map_or(0, |p| p + 1);
    let opens_fence = trailing_run > 0 && span.run_length >= 3 && trim(slice(t, line_start, run_start)).is_empty();
    let closer = if opens_fence {
        concat(&[&[u(' ')], &repeat(u('`'), span.run_length)])
    } else {
        repeat(u('`'), span.run_length - trailing_run)
    };
    concat(&[&t[..end], &closer, &t[end..]])
}

// ---- Block math ----

/// Closes an odd `$$`.
fn close_block_math(t: &Text) -> Vec<u16> {
    if Scan::new(t).count_dollar_pairs().is_multiple_of(2) {
        return t.to_vec();
    }
    if ends_with(t, &[u('$')]) && !ends_with(t, &[u('$'), u('$')]) {
        return concat(&[t, &[u('$')]]);
    }
    let newline_after_start = index_of(t, &[u('$'), u('$')], 0).is_some_and(|first| index_of_unit(t, '\n', first).is_some());
    if newline_after_start && !ends_with(t, &[u('\n')]) {
        return concat(&[t, &utf16("\n$$")]);
    }
    concat(&[t, &utf16("$$")])
}

// ---- Emphasis: delimiter runs matched as micromark does ----

const STAR: u16 = u('*');
const UNDERSCORE: u16 = u('_');
const TILDE: u16 = u('~');

fn is_marker(c: u16) -> bool {
    c == STAR || c == UNDERSCORE || c == TILDE
}

/// A run of one marker and what it can do.
#[derive(Clone)]
struct Run {
    marker: u16,
    /// Index of the run's first unescaped marker.
    index: usize,
    /// Unescaped length before any were matched.
    length: usize,
    /// Markers still unmatched.
    count: usize,
    /// Whether the last opener this run closed is still partly open.
    closes_partially: bool,
    can_open: bool,
    can_close: bool,
    /// The characters on either side; none at the text's edge.
    prev: Option<u32>,
    next: Option<u32>,
    pairs_opened: usize,
    pairs_closed: usize,
    /// Start of the link label holding the run.
    scope: Option<usize>,
}

/// Runs matched to each other, by index into the match's runs.
#[derive(Clone)]
struct Pair {
    opener: usize,
    closer: usize,
    used: usize,
}

#[derive(Clone)]
struct DelimiterMatch {
    /// Markers that render as literal text.
    literal: usize,
    /// Runs still open outside link labels, innermost first.
    open: Vec<usize>,
    pairs: Vec<Pair>,
    runs: Vec<Run>,
}

impl DelimiterMatch {
    fn open_runs(&self) -> Vec<Run> {
        self.open.iter().map(|&i| self.runs[i].clone()).collect()
    }
}

/// The code point before `i`, a surrogate pair counting as one.
fn char_before(t: &Text, i: usize) -> Option<u32> {
    if i == 0 {
        return None;
    }
    let c = t[i - 1];
    if (0xDC00..0xE000).contains(&c) && i >= 2 && (0xD800..0xDC00).contains(&t[i - 2]) {
        return Some(code_point_at(t, i - 2).0);
    }
    Some(c as u32)
}

fn char_at(t: &Text, i: usize) -> Option<u32> {
    (i < t.len()).then(|| code_point_at(t, i).0)
}

/// The start and end of the text count as whitespace for flanking.
fn is_space_or_edge(c: Option<u32>) -> bool {
    c.is_none_or(is_space)
}

fn is_punctuation_char(c: Option<u32>) -> bool {
    c.is_some_and(is_punctuation)
}

/// Flanking per CommonMark, with the stricter underscore rules; tildes follow the asterisk rules,
/// and a tilde run longer than 2 is inert.
fn apply_flanking(run: &mut Run) {
    let (marker, prev, next) = (run.marker, run.prev, run.next);
    // micromark treats every attention marker as flanking punctuation
    let beside_marker = |c: Option<u32>| marker != TILDE && c.is_some_and(|c| c < 0x80 && is_marker(c as u16));
    let left = beside_marker(next)
        || !(is_space_or_edge(next) || (is_punctuation_char(next) && !is_space_or_edge(prev) && !is_punctuation_char(prev)));
    let right = beside_marker(prev)
        || !(is_space_or_edge(prev) || (is_punctuation_char(prev) && !is_space_or_edge(next) && !is_punctuation_char(next)));
    if marker == UNDERSCORE {
        run.can_close = right && (!left || is_punctuation_char(next));
        run.can_open = left && (!right || is_punctuation_char(prev));
        return;
    }
    let inert = marker == TILDE && run.length > 2;
    run.can_close = right && !inert;
    run.can_open = left && !inert;
}

fn create_run(marker: u16, index: usize, length: usize, prev: Option<u32>, next: Option<u32>, scope: Option<usize>) -> Run {
    let mut run = Run {
        marker,
        index,
        length,
        count: length,
        closes_partially: false,
        can_open: false,
        can_close: false,
        prev,
        next,
        pairs_opened: 0,
        pairs_closed: 0,
        scope,
    };
    apply_flanking(&mut run);
    run
}

impl Scan<'_> {
    /// Whether a marker here counts: an unclosed code span renders as text, so its markers do.
    fn is_marker_prose_at(&self, i: usize) -> bool {
        (self.regions[i] == PROSE || self.regions[i] == CODE_SPAN_OPEN)
            && !self.in_math_at(i as isize, false)
            && !self.in_link_url_at(i)
            && !self.in_html_tag_at(i)
    }
}

struct Label {
    start: usize,
    end: usize,
}

/// Completed links' labels, which wall their emphasis off from the rest of the block.
fn find_link_labels(scan: &Scan, from: usize) -> Vec<Label> {
    let t = scan.text;
    let mut labels = Vec::new();
    let mut openers = Vec::new();
    let mut inactive_through: Option<usize> = None;
    for i in from..t.len() {
        let c = t[i];
        if (c != u('[') && c != u(']')) || is_escaped(t, i) || !scan.is_marker_prose_at(i) {
            continue;
        }
        if c == u('[') {
            openers.push(i);
            continue;
        }
        if let Some(opener) = openers.pop()
            && inactive_through.is_none_or(|through| opener > through)
            && is(t, i + 1, '(')
            && scan.in_link_url_at(i + 2)
        {
            labels.push(Label { start: opener, end: i });
            // Links can't contain links, so this deactivates every opener still on the stack
            if prev(t, opener) != u('!') || is_escaped(t, opener - 1) {
                inactive_through = Some(opener);
            }
        }
    }
    labels
}

/// The innermost label holding `index`, sweeping labels sorted by start.
fn scope_at(labels: &[Label], index: usize, cursor: &mut usize, active: &mut Vec<usize>) -> Option<usize> {
    while *cursor < labels.len() && labels[*cursor].start < index {
        active.push(*cursor);
        *cursor += 1;
    }
    let mut end = active.len();
    while end > 0 && labels[active[end - 1]].end <= index {
        end -= 1;
    }
    if end < active.len() {
        let mut kept: Vec<usize> = active[..end].iter().copied().filter(|&l| labels[l].end > index).collect();
        std::mem::swap(active, &mut kept);
    }
    active.last().map(|&l| labels[l].start)
}

fn collect_delimiter_runs(scan: &Scan, from: usize) -> Vec<Run> {
    let t = scan.text;
    let mut labels = find_link_labels(scan, from);
    labels.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut cursor = 0;
    let mut active = Vec::new();
    let mut runs = Vec::new();
    let is_run_marker = |i: usize, marker: u16| t[i] == marker && scan.is_marker_prose_at(i);
    let mut i = from;
    while i < t.len() {
        let marker = t[i];
        if !(is_marker(marker) && is_run_marker(i, marker)) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < t.len() && is_run_marker(end, marker) {
            end += 1;
        }
        // A backslash escapes the run's first marker
        let escaped = is_escaped(t, i);
        let start = if escaped { i + 1 } else { i };
        if end > start {
            let prev = if escaped { Some(marker as u32) } else { char_before(t, i) };
            let scope = scope_at(&labels, start, &mut cursor, &mut active);
            runs.push(create_run(marker, start, end - start, prev, char_at(t, end), scope));
        }
        i = end;
    }
    runs
}

/// The "rule of 3" for runs that can both open and close.
fn violates_rule_of_three(opener: &Run, closer: &Run) -> bool {
    (closer.can_open || opener.can_close)
        && (opener.count + closer.count).is_multiple_of(3)
        && !(opener.count.is_multiple_of(3) && closer.count.is_multiple_of(3))
}

fn can_match(opener: &Run, closer: &Run) -> bool {
    if opener.marker != closer.marker {
        return false;
    }
    if closer.marker == TILDE {
        return opener.count == closer.count;
    }
    !violates_rule_of_three(opener, closer)
}

/// Closer classes: marker, whether the closer can open, and its length modulo 3; tildes by length.
const OPENER_CLASSES: usize = 14;

fn closer_class(closer: &Run) -> usize {
    if closer.marker == TILDE {
        return 12 + closer.count - 1;
    }
    let kind = if closer.marker == UNDERSCORE { 6 } else { 0 };
    kind + if closer.can_open { 3 } else { 0 } + closer.count % 3
}

fn marker_classes(marker: u16) -> std::ops::Range<usize> {
    match marker {
        TILDE => 12..14,
        UNDERSCORE => 6..12,
        _ => 0..6,
    }
}

fn clamp_bottoms(bottoms: &mut [usize], length: usize) {
    for b in bottoms.iter_mut() {
        *b = (*b).min(length);
    }
}

/// Matches one closer against the openers on the stack; `bottoms` per class records the lowest
/// opener a search of that class has proven can't match.
fn match_closer(runs: &mut [Run], stack: &mut Vec<usize>, floor: usize, bottoms: &mut [usize], closer: usize, pairs: &mut Vec<Pair>) {
    while runs[closer].count > 0 {
        let class = closer_class(&runs[closer]);
        let limit = floor.max(bottoms[class]);
        let mut found = None;
        for at in (limit..stack.len()).rev() {
            if can_match(&runs[stack[at]], &runs[closer]) {
                found = Some(at);
                break;
            }
        }
        let Some(at) = found else {
            bottoms[class] = stack.len();
            return;
        };
        let opener = stack[at];
        let used = if runs[closer].marker == TILDE {
            runs[closer].count
        } else if runs[opener].count >= 2 && runs[closer].count >= 2 {
            2
        } else {
            1
        };
        runs[opener].count -= used;
        runs[closer].count -= used;
        runs[opener].pairs_opened += 1;
        runs[closer].pairs_closed += 1;
        runs[closer].closes_partially = runs[opener].count > 0;
        pairs.push(Pair { opener, closer, used });
        if runs[opener].count > 0 {
            // The opener's new length can match a class that already skipped it
            for class in marker_classes(runs[opener].marker) {
                bottoms[class] = bottoms[class].min(at);
            }
            stack.truncate(at + 1);
        } else {
            stack.truncate(at);
        }
        clamp_bottoms(bottoms, stack.len());
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Pass {
    Attention,
    Tilde,
}

fn in_pass(run: &Run, pass: Pass) -> bool {
    (run.marker == TILDE) == (pass == Pass::Tilde)
}

/// One pass over a scope's runs; pairs an earlier pass matched wall off the runs between them.
fn match_pass(runs: &mut [Run], scoped: &[usize], pass: Pass, pairs: &mut Vec<Pair>) -> Vec<usize> {
    let mut stack = Vec::new();
    let mut floors: Vec<usize> = Vec::new();
    let mut bounds: Vec<Vec<usize>> = vec![vec![0; OPENER_CLASSES]];
    for &r in scoped {
        if !in_pass(&runs[r], pass) {
            for _ in 0..runs[r].pairs_closed {
                stack.truncate(floors.pop().unwrap_or(0));
                bounds.pop();
                if let Some(b) = bounds.last_mut() {
                    clamp_bottoms(b, stack.len());
                }
            }
            for _ in 0..runs[r].pairs_opened {
                floors.push(stack.len());
                bounds.push(vec![stack.len(); OPENER_CLASSES]);
            }
            continue;
        }
        if runs[r].can_close {
            let floor = floors.last().copied().unwrap_or(0);
            let mut spare = vec![0; OPENER_CLASSES];
            let bottoms = bounds.last_mut().unwrap_or(&mut spare);
            match_closer(runs, &mut stack, floor, bottoms, r, pairs);
        }
        if runs[r].can_open && runs[r].count > 0 {
            stack.push(r);
        }
    }
    stack
}

/// micromark resolves attention and strikethrough in the order each first appears.
fn pass_order(runs: &[Run]) -> [Pass; 2] {
    match runs.iter().find(|r| r.marker != TILDE || r.length <= 2) {
        Some(r) if r.marker == TILDE => [Pass::Tilde, Pass::Attention],
        _ => [Pass::Attention, Pass::Tilde],
    }
}

fn match_runs(mut runs: Vec<Run>) -> DelimiterMatch {
    let mut scopes: Vec<(Option<usize>, Vec<usize>)> = Vec::new();
    let mut slot: HashMap<Option<usize>, usize> = HashMap::new();
    for (i, run) in runs.iter().enumerate() {
        let s = *slot.entry(run.scope).or_insert_with(|| {
            scopes.push((run.scope, Vec::new()));
            scopes.len() - 1
        });
        scopes[s].1.push(i);
    }
    let mut pairs = Vec::new();
    let passes = pass_order(&runs);
    let mut open = Vec::new();
    for (scope, scoped) in &scopes {
        let mut left = Vec::new();
        for pass in passes {
            left.extend(match_pass(&mut runs, scoped, pass, &mut pairs));
        }
        if scope.is_none() {
            open = left;
        }
    }
    open.sort_by(|&a, &b| runs[b].index.cmp(&runs[a].index));
    DelimiterMatch { literal: runs.iter().map(|r| r.count).sum(), open, pairs, runs }
}

/// Matches the runs of the text's last inline block.
fn match_delimiter_runs(t: &Text) -> DelimiterMatch {
    let scan = Scan::new(t);
    let from = find_inline_block_start(&scan);
    match_runs(collect_delimiter_runs(&scan, from))
}

/// The authored text's runs, reused to match each candidate heal.
struct HealBase<'a> {
    insert_at: usize,
    runs: Vec<Run>,
    /// Whether closers would land where runs aren't collected.
    slow: bool,
    text: &'a Text,
}

fn prepare_heal(text: &Text, insert_at: usize) -> HealBase<'_> {
    let scan = Scan::new(text);
    let from = find_inline_block_start(&scan);
    let slow = from > insert_at
        || (insert_at > 0
            && (scan.in_html_tag_at(insert_at - 1)
                || scan.in_math_at(insert_at as isize - 1, false)
                || scan.is_fence_at(insert_at - 1)));
    HealBase { insert_at, runs: collect_delimiter_runs(&scan, from), slow, text }
}

/// The match after inserting `closers`; only the runs beside the insertion point are rebuilt.
fn match_healed(base: &HealBase, closers: &[u16]) -> DelimiterMatch {
    let (insert_at, text) = (base.insert_at, base.text);
    if base.slow {
        return match_delimiter_runs(&concat(&[&text[..insert_at], closers, &text[insert_at..]]));
    }
    let mut runs: Vec<Run> = base
        .runs
        .iter()
        .map(|r| Run { closes_partially: false, count: r.length, pairs_closed: 0, pairs_opened: 0, ..r.clone() })
        .collect();
    let after = char_at(text, insert_at);
    let char_after = |i: usize| if i < closers.len() { Some(closers[i] as u32) } else { after };
    let mut start = 0;
    if let Some(last) = runs.last_mut()
        && last.scope.is_none()
        && last.index + last.length == insert_at
    {
        while at(closers, start) == last.marker {
            start += 1;
        }
        last.length += start;
        last.count = last.length;
        last.next = char_after(start);
        apply_flanking(last);
    }
    while start < closers.len() {
        let mut end = start + 1;
        while at(closers, end) == closers[start] {
            end += 1;
        }
        let prev = if start == 0 { char_before(text, insert_at) } else { Some(closers[start - 1] as u32) };
        runs.push(create_run(closers[start], insert_at + start, end - start, prev, char_after(end), None));
        start = end;
    }
    match_runs(runs)
}

/// A pair's kind: its marker, and for `*` and `_` how many markers it used.
fn kind_of(m: &DelimiterMatch, pair: &Pair) -> (u16, usize) {
    let marker = m.runs[pair.opener].marker;
    (marker, if marker == TILDE { 0 } else { pair.used })
}

/// Each pair's parent: the innermost pair whose opener comes strictly before its own and whose
/// closer isn't before its own.
fn parents_of(m: &DelimiterMatch) -> Vec<Option<usize>> {
    let index = |p: usize, closer: bool| {
        let pair = &m.pairs[p];
        m.runs[if closer { pair.closer } else { pair.opener }].index
    };
    let mut sorted: Vec<usize> = (0..m.pairs.len()).collect();
    sorted.sort_by(|&a, &b| index(a, false).cmp(&index(b, false)).then(index(b, true).cmp(&index(a, true))));
    let mut parents = vec![None; m.pairs.len()];
    let mut stack: Vec<usize> = Vec::new();
    for p in sorted {
        while stack.last().is_some_and(|&top| index(top, true) < index(p, true)) {
            stack.pop();
        }
        let top = stack.last().copied();
        let shares_opener = top.is_some_and(|top| index(top, false) == index(p, false));
        parents[p] = if shares_opener { top.and_then(|top| parents[top]) } else { top };
        if !(shares_opener && top.is_some_and(|top| m.pairs[top].closer == m.pairs[p].closer)) {
            stack.push(p);
        }
    }
    parents
}

/// An authored pair whose opener follows punctuation, as in **注意：**这是, is usually a closer
/// that failed flanking.
fn opens_after_punctuation(opener: &Run) -> bool {
    is_punctuation_char(opener.prev) && !is_space_or_edge(opener.next) && !is_punctuation_char(opener.next)
}

/// Whether a heal nests emphasis directly inside the same emphasis, which authors don't write.
fn nests_same_kind(m: &DelimiterMatch, insert_at: usize) -> bool {
    let healed = |p: &Pair| m.runs[p.closer].index + m.runs[p.closer].length > insert_at;
    let parents = parents_of(m);
    m.pairs.iter().enumerate().any(|(i, pair)| {
        parents[i].is_some_and(|parent| {
            let parent = &m.pairs[parent];
            kind_of(m, parent) == kind_of(m, pair)
                && (healed(pair) || (healed(parent) && !opens_after_punctuation(&m.runs[pair.opener])))
        })
    })
}

/// Whether closers would sit alone on their line, making a thematic break or a fence.
fn leaves_line_bare(base: &HealBase) -> bool {
    let line_start = last_index_of(base.text, &[u('\n')], base.insert_at as isize - 1).map_or(0, |p| p + 1);
    let prefix = skip_container_prefix(base.text, line_start, base.insert_at);
    !slice(base.text, prefix.content_start, base.insert_at)
        .iter()
        .any(|&c| !is_space_unit(c) && c != STAR && c != UNDERSCORE && c != TILDE)
}

/// The healed text's literal marker count, or none when the heal left a target open, left a
/// marker it added literal, changed another run, nested the same emphasis, or closed fewer
/// literal markers than it added.
fn literal_after_heal(
    before: &DelimiterMatch,
    literal_before: usize,
    base: &HealBase,
    closers: &[u16],
    targets: &HashSet<usize>,
) -> Option<usize> {
    if leaves_line_bare(base) {
        return None;
    }
    let after = match_healed(base, closers);
    if after.literal as isize > literal_before as isize - closers.len() as isize {
        return None;
    }
    let count_before: HashMap<usize, usize> = before.runs.iter().map(|r| (r.index, r.count)).collect();
    let only_targets = after.runs.iter().all(|r| {
        if targets.contains(&r.index) || r.index + r.length > base.insert_at {
            return r.count == 0;
        }
        r.count == count_before.get(&r.index).copied().unwrap_or(0)
    });
    (only_targets && !nests_same_kind(&after, base.insert_at)).then_some(after.literal)
}

// ---- Emphasis: choosing the closers ----

/// Closers go before trailing whitespace, and before a trailing backslash that would escape them.
fn find_insertion_point(t: &Text) -> usize {
    let mut end = t.len();
    while end > 0 && is_space_unit(t[end - 1]) {
        end -= 1;
    }
    if end > 0 && t[end - 1] == u('\\') && !is_escaped(t, end - 1) { end - 1 } else { end }
}

/// Lookups the opener gates share.
struct Gates {
    /// The opener each closer first closed, by the closer's index.
    first_closed_by: HashMap<usize, usize>,
    /// The last character that isn't whitespace or a marker before the insertion point.
    last_content: isize,
    /// Each run's previous run (marker, index, length), by index.
    previous_run: HashMap<usize, (u16, usize, usize)>,
}

fn prepare_gates(t: &Text, insert_at: usize, m: &DelimiterMatch) -> Gates {
    let mut last_content = insert_at as isize - 1;
    while last_content >= 0 && is_space_or_marker(t[last_content as usize]) {
        last_content -= 1;
    }
    let previous_run = m.runs.windows(2).map(|w| (w[1].index, (w[0].marker, w[0].index, w[0].length))).collect();
    let mut first_closed_by = HashMap::new();
    for pair in &m.pairs {
        first_closed_by.entry(m.runs[pair.closer].index).or_insert(m.runs[pair.opener].index);
    }
    Gates { first_closed_by, last_content, previous_run }
}

/// An asterisk after an ASCII letter or digit opens only to continue a chain of emphasis in that
/// word, so hello*world and 2**3 stay literal while languages written without spaces still heal.
fn opens_cold_in_word(t: &Text, run: &Run, gates: &Gates) -> bool {
    let after = run.index + run.length;
    if !(run.marker == STAR && is_ascii_alnum(prev(t, run.index)) && char_at(t, after).is_some_and(is_letter_or_number)) {
        return false;
    }
    let Some(&(marker, index, length)) = gates.previous_run.get(&run.index) else { return true };
    if !(marker == STAR && slice(t, index + length, run.index).iter().all(|&c| is_ascii_alnum(c))) {
        return true;
    }
    gates.first_closed_by.get(&index).is_some_and(|&closed| is_ascii_alnum(prev(t, closed)))
}

/// Emphasis doesn't start with closing punctuation, so the * in (+, -, *, /) is a symbol.
fn opens_before_closing_punctuation(t: &Text, run: &Run) -> bool {
    let before = if run.index == 0 { u(' ') } else { t[run.index - 1] };
    let after = at(t, run.index + run.length);
    is_space_unit(before) && (after == u(',') || after == u(';'))
}

/// `\**` is usually a literal ** with a sloppy escape.
fn follows_escaped_marker(t: &Text, run: &Run) -> bool {
    run.index > 0 && t[run.index - 1] == run.marker && is_escaped(t, run.index - 1)
}

/// Whether the opener's line already ended, which usually means code outside a fence.
fn line_ended(t: &Text, run: &Run) -> bool {
    index_of_unit(t, '\n', run.index + run.length).is_some_and(|newline| t[newline..].iter().any(|&c| !is_space_unit(c)))
}

fn is_gated(t: &Text, run: &Run, gates: &Gates) -> bool {
    (run.index + run.length) as isize > gates.last_content
        // Prose uses a single tilde for "approximately"
        || (run.marker == TILDE && run.count == 1)
        // Fill-in blanks, like Name: ______
        || (run.marker == UNDERSCORE && run.length >= 4)
        || opens_cold_in_word(t, run, gates)
        || opens_before_closing_punctuation(t, run)
        || follows_escaped_marker(t, run)
}

struct HealContext<'a> {
    base: &'a HealBase<'a>,
    gates: Gates,
    insert_at: usize,
    literal: usize,
    matched: &'a DelimiterMatch,
    text: &'a Text,
    /// The authored run the first closer would extend.
    trailing: Option<Run>,
}

/// More open runs than nesting plausibly reaches means the markers are literal text.
const MAX_OPEN_RUNS: usize = 4;

/// A longer run is a divider or filler, not emphasis being typed.
const MAX_DELIMITER_RUN: usize = 16;

/// How many delimiter runs one text's heal may rematch before its markers count as literal.
const MAX_HEAL_WORK: isize = 250_000;

#[derive(Clone)]
struct Heal {
    closers: Vec<u16>,
    literal: usize,
    targets: Vec<usize>,
}

/// Charges one rematch of the block; false once the budget is spent.
fn spend(budget: &mut isize, context: &HealContext) -> bool {
    *budget -= context.base.runs.len() as isize + 1;
    *budget >= 0
}

/// The candidate that leaves the fewest markers literal.
fn best_candidate(context: &HealContext, budget: &mut isize, heal: &Heal, targets: Vec<usize>, candidates: &[Vec<u16>]) -> Option<Heal> {
    let target_set: HashSet<usize> = targets.iter().copied().collect();
    let mut found: Option<Heal> = None;
    for candidate in candidates {
        if !spend(budget, context) {
            return None;
        }
        let closers = concat(&[&heal.closers, candidate]);
        let literal = literal_after_heal(context.matched, context.literal, context.base, &closers, &target_set);
        if let Some(literal) = literal
            && found.as_ref().is_none_or(|f| literal < f.literal)
        {
            found = Some(Heal { closers, literal, targets: targets.clone() });
        }
    }
    found
}

/// Closers for a group of open runs, innermost first, where up to `reusable` markers of the first
/// closer come from a literal run already in the text; none when the group is too long.
fn closer_candidates(group: &[Run], reusable: usize) -> Option<Vec<Vec<u16>>> {
    let first = &group[0];
    let mut own = repeat(first.marker, first.count - reusable);
    let mut uniform = true;
    for run in &group[1..] {
        own.extend(repeat(run.marker, run.count));
        uniform &= run.marker == first.marker;
    }
    if own.len() > MAX_DELIMITER_RUN {
        return None;
    }
    // Closers for openers of one marker merge into a single run
    if uniform {
        return Some((0..own.len() + reusable + 2).map(|i| repeat(first.marker, i + 1)).collect());
    }
    Some((0..=reusable).map(|i| concat(&[&repeat(first.marker, i), &own])).collect())
}

/// Two open runs of one kind are literal text, like globs; only double `*` or `_` runs pair off.
fn without_duplicates(runs: &[Run]) -> Option<Vec<Run>> {
    let mut kinds: Vec<((u16, usize), Vec<&Run>)> = Vec::new();
    for run in runs {
        let kind = (run.marker, run.count);
        match kinds.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, group)) => group.push(run),
            None => kinds.push((kind, vec![run])),
        }
    }
    if kinds.len() > 1 && kinds.len() < runs.len() {
        return None;
    }
    let mut healable = HashSet::new();
    for (_, group) in &kinds {
        if group.len() > 1 && (group[0].count == 1 || group[0].marker == TILDE) {
            return None;
        }
        if group.len() % 2 == 1 {
            let last = group.iter().fold(group[0], |last, &run| if run.index > last.index { run } else { last });
            healable.insert(last.index);
        }
    }
    Some(runs.iter().filter(|r| healable.contains(&r.index)).cloned().collect())
}

/// Closes the open runs, trying every subset since closing one can strand another.
fn extend_heal(context: &HealContext, start: &Heal, open: &[Run], budget: &mut isize) -> Option<Heal> {
    let text = context.text;
    let mut runs = Vec::new();
    for run in open {
        if run.length > MAX_DELIMITER_RUN || is_gated(text, run, &context.gates) {
            continue;
        }
        runs.push(run.clone());
        if runs.len() > MAX_OPEN_RUNS {
            return Some(start.clone());
        }
    }
    // Openers on ended lines still count as duplicates
    let Some(healable) = without_duplicates(&runs) else { return Some(start.clone()) };
    let healable: Vec<Run> = healable.into_iter().filter(|r| !line_ended(text, r)).collect();

    // None when the search ran past its budget; false when nothing closed
    let try_group = |heal: &mut Heal, group: &[Run], budget: &mut isize| -> Option<bool> {
        let first = &group[0];
        let targets: Vec<usize> = heal.targets.iter().copied().chain(group.iter().map(|r| r.index)).collect();
        let reusable = match &context.trailing {
            Some(trailing) if heal.closers.is_empty() && trailing.marker == first.marker => trailing.count.min(first.count - 1),
            _ => 0,
        };
        let Some(candidates) = closer_candidates(group, reusable) else { return Some(false) };
        let found = best_candidate(context, budget, heal, targets, &candidates);
        if found.is_none() && *budget < 0 {
            return None;
        }
        let closed = found.is_some();
        if let Some(found) = found {
            *heal = found;
        }
        Some(closed)
    };

    let close_all = |chosen: &[Run], budget: &mut isize| -> Option<Heal> {
        let mut heal = start.clone();
        for i in 0..chosen.len() {
            if i < chosen.len() - 1 && try_group(&mut heal, &chosen[i..], budget)? {
                break;
            }
            try_group(&mut heal, std::slice::from_ref(&chosen[i]), budget)?;
        }
        Some(heal)
    };

    // Largest subsets first, so a tie keeps the heal that closes more runs
    let mut subsets: Vec<Vec<Run>> = vec![Vec::new()];
    for run in &healable {
        let grown: Vec<Vec<Run>> = subsets.iter().map(|s| concat_runs(s, run)).collect();
        subsets.extend(grown);
    }
    subsets.reverse();
    let mut best = start.clone();
    for subset in subsets.iter().filter(|s| !s.is_empty()) {
        let heal = close_all(subset, budget)?;
        if heal.literal < best.literal {
            best = heal;
        }
    }
    Some(best)
}

fn concat_runs(set: &[Run], run: &Run) -> Vec<Run> {
    let mut grown = set.to_vec();
    grown.push(run.clone());
    grown
}

/// Heals, then repeats while closers change how authored runs flank and leave one open.
fn heal_from(context: &HealContext, open: &[Run], budget: &mut isize, targets: Vec<usize>) -> Option<Heal> {
    let start = Heal { closers: Vec::new(), literal: context.literal, targets };
    let mut heal = extend_heal(context, &start, open, budget);
    while let Some(current) = &heal
        && !current.closers.is_empty()
    {
        if !spend(budget, context) {
            return None;
        }
        let reopened: Vec<Run> = match_healed(context.base, &current.closers)
            .open_runs()
            .into_iter()
            .filter(|r| r.index < context.insert_at)
            .collect();
        let next = extend_heal(context, current, &reopened, budget);
        let done = next.as_ref().is_none_or(|n| n.closers == current.closers);
        heal = next;
        if done {
            break;
        }
    }
    heal
}

fn heal_emphasis(text: &Text) -> Vec<u16> {
    let insert_at = find_insertion_point(text);
    let matched = match_delimiter_runs(text);
    let trailing = matched.runs.last().filter(|last| last.index + last.length == insert_at).cloned();
    let base = prepare_heal(text, insert_at);
    let context = HealContext {
        base: &base,
        gates: prepare_gates(text, insert_at, &matched),
        insert_at,
        literal: matched.literal,
        matched: &matched,
        text,
        trailing: trailing.clone(),
    };
    let mut budget = MAX_HEAL_WORK;
    let mut heal = heal_from(&context, &matched.open_runs(), &mut budget, Vec::new());

    // A trailing run that closes something may instead be literal text, with the runs open
    // before it still needing closers
    if let Some(trailing) = trailing
        && trailing.count < trailing.length
    {
        let prefix = match_delimiter_runs(&text[..trailing.index]);
        let as_text = Run { count: trailing.length, ..trailing.clone() };
        let streaming = trailing.count > 0 || trailing.closes_partially;
        let mut alternate = prefix.clone();
        alternate.runs.push(as_text.clone());
        let alternate_context = HealContext {
            base: &base,
            gates: prepare_gates(text, insert_at, &alternate),
            insert_at,
            literal: prefix.literal + as_text.count,
            matched: &alternate,
            text,
            trailing: Some(as_text),
        };
        let targets = if streaming { Vec::new() } else { vec![trailing.index] };
        let Some(alternative) = heal_from(&alternate_context, &prefix.open_runs(), &mut budget, targets) else {
            return text.to_vec();
        };
        // Reading the trailing run as text must not re-pair spans the author already closed
        let targets: HashSet<usize> = alternative.targets.iter().copied().collect();
        let healed = match_healed(&base, &alternative.closers);
        let count_before: HashMap<usize, usize> = matched.runs.iter().map(|r| (r.index, r.count)).collect();
        let keeps_authored_runs = healed.runs.iter().all(|r| {
            r.index >= trailing.index || targets.contains(&r.index) || count_before.get(&r.index) == Some(&r.count)
        });
        if heal.as_ref().is_some_and(|h| alternative.literal < h.literal) && keeps_authored_runs {
            heal = Some(alternative);
        }
    }

    // A search past the budget means the markers are literal text
    match heal {
        Some(heal) if !heal.closers.is_empty() => concat(&[&text[..insert_at], &heal.closers, &text[insert_at..]]),
        _ => text.to_vec(),
    }
}

/// Closes unclosed `*`, `_` and `~~` emphasis, after the code span it ends in, if any.
fn heal_emphasis_with_code(t: &Text) -> Vec<u16> {
    if Scan::new(t).open_span.is_none() {
        return heal_emphasis(t);
    }
    // Emphasis closers must land after the code span closes, so close it first and keep that
    // only when emphasis needed healing too
    let closed = close_inline_code(t);
    if closed != t {
        let healed = heal_emphasis(&closed);
        return if healed == closed { t.to_vec() } else { healed };
    }
    // A closer that breaks up a trailing backtick run would let the span close after it
    let healed = heal_emphasis(t);
    if close_inline_code(&healed) == healed { healed } else { t.to_vec() }
}
