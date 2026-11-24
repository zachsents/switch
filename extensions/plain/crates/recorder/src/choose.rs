//! Choosing what to record from words, like "the Zoom window", "Chrome" or "the second
//! screen". A local parser matches screens, app names and window titles. When that leaves more
//! than one window, or none, the suite's decision model picks from the list.

use ai::Provider;
use gpui::{App, Task};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::capture::{Source, Sources, Window};

/// Words that add nothing to which window or screen is meant, like "the" in "the Zoom window".
const FILLER: &[&str] = &[
    "the",
    "my",
    "a",
    "an",
    "this",
    "that",
    "of",
    "in",
    "on",
    "from",
    "for",
    "with",
    "record",
    "recording",
    "please",
    "just",
    "only",
    "window",
    "windows",
    "app",
    "application",
    "whole",
    "entire",
    "full",
    "all",
];

/// What to record: an id from the state's `sources`, or words.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Choice {
    /// A screen or window by its id from the state's `sources`, like `{"window": 4182}`.
    Id(Source),
    /// The screen or window in plain words, like "the Zoom window", "Chrome's meeting tab",
    /// "the main screen" or "the second screen".
    Words(String),
}

impl From<Source> for Choice {
    fn from(source: Source) -> Self {
        Self::Id(source)
    }
}

/// Why words didn't name exactly one thing to record.
#[derive(Debug, PartialEq)]
pub enum Miss {
    /// They could be any of these windows, or anything at all when there are none.
    Unclear(Vec<Source>),
    /// They name a screen that isn't connected, like the second screen when there's one.
    NoScreen,
}

/// The screen or window `words` name, matched against `sources`: a window by its app's exact
/// name or exact title, then a screen by its place, like "the second screen", then a window by
/// a part of its app's name or title.
pub fn parse(words: &str, sources: &Sources) -> Result<Source, Miss> {
    let text = words
        .trim()
        .trim_end_matches(['.', '!'])
        .to_lowercase()
        .replace('’', "'");
    let tokens: Vec<_> = text
        .split_whitespace()
        .map(|word| word.trim_end_matches("'s").trim_end_matches('\''))
        .filter(|word| !FILLER.contains(word))
        .collect();
    let query = tokens.join(" ");
    if query.is_empty() {
        return Err(Miss::Unclear(Vec::new()));
    }
    let windows = |matches: &dyn Fn(&Window) -> bool| -> Vec<Source> {
        sources
            .windows
            .iter()
            .filter(|window| matches(window))
            .map(|window| Source::Window(window.id))
            .collect()
    };
    let app = |window: &Window| window.app.to_lowercase();
    let title = |window: &Window| window.title.to_lowercase();
    let named_app = windows(&|window| app(window) == query);
    if let [only] = named_app[..] {
        return Ok(only);
    }
    if let [only] = windows(&|window| title(window) == query)[..] {
        return Ok(only);
    }
    if named_app.is_empty()
        && let Some(screen) = screen(&tokens, sources)
    {
        return screen;
    }
    if !named_app.is_empty() {
        return Err(Miss::Unclear(named_app));
    }
    // A part of the app's name, like "chrome" for Google Chrome, before a part of a title.
    let in_app = windows(&|window| app(window).contains(&query));
    let in_title = windows(&|window| title(window).contains(&query));
    let every_word = windows(&|window| {
        let both = format!("{} {}", app(window), title(window));
        tokens.iter().all(|token| both.contains(token))
    });
    match (&in_app[..], &in_title[..], &every_word[..]) {
        ([only], _, _) | ([], [only], _) | ([], [], [only]) => Ok(*only),
        ([], [], _) => Err(Miss::Unclear(every_word)),
        ([], _, _) => Err(Miss::Unclear(in_title)),
        _ => Err(Miss::Unclear(in_app)),
    }
}

/// The screen `tokens` name, if they name one: "screen", "main screen", "second display",
/// "screen 2", "the other monitor".
fn screen(tokens: &[&str], sources: &Sources) -> Option<Result<Source, Miss>> {
    let count = sources.screens.len();
    let mut named = false;
    let mut index = None;
    for &token in tokens {
        let place = match token {
            "screen" | "display" | "monitor" | "desktop" | "everything" => {
                named = true;
                continue;
            }
            "main" | "primary" | "first" | "1" | "one" | "1st" => 0,
            "second" | "2" | "two" | "2nd" => 1,
            "third" | "3" | "three" | "3rd" => 2,
            "fourth" | "4" | "four" | "4th" => 3,
            "last" => count.checked_sub(1)?,
            // With two screens, the other one is the second. With more, it's unclear.
            "other" | "external" | "secondary" if count == 2 => 1,
            _ => return None,
        };
        if index.replace(place).is_some_and(|before| before != place) {
            return None;
        }
    }
    if !named {
        return None;
    }
    let screen = sources.screens.get(index.unwrap_or(0));
    Some(
        screen
            .map(|screen| Source::Screen(screen.id))
            .ok_or(Miss::NoScreen),
    )
}

/// Finds the screen or window `words` mean among `sources`. The parser takes clear names
/// instantly; when they match several windows or none, the suite's decision model picks from
/// the list. Without an AI key only the parser works.
pub fn understand(words: String, sources: Sources, cx: &App) -> Task<Result<Source, String>> {
    let unclear = match parse(&words, &sources) {
        Ok(source) => return Task::ready(Ok(source)),
        Err(Miss::NoScreen) => {
            let missing = match sources.screens.len() {
                0 => "There's no screen to record".to_string(),
                1 => "There's only one screen".to_string(),
                count => format!("There are only {count} screens"),
            };
            return Task::ready(Err(missing));
        }
        Err(Miss::Unclear(candidates)) => candidates,
    };
    cx.background_executor().spawn(async move {
        let Some(key) = ai::keys::find(Provider::Gateway) else {
            return Err(unmatched(&words, &unclear, &sources));
        };
        let screens = sources.screens.iter().enumerate().map(|(index, screen)| {
            let name = if index == 0 {
                "the main screen".to_string()
            } else {
                format!("screen {}", index + 1)
            };
            format!(
                "- screen {}: {name}, {} × {}",
                screen.id, screen.width, screen.height
            )
        });
        let windows = sources.windows.iter().map(|window| {
            format!(
                "- window {}: app \"{}\", title \"{}\"",
                window.id, window.app, window.title
            )
        });
        let list: Vec<_> = screens.chain(windows).collect();
        let task = format!(
            "Someone is about to record their screen and said what to record. Pick the one \
             screen or window they mean from this list, which has windows front to back, and \
             answer with its kind and id. Browser tabs aren't listed, but a browser window's \
             title is its front tab's title. If they name an app, site or window that isn't in \
             the list, it isn't open: say so as unclear rather than picking something else.\
             \n\n{}",
            list.join("\n")
        );
        let source: Source = ai::decide(&key, &task, &words)?;
        let listed = match source {
            Source::Screen(id) => sources.screens.iter().any(|screen| screen.id == id),
            Source::Window(id) => sources.windows.iter().any(|window| window.id == id),
        };
        listed
            .then_some(source)
            .ok_or_else(|| unmatched(&words, &unclear, &sources))
    })
}

/// Why `words` couldn't be matched, naming the windows they could mean.
fn unmatched(words: &str, candidates: &[Source], sources: &Sources) -> String {
    let names: Vec<_> = candidates
        .iter()
        .filter_map(|candidate| {
            let window = sources
                .windows
                .iter()
                .find(|window| Source::Window(window.id) == *candidate)?;
            Some(if window.title.is_empty() {
                format!("{} ({})", window.app, window.id)
            } else {
                format!("{} “{}” ({})", window.app, window.title, window.id)
            })
        })
        .collect();
    if names.is_empty() {
        format!("Nothing to record matches “{}”", words.trim())
    } else {
        format!("“{}” could be {}", words.trim(), names.join(", "))
    }
}
