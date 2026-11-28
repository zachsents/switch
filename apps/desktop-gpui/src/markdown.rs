//! An agent's words as Markdown (the desktop's `markdown.tsx`, `link.tsx`, `cite.tsx`, `code.tsx`,
//! `inline-image.tsx`), read as Streamdown reads them: CommonMark with GitHub's tables,
//! strikethrough, task lists and bare addresses as links (pulldown-cmark, linkify), raw HTML let
//! through as rehype-sanitize's GitHub schema lets it (ammonia, read back with scraper), and drawn
//! as the house draws them — paragraphs apart, lists with their markers in ink3, headings a weight
//! up, links in ink underlined in ink3, code in mono (a click copies it: inline, its words; in a
//! block, the whole block), quotes on a rule, tables on the grid, pictures at a set height (a click
//! opens the words' pictures full screen at it, `viewer.rs`), `details` that open and shut. A link to another space's exchange
//! (`switch://space/…`) is a chip that opens that space; a page here (`switchboard://…`) opens in
//! this window; a link to a bare id becomes one to that record; any other link opens in the
//! browser. Math (`$…$` in the words, `$$…$$` on its own) is drawn as it is on every surface
//! (math.rs); mermaid stays its text. Every run of words selects as a page's (select.rs), a
//! formula copied as its TeX. A message is read once (`Doc::of`) and drawn from that each frame.

use std::ops::Range;
use std::rc::Rc;
use std::sync::LazyLock;

use gpui::{
    AnyElement, App, ClipboardItem, Font, FontFeatures, FontStyle, FontWeight, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, StrikethroughStyle, Styled, TextRun, UnderlineStyle,
    Window, div, img, prelude::*, px,
};

use crate::look::{Look, MONO, SANS, u};
use crate::select::{Sel, SelText};

#[derive(Clone, Debug, Default)]
struct Span {
    range: Range<usize>,
    bold: bool,
    italic: bool,
    /// `code`: mono on the page's background, copied on a click.
    code: bool,
    /// `kbd`, `samp`, `tt`: mono alone.
    mono: bool,
    strike: bool,
    /// `ins`.
    underline: bool,
    link: Option<String>,
    /// A link whose address the sanitizer took: it still looks one.
    linkish: bool,
    /// A picture's words in its place (its address empty or taken): dimmed.
    dim: bool,
}

/// A run of words with their styles.
#[derive(Clone, Debug, Default)]
pub struct Inline {
    text: String,
    spans: Vec<Span>,
}

#[derive(Clone, Debug)]
enum Block {
    Para(Inline),
    /// Words straight in a container (a tight list's item, a `div`): no space around them.
    Plain(Inline),
    /// Its level (1 to 6), its words, and what's in it past words (a picture), under them.
    Heading(u8, Inline, Vec<Block>),
    List { start: Option<u64>, items: Vec<Vec<Block>> },
    /// A task's box, checked or not, before its words.
    Task(bool, Inline, Vec<Block>),
    Code(String),
    Quote(Vec<Block>),
    Rule,
    Table { cols: usize, head: Vec<Cell>, rows: Vec<Vec<Cell>> },
    Image { src: String, alt: String },
    /// A `div`, `section`, `dl` or `dd`: its blocks, no space of its own.
    Group(Vec<Block>),
    /// A block at the top that no component of the desktop's styles (raw HTML's `div`, `section`,
    /// `dl`, `details`): Streamdown's `space-y-4` puts 16 px under it.
    Spaced(Box<Block>),
    /// `details`: its summary, a click opening or shutting what's under it.
    Details { open: bool, summary: Rich, body: Vec<Block> },
}

/// Words where only words are drawn (a heading, a cell, a task, a summary), and what else is in
/// them, its pictures among it, drawn under the words rather than dropped.
type Rich = (Inline, Vec<Block>);

/// A table's cell: its words, how many columns and rows it spans, and its alignment.
#[derive(Clone, Debug)]
struct Cell {
    rich: Rich,
    span: (u16, u16),
    align: Alignment,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Alignment {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, Default)]
pub struct Doc {
    blocks: Vec<Block>,
    /// Its formulas, each a character in the words standing in for it (`math::tokened`).
    formulas: Vec<crate::math::Formula>,
}

#[derive(Clone, Default)]
struct Style {
    bold: bool,
    italic: bool,
    code: bool,
    mono: bool,
    strike: bool,
    underline: bool,
    link: Option<String>,
    linkish: bool,
    dim: bool,
    /// Inside `pre`: whitespace kept.
    pre: bool,
    sup: bool,
    sub: bool,
}

/// Superscript and subscript forms, for `sup` and `sub`: gpui sets one size and baseline a run.
fn shifted(text: &str, up: bool) -> Option<String> {
    const SUP: (&str, &str) = ("0123456789+-=()in", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ");
    const SUB: (&str, &str) = ("0123456789+-=()aeoxhklmnpst", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ");
    let (from, to) = if up { SUP } else { SUB };
    let to: Vec<char> = to.chars().collect();
    text.chars().map(|c| from.chars().position(|f| f == c).map(|i| to[i])).collect()
}

impl Inline {
    fn push(&mut self, text: &str, st: &Style) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        self.spans.push(Span {
            range: start..self.text.len(),
            bold: st.bold,
            italic: st.italic,
            code: st.code,
            mono: st.mono,
            strike: st.strike,
            underline: st.underline,
            link: st.link.clone(),
            linkish: st.linkish,
            dim: st.dim,
        });
    }

    /// Words as HTML lays them out (runs of whitespace one space), their bare addresses made links
    /// (remark-gfm's autolink literals).
    fn push_text(&mut self, text: &str, st: &Style) {
        let text: String = if st.pre {
            text.to_string()
        } else {
            let mut out = String::with_capacity(text.len());
            let mut space = self.text.ends_with([' ', '\n']) || self.text.is_empty();
            for c in text.chars() {
                if c.is_whitespace() {
                    if !space {
                        out.push(' ');
                    }
                    space = true;
                } else {
                    out.push(c);
                    space = false;
                }
            }
            out
        };
        let text = if st.sup || st.sub { shifted(&text, st.sup).unwrap_or(text) } else { text };
        self.push(&text, st);
    }

    /// Without the space HTML leaves at its ends.
    fn trimmed(mut self) -> Self {
        let lead = self.text.len() - self.text.trim_start().len();
        let keep = self.text.trim().len();
        if lead == 0 && keep == self.text.len() {
            return self;
        }
        self.text = self.text[lead..lead + keep].to_string();
        self.spans = self
            .spans
            .into_iter()
            .filter_map(|mut s| {
                let a = s.range.start.saturating_sub(lead).min(keep);
                let b = s.range.end.saturating_sub(lead).min(keep);
                s.range = a..b;
                (b > a).then_some(s)
            })
            .collect();
        self
    }

    fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

/// A link to a bare id (`[the ask](i-…)`), not a URL.
static BARE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^\w[\w.:-]*$").expect("bare"));
static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^(?:https?|mailto|tel|switch|switchboard|data|blob):").expect("scheme"));

/// A link to one of Switch's own records by its bare id becomes a page here.
fn record_link(href: &str) -> String {
    if BARE.is_match(href) && !SCHEME.is_match(href) {
        format!("switchboard://id/{}", urlencoding(href))
    } else {
        href.to_string()
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

const CITE: &str = "switch://space/";

/// The space a citation link opens, or none for any other link.
pub fn cited_space(href: &str) -> Option<String> {
    let rest = href.strip_prefix(CITE)?;
    let id = rest.split(['?', '#']).next().unwrap_or_default();
    // `decodeURIComponent`: `%xx` only, a `+` kept.
    let id = percent_encoding::percent_decode_str(id).decode_utf8_lossy().to_string();
    (!id.is_empty()).then_some(id)
}

/// What raw HTML in the words may be, as rehype-sanitize's default (GitHub's) schema lets it
/// through Streamdown, with `tel:` (Streamdown's), links here (`switchboard:`) and citations
/// (`switch:`) besides.
static CLEAN: LazyLock<ammonia::Builder<'static>> = LazyLock::new(cleaner);

/// A document's, the same with its pictures' bytes in place (`data:`, an EPUB's or a DOCX's), never
/// a link's.
static CLEAN_READING: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let mut b = cleaner();
    b.add_url_schemes(["data"]).attribute_filter(|element, attribute, value| {
        if attribute == "href" && element == "a" && value.trim_start().to_ascii_lowercase().starts_with("data:") { None } else { Some(value.into()) }
    });
    b
});

fn cleaner() -> ammonia::Builder<'static> {
    let tags = [
        "a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "source", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "ul", "var",
    ];
    let mut b = ammonia::Builder::default();
    b.tags(tags.into_iter().collect())
        .tag_attributes(
            [
                ("a", ["href"].into_iter().collect()),
                ("img", ["src", "alt"].into_iter().collect()),
                ("input", ["type", "checked", "disabled"].into_iter().collect()),
                ("ol", ["start"].into_iter().collect()),
                // `style`: pulldown-cmark writes a column's alignment there (`text-align`); only
                // that is read from it.
                ("td", ["align", "colspan", "rowspan", "style"].into_iter().collect()),
                ("th", ["align", "colspan", "rowspan", "style"].into_iter().collect()),
                ("details", ["open"].into_iter().collect()),
                ("source", ["srcset"].into_iter().collect()),
            ]
            .into_iter()
            .collect(),
        )
        .generic_attributes(std::collections::HashSet::new())
        .url_schemes(["http", "https", "mailto", "xmpp", "irc", "ircs", "tel", "switchboard", "switch"].into_iter().collect())
        .link_rel(None)
        .clean_content_tags(["script", "style"].into_iter().collect());
    b
}

/// Builds blocks from the sanitized page, as Streamdown's components draw its elements.
struct Reader {
    blocks: Vec<Block>,
    words: Inline,
    /// What a run of words between blocks becomes: a paragraph's, or plain in a container.
    paragraph: bool,
}

type Node<'a> = ego_tree::NodeRef<'a, scraper::Node>;

fn tag<'a>(n: &Node<'a>) -> Option<&'a str> {
    n.value().as_element().map(|e| e.name())
}

fn attr<'a>(n: &Node<'a>, name: &str) -> Option<&'a str> {
    n.value().as_element().and_then(|e| e.attr(name))
}

fn text_of(n: &Node) -> String {
    n.descendants().filter_map(|d| d.value().as_text().map(|t| t.to_string())).collect()
}

fn is_block(t: &str) -> bool {
    matches!(t, "p" | "div" | "section" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "blockquote" | "pre" | "table" | "hr" | "details" | "dl" | "dt" | "dd" | "summary" | "li")
}

/// A container's blocks: its block children, and its words between them.
fn blocks_in(n: &Node, paragraph: bool) -> Vec<Block> {
    let mut r = Reader { blocks: vec![], words: Inline::default(), paragraph };
    for c in n.children() {
        r.node(&c, &Style::default());
    }
    r.flush();
    r.blocks
}

/// A node's words, and what's in it besides.
fn inline_of(n: &Node, st: &Style) -> Rich {
    inline_of_all(n.children(), st)
}

fn inline_of_all<'a>(kids: impl Iterator<Item = Node<'a>>, st: &Style) -> Rich {
    let mut r = Reader { blocks: vec![], words: Inline::default(), paragraph: false };
    for c in kids {
        r.inline(&c, st);
    }
    if r.blocks.is_empty() {
        return (r.words.trimmed(), vec![]);
    }
    r.flush();
    let mut more = r.blocks;
    let words = match more.first() {
        Some(Block::Plain(_)) => match more.remove(0) {
            Block::Plain(w) => w,
            _ => Inline::default(),
        },
        _ => Inline::default(),
    };
    (words, more)
}

fn align_of(n: &Node) -> Alignment {
    let styled = attr(n, "style").and_then(|st| st.split(';').find_map(|d| d.split_once(':').filter(|(k, _)| k.trim() == "text-align").map(|(_, v)| v.trim())));
    match attr(n, "align").or(styled) {
        Some("left") => Alignment::Left,
        Some("center") => Alignment::Center,
        Some("right") => Alignment::Right,
        _ => Alignment::None,
    }
}

fn image_of(n: &Node) -> Option<Block> {
    let img = n.descendants().find(|d| tag(d) == Some("img"))?;
    let src = attr(&img, "src").filter(|s| !s.is_empty())?.to_string();
    Some(Block::Image { src, alt: attr(&img, "alt").unwrap_or_default().to_string() })
}

impl Reader {
    fn flush(&mut self) {
        let w = std::mem::take(&mut self.words).trimmed();
        if !w.is_empty() {
            self.blocks.push(if self.paragraph { Block::Para(w) } else { Block::Plain(w) });
        }
    }

    fn put(&mut self, b: Block) {
        self.flush();
        self.blocks.push(b);
    }

    fn node(&mut self, n: &Node, st: &Style) {
        let Some(t) = tag(n) else { return self.inline(n, st) };
        if !is_block(t) && t != "img" && t != "picture" {
            return self.inline(n, st);
        }
        match t {
            "p" => {
                self.flush();
                let before = self.paragraph;
                self.paragraph = true;
                for c in n.children() {
                    self.node(&c, st);
                }
                self.flush();
                self.paragraph = before;
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let (w, more) = inline_of(n, st);
                let level = t[1..].parse().unwrap_or(1);
                self.put(Block::Heading(level, w, more));
            }
            "ul" | "ol" => {
                let start = (t == "ol").then(|| attr(n, "start").and_then(|s| s.parse().ok()).unwrap_or(1));
                let items = n
                    .children()
                    .filter(|c| tag(c) == Some("li"))
                    .map(|li| {
                        let check = li.children().find(|c| tag(c) == Some("input") && attr(c, "type") == Some("checkbox"));
                        match check {
                            Some(c) if !li.children().any(|x| tag(&x).is_some_and(is_block)) => {
                                // Its box is drawn; the words are what's after it.
                                let (w, more) = inline_of_all(li.children().filter(|x| tag(x) != Some("input")), &Style::default());
                                vec![Block::Task(attr(&c, "checked").is_some(), w, more)]
                            }
                            _ => blocks_in(&li, false),
                        }
                    })
                    .collect();
                self.put(Block::List { start, items });
            }
            "blockquote" => {
                let inner = blocks_in(n, true);
                self.put(Block::Quote(inner));
            }
            "pre" => {
                let text = text_of(n);
                self.put(Block::Code(text.trim_end_matches('\n').to_string()));
            }
            "hr" => self.put(Block::Rule),
            "table" => {
                let mut head: Vec<Cell> = vec![];
                let mut rows: Vec<Vec<Cell>> = vec![];
                let span = |c: &Node, name: &str| attr(c, name).and_then(|v| v.trim().parse::<u16>().ok()).filter(|v| *v > 0).unwrap_or(1).min(1000);
                for tr in n.descendants().filter(|d| tag(d) == Some("tr")) {
                    let cells: Vec<Cell> = tr
                        .children()
                        .filter(|c| matches!(tag(c), Some("td" | "th")))
                        .map(|c| Cell { rich: inline_of(&c, &Style::default()), span: (span(&c, "colspan"), span(&c, "rowspan")), align: align_of(&c) })
                        .collect();
                    let th = tr.children().filter(|c| matches!(tag(c), Some("td" | "th"))).all(|c| tag(&c) == Some("th"));
                    let in_head = tr.ancestors().any(|a| tag(&a) == Some("thead")) || (head.is_empty() && rows.is_empty() && th);
                    if in_head && head.is_empty() {
                        head = cells;
                    } else {
                        rows.push(cells);
                    }
                }
                let width = |r: &Vec<Cell>| r.iter().map(|c| c.span.0 as usize).sum::<usize>();
                let cols = width(&head).max(rows.iter().map(width).max().unwrap_or(0)).max(1);
                self.put(Block::Table { cols, head, rows });
            }
            "img" | "picture" => match image_of(n) {
                Some(b) => self.put(b),
                None => self.inline(n, st),
            },
            "details" => {
                let summary = n.children().find(|c| tag(c) == Some("summary"));
                let s = summary.map(|s| inline_of(&s, &Style::default())).unwrap_or_else(|| {
                    let mut i = Inline::default();
                    i.push("Details", &Style::default());
                    (i, vec![])
                });
                let mut r = Reader { blocks: vec![], words: Inline::default(), paragraph: false };
                for c in n.children().filter(|c| tag(c) != Some("summary")) {
                    r.node(&c, &Style::default());
                }
                r.flush();
                self.put(Block::Details { open: attr(n, "open").is_some(), summary: s, body: r.blocks });
            }
            "dt" | "summary" => {
                let (w, more) = inline_of(n, st);
                self.put(Block::Plain(w));
                for b in more {
                    self.put(b);
                }
            }
            // div, section, dl, dd, li: their blocks, no space of their own.
            _ => {
                let inner = blocks_in(n, false);
                self.put(Block::Group(inner));
            }
        }
    }

    fn inline(&mut self, n: &Node, st: &Style) {
        match n.value() {
            scraper::Node::Text(t) => self.words.push_text(t, st),
            scraper::Node::Element(e) => {
                let mut s = st.clone();
                match e.name() {
                    "b" | "strong" => s.bold = true,
                    "i" | "em" | "var" => s.italic = true,
                    "code" => s.code = true,
                    "kbd" | "samp" | "tt" => s.mono = true,
                    "del" | "s" | "strike" => s.strike = true,
                    "ins" => s.underline = true,
                    "sup" => s.sup = true,
                    "sub" => s.sub = true,
                    "a" => {
                        s.link = e.attr("href").map(str::to_string);
                        s.linkish = s.link.is_none();
                    }
                    "br" => return self.words.push("\n", st),
                    "q" => {
                        self.words.push("“", st);
                        for c in n.children() {
                            self.inline(&c, st);
                        }
                        return self.words.push("”", st);
                    }
                    "input" => {
                        if e.attr("type") == Some("checkbox") {
                            self.words.push(if e.attr("checked").is_some() { "☑ " } else { "☐ " }, st);
                        }
                        return;
                    }
                    "rp" => return,
                    "rt" => {
                        self.words.push("(", st);
                        for c in n.children() {
                            self.inline(&c, st);
                        }
                        return self.words.push(")", st);
                    }
                    "img" | "picture" => {
                        if let Some(b) = image_of(n) {
                            return self.put(b);
                        }
                        // No address: its words, dimmed, as the desktop's `img` draws it.
                        let alt = n.descendants().find(|d| tag(d) == Some("img")).and_then(|i| attr(&i, "alt")).unwrap_or_default();
                        return self.words.push(alt, &Style { dim: true, ..st.clone() });
                    }
                    t if is_block(t) => return self.node(n, st),
                    _ => {}
                }
                for c in n.children() {
                    self.inline(&c, &s);
                }
            }
            _ => {
                for c in n.children() {
                    self.inline(&c, st);
                }
            }
        }
    }
}

impl Doc {
    /// Its headings at the top (a `div`'s or a `section`'s too), in order: each one's level and words.
    pub fn headings(&self) -> Vec<(u8, String)> {
        fn walk(list: &[Block], out: &mut Vec<(u8, String)>) {
            for b in list {
                match b {
                    Block::Heading(level, w, _) => out.push((*level, w.text.clone())),
                    Block::Group(more) => walk(more, out),
                    Block::Spaced(inner) => walk(std::slice::from_ref(inner.as_ref()), out),
                    _ => {}
                }
            }
        }
        let mut out = vec![];
        walk(&self.blocks, &mut out);
        out
    }

    pub fn of(text: &str) -> Self {
        Self::read(text, &CLEAN)
    }

    /// A document's words: its pictures may be its own bytes.
    pub fn reading(text: &str) -> Self {
        Self::read(text, &CLEAN_READING)
    }

    fn read(text: &str, clean: &ammonia::Builder<'static>) -> Self {
        // Its math held out first, so the Markdown leaves its TeX be; then unfinished Markdown
        // closed, in every message, as Streamdown's `parseIncompleteMarkdown` (its remend, over the
        // whole text).
        let (text, formulas) = crate::math::tokened(text);
        let text = &crate::remend::remend(&text);
        let mut options = pulldown_cmark::Options::empty();
        options.insert(pulldown_cmark::Options::ENABLE_TABLES);
        options.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
        options.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
        options.insert(pulldown_cmark::Options::ENABLE_FOOTNOTES);
        let mut html = String::new();
        // Ids are links before the sanitizer sees them, as the desktop's `recordLinks` comes first:
        // `[x](space:abc)` would lose its href to the sanitizer, its scheme being none it knows.
        // Raw HTML's own links aren't (`recordLinks` runs before the raw HTML is read).
        let events = pulldown_cmark::Parser::new_ext(text, options).map(|e| {
            use pulldown_cmark::{CowStr, Event, Tag};
            match e {
                Event::Start(Tag::Link { link_type, dest_url, title, id }) => Event::Start(Tag::Link { link_type, dest_url: CowStr::from(record_link(&dest_url)), title, id }),
                e => e,
            }
        });
        pulldown_cmark::html::push_html(&mut html, gfm_footnotes(autolinked(events)).into_iter());
        let clean = clean.clean(&html).to_string();
        let page = scraper::Html::parse_fragment(&clean);
        let root = page.root_element();
        let blocks = blocks_in(&root, false)
            .into_iter()
            .map(|b| match b {
                Block::Group(_) | Block::Details { .. } => Block::Spaced(Box::new(b)),
                b => b,
            })
            .collect();
        Doc { blocks, formulas }
    }
}

/// Bare addresses in the Markdown's words made links, as remark-gfm's autolink literals: `http://`,
/// `https://` and `www.` addresses (`www.` as `http://`) and emails, nothing else (`file://` stays
/// words); none in code, a link's own words, a picture's or raw HTML.
fn autolinked<'a>(events: impl Iterator<Item = pulldown_cmark::Event<'a>>) -> Vec<pulldown_cmark::Event<'a>> {
    use pulldown_cmark::{CowStr, Event, LinkType, Tag, TagEnd};
    let mut out = vec![];
    let mut inside = 0usize;
    let mut finder = linkify::LinkFinder::new();
    finder.url_must_have_scheme(false);
    let web = |s: &str| {
        let s = s.to_lowercase();
        s.starts_with("http://") || s.starts_with("https://") || s.starts_with("www.")
    };
    for e in events {
        match &e {
            Event::Start(Tag::Link { .. } | Tag::Image { .. } | Tag::CodeBlock(_)) => inside += 1,
            Event::End(TagEnd::Link | TagEnd::Image | TagEnd::CodeBlock) => inside = inside.saturating_sub(1),
            Event::Text(t) if inside == 0 => {
                let text = t.to_string();
                let mut at = 0;
                for l in finder.links(&text).filter(|l| l.kind() == &linkify::LinkKind::Email || web(l.as_str())) {
                    if l.start() > at {
                        out.push(Event::Text(CowStr::from(text[at..l.start()].to_string())));
                    }
                    let url = match l.kind() {
                        linkify::LinkKind::Email => format!("mailto:{}", l.as_str()),
                        _ if !l.as_str().contains("://") => format!("http://{}", l.as_str()),
                        _ => l.as_str().to_string(),
                    };
                    out.push(Event::Start(Tag::Link { link_type: LinkType::Autolink, dest_url: CowStr::from(url), title: CowStr::from(""), id: CowStr::from("") }));
                    out.push(Event::Text(CowStr::from(l.as_str().to_string())));
                    out.push(Event::End(TagEnd::Link));
                    at = l.end();
                }
                if at > 0 {
                    if at < text.len() {
                        out.push(Event::Text(CowStr::from(text[at..].to_string())));
                    }
                    continue;
                }
            }
            _ => {}
        }
        out.push(e);
    }
    out
}

/// Footnotes laid out as GitHub's (remark-gfm's): each reference a superscript number in the order
/// first referred to, and the notes an ordered list at the end, each with its way back (↩); a
/// note never referred to isn't shown. pulldown-cmark leaves each where it was written.
fn gfm_footnotes(events: Vec<pulldown_cmark::Event<'_>>) -> Vec<pulldown_cmark::Event<'_>> {
    use pulldown_cmark::{CowStr, Event, Tag, TagEnd};
    let mut notes: std::collections::HashMap<String, Vec<Event>> = Default::default();
    let mut body = vec![];
    let mut inside: Option<(String, Vec<Event>)> = None;
    for e in events {
        match (e, &mut inside) {
            (Event::Start(Tag::FootnoteDefinition(label)), _) => inside = Some((label.to_string(), vec![])),
            (Event::End(TagEnd::FootnoteDefinition), _) => {
                if let Some((label, held)) = inside.take() {
                    notes.entry(label).or_insert(held);
                }
            }
            (e, Some((_, held))) => held.push(e),
            (e, None) => body.push(e),
        }
    }
    let mut order: Vec<String> = vec![];
    // How often each note is referred to: its way back is one ↩ each (↩, ↩², …).
    let mut times: Vec<usize> = vec![];
    let body: Vec<Event> = body
        .into_iter()
        .map(|e| match e {
            Event::FootnoteReference(label) => {
                let label = label.to_string();
                let n = match order.iter().position(|l| *l == label) {
                    Some(i) => {
                        times[i] += 1;
                        i + 1
                    }
                    None => {
                        order.push(label);
                        times.push(1);
                        order.len()
                    }
                };
                Event::InlineHtml(CowStr::from(format!("<sup><a href=\"#user-content-fn-{n}\">{n}</a></sup>")))
            }
            e => e,
        })
        .collect();
    let shown: Vec<(usize, Vec<Event>)> = order.iter().enumerate().filter_map(|(i, l)| notes.remove(l).map(|n| (i + 1, n))).collect();
    if shown.is_empty() {
        return body;
    }
    let mut out = body;
    // Its heading, "Footnotes": remark-gfm's `sr-only` h2, which the desktop's own `h2` draws.
    out.push(Event::Html(CowStr::from("<section><h2>Footnotes</h2><ol>")));
    for (n, mut note) in shown {
        out.push(Event::Html(CowStr::from("<li>")));
        // The way back ends its last paragraph: one ↩ for each time it's referred to.
        let backs: Vec<String> = (1..=times[n - 1])
            .map(|k| if k == 1 { format!("<a href=\"#user-content-fnref-{n}\">↩</a>") } else { format!("<a href=\"#user-content-fnref-{n}-{k}\">↩<sup>{k}</sup></a>") })
            .collect();
        let back = Event::InlineHtml(CowStr::from(format!(" {}", backs.join(" "))));
        match note.last() {
            Some(Event::End(TagEnd::Paragraph)) => {
                let at = note.len() - 1;
                note.insert(at, back);
            }
            _ => note.push(back),
        }
        out.extend(note);
        out.push(Event::Html(CowStr::from("</li>")));
    }
    out.push(Event::Html(CowStr::from("</ol></section>")));
    out
}

base::kept_local! {
    /// The `details` opened or shut here, by where they are.
    static OPENED: std::cell::RefCell<std::collections::HashMap<String, bool>> = Default::default();
}

/// What a link's click does: the app opens it or goes to the page it names.
pub type OnLink = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// What a picture's right-click does (the file's menu), by its address and name.
pub type OnPicture = Rc<dyn Fn(&str, &str, bool, &mut Window, &mut App)>;

/// Where a message's words are drawn: the column's selection, its entry's order, the links'.
#[derive(Clone)]
pub struct Ctx {
    pub id: String,
    /// The entry's place in its column, for the selection's order.
    pub order: u64,
    pub sel: Sel,
    pub on_link: OnLink,
    pub on_picture: OnPicture,
    /// Words on a colored bubble are white; on the gray, ink.
    pub ink: Option<gpui::Hsla>,
    /// In a widget's cell (A2UI's Text, `widgets/basic/text.tsx`): each block inset from the cell's
    /// edges as a line's words are, a heading a line of its own, no space between blocks but theirs.
    pub cell: bool,
    /// The words' pictures, in order, full screen from the one clicked (`render` fills them).
    pub pictures: Rc<Vec<crate::viewer::Item>>,
    /// The words' formulas (`render` fills them).
    pub formulas: Rc<Vec<crate::math::Formula>>,
    /// Drawn as a document is read: headings sized by level, room between blocks, and passages
    /// marked.
    pub reading: Option<Rc<Reading>>,
}

/// A passage marked in a run of words: its bytes there, its wash, and what a click on it names.
pub struct Mark {
    pub range: Range<usize>,
    pub wash: gpui::Hsla,
    pub id: Option<String>,
}

/// How a document's words are read: the passages marked in each run (by its key and words), and
/// what a click on one does.
pub struct Reading {
    pub marks: Box<dyn Fn((u64, u32), &str) -> Vec<Mark>>,
    pub on_mark: Rc<dyn Fn(&str, &mut Window, &mut App)>,
    /// What's beside each top block: given its entry's order, its runs' keys, the room above it and
    /// the block, the row it goes in.
    pub margin: Option<Margin>,
    /// Where the named marks' first lines are drawn, once they are.
    pub spots: Option<crate::select::Spots>,
    /// Where its headings are laid out.
    pub heads: Option<Rc<Heads>>,
}

/// Where a document's headings were laid out: by each one's run, its words, its top in the window
/// and the frame (`frame`, moved by the view each time it draws) that laid it out.
#[derive(Default)]
pub struct Heads {
    pub frame: std::cell::Cell<u64>,
    pub at: std::cell::RefCell<std::collections::BTreeMap<(u64, u32), (String, gpui::Pixels, u64)>>,
}

pub type Margin = Box<dyn Fn(u64, Range<u32>, gpui::Rems, AnyElement, &mut Window, &mut App) -> AnyElement>;

/// Runs split where marks start and end, the marked parts washed.
fn washed(runs: Vec<TextRun>, marks: &[Mark]) -> Vec<TextRun> {
    if marks.is_empty() {
        return runs;
    }
    let mut out = vec![];
    let mut at = 0;
    for r in runs {
        let end = at + r.len;
        let mut cuts: Vec<usize> = marks.iter().flat_map(|m| [m.range.start, m.range.end]).filter(|c| *c > at && *c < end).collect();
        cuts.push(end);
        cuts.sort_unstable();
        cuts.dedup();
        let mut from = at;
        for cut in cuts {
            let wash = marks.iter().rev().find(|m| m.range.start <= from && m.range.end >= cut).map(|m| m.wash);
            out.push(TextRun { len: cut - from, background_color: wash.or(r.background_color), ..r.clone() });
            from = cut;
        }
        at = end;
    }
    out
}

/// Every picture in `list`, in order, however deep.
fn pictures_in(list: &[Block], out: &mut Vec<crate::viewer::Item>) {
    for b in list {
        match b {
            Block::Image { src, alt } => out.push(picture_item(src, alt)),
            Block::Heading(_, _, more) | Block::Task(_, _, more) | Block::Quote(more) | Block::Group(more) => pictures_in(more, out),
            Block::Details { summary, body, .. } => {
                pictures_in(&summary.1, out);
                pictures_in(body, out);
            }
            Block::List { items, .. } => items.iter().for_each(|i| pictures_in(i, out)),
            Block::Table { head, rows, .. } => head.iter().chain(rows.iter().flatten()).for_each(|c| pictures_in(&c.rich.1, out)),
            Block::Spaced(inner) => pictures_in(std::slice::from_ref(inner.as_ref()), out),
            Block::Para(_) | Block::Plain(_) | Block::Code(_) | Block::Rule => {}
        }
    }
}

/// A picture's address as the viewer shows it: the core's blob, or a link's.
fn picture_item(src: &str, alt: &str) -> crate::viewer::Item {
    crate::viewer::Item { route: src.to_string(), name: name_of(src, alt), kind: "image/*".into(), blob: crate::files::image_blob(src) }
}

fn font(bold: bool, italic: bool, code: bool) -> Font {
    Font {
        family: SharedString::new_static(if code { MONO } else { SANS }),
        features: FontFeatures::default(),
        fallbacks: None,
        weight: if bold { FontWeight::SEMIBOLD } else { FontWeight::NORMAL },
        style: if italic { FontStyle::Italic } else { FontStyle::Normal },
    }
}

/// A run of words, selectable, its links followed and its code copied on a click.
fn words(w: &Inline, n: &mut u32, cx: &Ctx, l: &Look, bold_all: bool, color: gpui::Hsla) -> AnyElement {
    let mut runs = vec![];
    let mut links = vec![];
    let mut acts: Vec<Act> = vec![];
    let mut at = 0;
    for s in &w.spans {
        if s.range.start > at {
            runs.push(TextRun { len: s.range.start - at, font: font(bold_all, false, false), color, background_color: None, underline: None, strikethrough: None });
        }
        let cite = s.link.as_deref().and_then(cited_space);
        runs.push(TextRun {
            len: s.range.len(),
            font: font(s.bold || bold_all, s.italic, s.code || s.mono),
            color: if cite.is_some() || s.dim { l.ink2 } else { color },
            background_color: (s.code || cite.is_some()).then_some(l.bg),
            underline: match (s.link.is_some() || s.linkish, cite.is_some(), s.underline) {
                // A document's many links underlined faintly, so its paragraphs don't read as stripes.
                (true, false, _) => Some(UnderlineStyle { thickness: px(1.), color: Some(if cx.reading.is_some() { l.line1 } else { l.ink3 }), wavy: false }),
                (_, _, true) => Some(UnderlineStyle { thickness: px(1.), color: Some(color), wavy: false }),
                _ => None,
            },
            strikethrough: s.strike.then_some(StrikethroughStyle { thickness: px(1.), color: Some(color) }),
        });
        if let Some(url) = &s.link {
            links.push(s.range.clone());
            acts.push(Act::Link(url.clone()));
        } else if s.code {
            links.push(s.range.clone());
            acts.push(Act::Copy(w.text[s.range.clone()].to_string()));
        }
        at = s.range.end;
    }
    if at < w.text.len() {
        runs.push(TextRun { len: w.text.len() - at, font: font(bold_all, false, false), color, background_color: None, underline: None, strikethrough: None });
    }
    let key = (cx.order, *n);
    *n += 1;
    let marks = cx.reading.as_ref().map(|r| (r.marks)(key, &w.text)).unwrap_or_default();
    let runs = washed(runs, &marks);
    for m in &marks {
        if let Some(id) = &m.id
            && !links.iter().any(|r: &Range<usize>| r.start < m.range.end && m.range.start < r.end)
        {
            links.push(m.range.clone());
            acts.push(Act::Mark(id.clone()));
        }
    }
    let id = SharedString::from(format!("{}.w{}", cx.id, key.1));
    let math: Vec<_> = w.text.char_indices().filter_map(|(i, c)| crate::math::formula_of(c, &cx.formulas).map(|f| (i, f.clone(), color))).collect();
    let mut text = if math.is_empty() {
        SelText::new(id, key, &cx.sel, SharedString::from(w.text.clone()), Some(runs))
    } else {
        SelText::new(id, key, &cx.sel, SharedString::from(w.text.clone()), Some(runs.clone())).math(math, Some(runs))
    };
    if let Some(to) = cx.reading.as_ref().and_then(|r| r.spots.clone()) {
        // Its second character's place: where a line wraps, its first's can be the line above's end.
        let second = |r: &Range<usize>| w.text.get(r.clone()).and_then(|t| t.chars().next()).map_or(r.start, |c| (r.start + c.len_utf8()).min(r.end));
        let spots: Vec<_> = marks.iter().filter_map(|m| Some((m.id.clone()?, second(&m.range)))).collect();
        if !spots.is_empty() {
            text = text.spots(spots, to);
        }
    }
    if links.is_empty() {
        return text.into_any_element();
    }
    let on_link = cx.on_link.clone();
    let on_mark = cx.reading.as_ref().map(|r| r.on_mark.clone());
    let copies = acts.iter().map(|a| matches!(a, Act::Copy(_))).collect();
    // A published page's link opens in the reader: its own menu, for the browser.
    let pages: Vec<Option<String>> = acts.iter().map(|a| match a {
        Act::Link(url) if crate::links::page_token(url).is_some() => Some(url.clone()),
        _ => None,
    }).collect();
    let text = text.looks(copies, l.hover).links(links, move |i, window, cx| match acts.get(i) {
        Some(Act::Link(url)) => on_link(url, window, cx),
        Some(Act::Copy(words)) => cx.write_to_clipboard(ClipboardItem::new_string(words.clone())),
        Some(Act::Mark(id)) => {
            if let Some(f) = &on_mark {
                f(id, window, cx);
            }
        }
        None => {}
    });
    if pages.iter().all(Option::is_none) {
        return text.into_any_element();
    }
    text.link_menu(Rc::new(move |i, window, cx| match pages.get(i).cloned().flatten() {
        Some(url) => {
            crate::links::page_menu(&url, window, cx);
            true
        }
        None => false,
    }))
    .into_any_element()
}

enum Act {
    Link(String),
    Copy(String),
    /// A marked passage: what it names.
    Mark(String),
}

/// A block's margins above and below, as the house's classes give them (`my-2`, `mt-3 mb-1`, `my-3`).
fn margins(b: &Block, reading: bool) -> (f32, f32) {
    if reading {
        return match b {
            Block::Heading(1 | 2, ..) => (32., 12.),
            Block::Heading(..) => (24., 8.),
            Block::Rule => (24., 24.),
            Block::Para(_) | Block::List { .. } | Block::Code(_) | Block::Quote(_) | Block::Table { .. } | Block::Image { .. } => (14., 14.),
            Block::Plain(_) | Block::Group(_) | Block::Details { .. } | Block::Task(..) => (0., 0.),
            Block::Spaced(inner) => (margins(inner, true).0, 16.),
        };
    }
    match b {
        Block::Heading(..) => (12., 4.),
        Block::Rule => (12., 12.),
        Block::Para(_) | Block::List { .. } | Block::Code(_) | Block::Quote(_) | Block::Table { .. } | Block::Image { .. } => (8., 8.),
        Block::Plain(_) | Block::Group(_) | Block::Details { .. } | Block::Task(..) => (0., 0.),
        Block::Spaced(inner) => (margins(inner, false).0, 16.),
    }
}

fn above((list, i): (&[Block], usize), cx: &Ctx) -> f32 {
    let reading = cx.reading.is_some();
    if cx.cell { 0. } else { i.checked_sub(1).map(|j| margins(&list[j], reading).1.max(margins(&list[i], reading).0)).unwrap_or(0.) }
}

fn blocks(list: &[Block], n: &mut u32, cx: &Ctx, l: &Look, color: gpui::Hsla, window: &mut Window, app: &mut App) -> Vec<AnyElement> {
    (0..list.len()).map(|i| block((list, i), n, cx, l, color, window, app)).collect()
}

/// A block among its siblings (`list` and where in it), drawn.
fn block((list, i): (&[Block], usize), n: &mut u32, cx: &Ctx, l: &Look, color: gpui::Hsla, window: &mut Window, app: &mut App) -> AnyElement {
    let b = &list[i];
    // Margins between blocks collapse, as a page's do: the larger of the two; none at the
    // ends (`first:mt-0 last:mb-0`).
    let above = above((list, i), cx);
    // In a cell, each block's own inset and space (text.tsx's components).
    let inset = |d: gpui::Div| if cx.cell { d.mx(u(8.)).my(u(4.)) } else { d };
    let gap = |d: gpui::Div, _: f32| d.when(above > 0., |d| d.mt(u(above)));
    let first = i == 0;
    let last = i + 1 == list.len();
    match b {
        Block::Para(w) | Block::Plain(w) if crate::math::alone(&w.text, &cx.formulas).is_some() => {
            let shown = math_block(w, n, cx, l, color, window, app);
            inset(gap(div(), 8.)).child(shown).into_any_element()
        }
        Block::Para(w) if cx.cell => div().px(u(8.)).py(u(4.)).child(words(w, n, cx, l, false, color)).into_any_element(),
        Block::Heading(_, w, more) if cx.cell => {
            let more = blocks(more, n, cx, l, color, window, app);
            div().flex().flex_col().child(div().flex().items_center().min_h(u(24.)).px(u(8.)).child(words(w, n, cx, l, true, l.ink))).children(more).into_any_element()
        }
        Block::Rule if cx.cell => div().h(px(l.w2)).bg(l.line2).into_any_element(),
        Block::Para(w) => {
            cx.sel.apart((cx.order, *n));
            gap(div(), 8.).child(words(w, n, cx, l, false, color)).into_any_element()
        }
        Block::Plain(w) => div().child(words(w, n, cx, l, false, color)).into_any_element(),
        Block::Group(inner) => div().flex().flex_col().min_w_0().children(blocks(inner, n, cx, l, color, window, app)).into_any_element(),
        Block::Details { open, summary, body } => {
            let key = format!("{}.details{}", cx.id, *n);
            let shown = OPENED.with(|o| o.borrow().get(&key).copied()).unwrap_or(*open);
            let marker = if shown { "▾" } else { "▸" };
            let focus = crate::said::focus_for(SharedString::from(key.clone()), window, app);
            let head = crate::said::keyed(div().id(SharedString::from(key.clone())), &focus, l.z(4.), l, window)
                .flex()
                .items_start()
                .gap(u(6.))
                .cursor_pointer()
                .on_click(move |_, window, _| {
                    OPENED.with(|o| o.borrow_mut().insert(key.clone(), !shown));
                    window.refresh();
                })
                .child(div().flex_none().text_color(l.ink3).child(marker))
                .child(div().flex_auto().min_w_0().child(words(&summary.0, n, cx, l, false, color)).children(blocks(&summary.1, n, cx, l, color, window, app)));
            let body = shown.then(|| div().flex().flex_col().min_w_0().children(blocks(body, n, cx, l, color, window, app)));
            div().flex().flex_col().min_w_0().child(head).children(body).into_any_element()
        }
        Block::Heading(level, w, more) => {
            let key = (cx.order, *n);
            cx.sel.apart(key);
            let more = blocks(more, n, cx, l, color, window, app);
            // A document's headings step down in size by level; a message's are a weight up.
            let sized = |d: gpui::Div| match (cx.reading.is_some(), level) {
                (false, _) => d,
                (true, 1) => d.text_size(u(26.)).line_height(u(32.)),
                (true, 2) => d.text_size(u(21.)).line_height(u(28.)),
                (true, 3) => d.text_size(u(18.)).line_height(u(24.)),
                (true, _) => d.text_size(u(16.)).line_height(u(24.)),
            };
            // Where it's laid out, for the document's contents.
            let spot = cx.reading.as_ref().and_then(|r| r.heads.clone()).map(|heads| {
                let text = w.text.clone();
                gpui::canvas(
                    move |b, _, _| {
                        let frame = heads.frame.get();
                        heads.at.borrow_mut().insert(key, (text, b.top(), frame));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_0()
            });
            sized(gap(div(), 0.).when(last, |d| d.mb(u(4.))))
                .when(spot.is_some(), |d| d.relative())
                .children(spot)
                .child(words(w, n, cx, l, true, color))
                .children(more)
                .into_any_element()
        }
        Block::Task(done, w, more) => div()
            .flex()
            .items_start()
            .gap(u(6.))
            .child(
                div()
                    .mt(u(4.))
                    .flex_none()
                    .size(u(12.))
                    .rounded(px(2.))
                    .border_1()
                    .border_color(l.ink3)
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(*done, |d| d.bg(l.ink3).child(crate::chat_marks::drawn("copied", u(10.).to_pixels(window.rem_size()), l.bg))),
            )
            .child(div().flex_auto().min_w_0().child(words(w, n, cx, l, false, color)).children(blocks(more, n, cx, l, color, window, app)))
            .into_any_element(),
        Block::List { start, items } => gap(div(), 8.)
            .when(cx.cell, |d| d.py(u(4.)).pl(u(8.)).pr(u(8.)))
            .flex()
            .flex_col()
            .children(items.iter().enumerate().map(|(k, item)| {
                let marker = match start {
                    Some(s) => format!("{}.", s + k as u64),
                    None => "•".into(),
                };
                // `my-0.5` between items, collapsed to one; a long number widens its
                // marker rather than running out past the bubble. The words grow from their
                // own width (`flex-auto`): from none (`flex-1`), Taffy takes their width at
                // their narrowest while the bubble fits its words, a word a line.
                div()
                    .flex()
                    .when(k > 0, |d| d.mt(u(2.)))
                    .child(div().flex_none().min_w(if start.is_some() { u(28.) } else { u(20.) }).flex().justify_end().pr(u(6.)).text_color(l.ink3).child(marker))
                    .child(div().flex_auto().min_w_0().flex().flex_col().children(blocks(item, n, cx, l, color, window, app)))
            }))
            .into_any_element(),
        Block::Code(c) => {
            let whole = c.clone();
            let sel = cx.sel.clone();
            let k = (cx.order, *n);
            cx.sel.apart(k);
            *n += 1;
            let h = scroll_of(format!("{}.code{}", cx.id, k.1), window, app);
            let id = SharedString::from(format!("{}.code{}", cx.id, k.1));
            inset(gap(div(), 8.))
                .id(id.clone())
                // A key, as the desktop's: Tab reaches it, and Enter or Space copies it.
                .track_focus(&crate::said::focus_for(id, window, app))
                .focus_visible(|s| s.border_color(l.ink3))
                .tooltip(crate::band::tip("Copy"))
                .px(u(12.))
                .py(u(8.))
                .border_1()
                .border_color(l.line2)
                .bg(l.bg)
                .font_family(MONO)
                .text_size(u(12.))
                .line_height(u(16.))
                .text_color(l.ink)
                // `pre`: its lines as they are, scrolled sideways rather than wrapped.
                .whitespace_nowrap()
                .map(|d| crate::follow::across(d, &h))
                .on_scroll(crate::app::sideways(Some(h.clone())))
                .on_click(move |e, _, cx| {
                    if e.is_keyboard() || sel.is_empty() {
                        cx.write_to_clipboard(ClipboardItem::new_string(whole.clone()));
                    }
                })
                .child(SelText::new(SharedString::from(format!("{}.c{}", cx.id, k.1)), k, &cx.sel, SharedString::from(c.clone()), None).copies_all())
                .into_any_element()
        }
        // A quote keeps its `my-2` at the ends too.
        Block::Quote(inner) => inset(gap(div(), 8.).when(first && !cx.cell, |d| d.mt(u(8.))).when(last && !cx.cell, |d| d.mb(u(8.)))).pl(u(12.)).border_l_2().border_color(l.line2).flex().flex_col().children(blocks(inner, n, cx, l, l.ink2, window, app)).into_any_element(),
        Block::Rule => gap(div(), 0.).when(first, |d| d.mt(u(12.))).when(last, |d| d.mb(u(12.))).h(px(1.)).bg(l.line2).into_any_element(),
        Block::Table { cols, head, rows } => {
            // A grid whose columns are as wide as their words (a table's auto layout), as
            // wide as it needs and no wider, lines collapsed to one, scrolled sideways when
            // it's wider than the bubble.
            // Copied, a row's cells a tab apart and its rows a line apart; the table a
            // paragraph from what's before it.
            let cell = |w: &Cell, th: bool, first: (bool, bool), n: &mut u32, window: &mut Window, app: &mut App| {
                match first {
                    (true, true) => cx.sel.apart((cx.order, *n)),
                    (_, false) => cx.sel.tabbed((cx.order, *n)),
                    _ => {}
                }
                let more = blocks(&w.rich.1, n, cx, l, color, window, app);
                div()
                    .px(u(10.))
                    .py(u(6.))
                    .border_r_1()
                    .border_b_1()
                    .border_color(l.line2)
                    .col_span(w.span.0)
                    .row_span(w.span.1)
                    .map(|d| match w.align {
                        Alignment::Center => d.text_center(),
                        Alignment::Right => d.text_right(),
                        _ => d.text_left(),
                    })
                    .when(th, |d| d.text_size(u(12.)).line_height(u(16.)))
                    .child(words(&w.rich.0, n, cx, l, th, if th { l.ink2 } else { color }))
                    .children(more)
            };
            let mut cells = vec![];
            for (i, c) in head.iter().enumerate() {
                cells.push(cell(c, true, (true, i == 0), n, window, app));
            }
            for (j, r) in rows.iter().enumerate() {
                for (i, c) in r.iter().enumerate() {
                    cells.push(cell(c, false, (head.is_empty() && j == 0, i == 0), n, window, app));
                }
            }
            let h = scroll_of(format!("{}.table{}", cx.id, *n), window, app);
            let grid = div().grid().grid_cols_max_content(*cols as u16).border_t_1().border_l_1().border_color(l.line2).text_size(u(13.)).line_height(u(16.)).children(cells);
            inset(gap(div(), 8.))
                .id(SharedString::from(format!("{}.table{}", cx.id, *n)))
                .map(|d| crate::follow::across(d, &h))
                .on_scroll(crate::app::sideways(Some(h.clone())))
                .child(div().flex().items_start().child(grid))
                .into_any_element()
        }
        Block::Image { src, alt } => inset(gap(div(), 0.)).child(inline_image(src, alt, cx, l, window, app)).into_any_element(),
        // Drawn as itself, the room above it as any block's.
        Block::Spaced(inner) => gap(div(), 0.).flex().flex_col().min_w_0().children(blocks(std::slice::from_ref(inner.as_ref()), n, cx, l, color, window, app)).into_any_element(),
    }
}

/// A `$$` formula on its own (`w` is its stand-in alone): centered, a size up from the words as
/// KaTeX draws it, scrolled sideways when it's wider than the column; its TeX when it can't be
/// drawn.
fn math_block(w: &Inline, n: &mut u32, cx: &Ctx, l: &Look, color: gpui::Hsla, window: &mut Window, app: &mut App) -> AnyElement {
    let Some(formula) = crate::math::alone(&w.text, &cx.formulas) else { return words(w, n, cx, l, false, color) };
    let size = f32::from(u(14.).to_pixels(window.rem_size())) * crate::math::INLINE_SCALE;
    let Some(d) = crate::math::draw(&formula.tex, true, size, color, window.scale_factor(), app) else {
        let mut shown = Inline::default();
        shown.push(&formula.written(), &Style { mono: true, ..Style::default() });
        return words(&shown, n, cx, l, false, color);
    };
    let id = format!("{}.math{}", cx.id, *n);
    *n += 1;
    let h = scroll_of(id.clone(), window, app);
    div()
        .id(SharedString::from(id))
        .map(|d| crate::follow::across(d, &h))
        .on_scroll(crate::app::sideways(Some(h.clone())))
        .child(
            // Centred while it fits; wider than the column, it starts at the left and scrolls
            // (a centred one would lose its left side past the edge).
            div()
                .flex()
                .min_w(gpui::relative(1.))
                .py(u(4.))
                .child(img(gpui::ImageSource::Render(d.image.clone())).flex_none().mx_auto().w(px(d.width)).h(px(d.height + d.depth))),
        )
        .into_any_element()
}

/// A sideways scroller's place, kept with its element from frame to frame.
fn scroll_of(id: String, window: &mut Window, app: &mut App) -> gpui::ScrollHandle {
    window.use_keyed_state(gpui::ElementId::Name(id.into()), app, |_, _| gpui::ScrollHandle::new()).read(app).clone()
}

/// A picture in an agent's words, at a set height so the column keeps still while it loads; one
/// that can't be fetched is its name, as a file is.
fn inline_image(src: &str, alt: &str, cx: &Ctx, l: &Look, window: &mut Window, app: &mut App) -> AnyElement {
    let name = name_of(src, alt);
    // At most the column's width, in the screen's pixels.
    if let Some(hash) = crate::files::image_blob(src) {
        crate::attached::mount(&format!("{}.img.{src}", cx.id), &hash, window, app);
    }
    let shown = picture_of(src, (f32::from(l.z(720.)) * window.scale_factor()).ceil() as u32, app);
    let h = if cx.reading.is_some() { l.z(360.) } else { l.z(240.) };
    match shown {
        Some(Err(())) => div().text_color(l.ink2).child(if alt.is_empty() { name } else { alt.to_string() }).into_any_element(),
        found => {
            let menu = cx.on_picture.clone();
            let (s2, n2) = (src.to_string(), name.clone());
            let all = cx.pictures.clone();
            let me = picture_item(src, alt);
            let id = SharedString::from(format!("{}.img.{src}", cx.id));
            let focus = crate::said::focus_for(id.clone(), window, app);
            crate::said::keyed(div().id(id), &focus, l.z(4.), l, window)
                .max_w_full()
                .rounded(u(4.))
                .overflow_hidden()
                .on_click(move |_, window, cx| {
                    let at = all.iter().position(|i| *i == me);
                    let (items, at) = match at {
                        Some(at) => ((*all).clone(), at),
                        None => (vec![me.clone()], 0),
                    };
                    crate::viewer::open(items, at, window, cx);
                })
                .on_mouse_down(gpui::MouseButton::Right, move |_, window, cx| menu(&s2, &n2, true, window, cx))
                .child(match found {
                    // Its own corners: gpui clips the frame's children to its box, not its corners.
                    Some(Ok(image)) => img(image).h(h).max_w_full().object_fit(gpui::ObjectFit::Contain).rounded(u(4.)).into_any_element(),
                    _ => div().h(h).into_any_element(),
                })
                .into_any_element()
        }
    }
}

/// A picture by its address: a `/blobs/` path is the core's, decoded at the size it's drawn; any
/// other the web's (`data:` read in place). None while it comes; an error when it can't be had.
fn picture_of(src: &str, most: u32, cx: &mut App) -> Option<Result<gpui::ImageSource, ()>> {
    if let Some(hash) = crate::files::image_blob(src) {
        if crate::pictures::Pictures::failed(&hash, cx) {
            return Some(Err(()));
        }
        return crate::pictures::Pictures::sized(&hash, None, most, cx).map(Ok);
    }
    if crate::widgets::media::WebPictures::failed(src, cx) {
        return Some(Err(()));
    }
    crate::widgets::media::WebPictures::get(src, cx).map(|i| Ok(gpui::ImageSource::from(i)))
}

/// A picture's name, as a file: the address's own, else its last part when that's a file's name,
/// else what it's said to be, else "Image" (never a blob's hash). Its extension is its bytes' to
/// give when it's saved.
fn name_of(src: &str, alt: &str) -> String {
    let said = alt.trim().replace(['/', ':'], "-");
    let fallback = if said.is_empty() { "Image".to_string() } else { said };
    if src.starts_with("data:") {
        return fallback;
    }
    let Ok(u) = url::Url::parse(src).or_else(|_| url::Url::parse(&format!("http://x{src}"))) else { return fallback };
    if let Some((_, given)) = u.query_pairs().find(|(k, v)| k == "name" && !v.is_empty()) {
        return given.to_string();
    }
    if crate::files::image_blob(src).is_none()
        && let Some(last) = u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)).filter(|l| l.contains('.') || alt.trim().is_empty()).filter(|l| !l.is_empty())
    {
        return last;
    }
    fallback
}

/// A message's Markdown, drawn.
pub fn render(doc: &Doc, cx: &Ctx, l: &Look, window: &mut Window, app: &mut App) -> gpui::Div {
    let mut pictures = vec![];
    pictures_in(&doc.blocks, &mut pictures);
    let cx = &Ctx { pictures: Rc::new(pictures), formulas: Rc::new(doc.formulas.clone()), ..cx.clone() };
    // A bubble's words come after what it replies to.
    let mut n = crate::select::WORDS;
    let color = cx.ink.unwrap_or(l.ink);
    let shown = match cx.reading.as_ref().and_then(|r| r.margin.as_ref()) {
        Some(margin) => (0..doc.blocks.len())
            .map(|i| {
                let from = n;
                let drawn = block((&doc.blocks, i), &mut n, cx, l, color, window, app);
                margin(cx.order, from..n, u(above((&doc.blocks, i), cx)), drawn, window, app)
            })
            .collect(),
        None => blocks(&doc.blocks, &mut n, cx, l, color, window, app),
    };
    div().flex().flex_col().min_w_0().max_w_full().children(shown)
}

/// Plain words, selectable: a user's message, a reply, a quote.
pub fn plain(text: &str, id: impl Into<SharedString>, key: (u64, u32), sel: &Sel) -> SelText {
    SelText::new(gpui::ElementId::Name(id.into()), key, sel, SharedString::from(text.to_string()), None)
}
