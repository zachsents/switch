//! Joining the transcripts of a long track's pieces into one, as if it had been transcribed
//! whole.
//!
//! Neighboring pieces overlap, and both transcribe the overlap. The transcript switches from one
//! piece to the next at the longest pause in the middle of it, so phrases are rarely cut in two,
//! and the people talking in the overlap are matched across the pieces by when they talk.
//!
//! The model numbers each piece's speakers on its own and gives nothing to recognize a voice by
//! across requests, so matching can only go by the overlap. Someone who says nothing during an
//! overlap can't be matched: if they spoke before it, they come back after it as a new speaker.
//! And when the model hears one person as two in one piece but not the other, only one of the two
//! is matched.

use std::collections::HashMap;

use ai::{Phrase, Word};

/// Shared speech below this, in seconds, is too little to tell that two speakers are one person.
const MATCHED: f64 = 1.;
/// The part of an overlap to keep the switch out of, at each end, where a piece starts or stops
/// mid-word and its transcript is least sure.
const EDGE: f64 = 30.;

/// One piece's transcript.
pub struct Part {
    /// Seconds into the track where the piece starts and ends.
    pub start: f64,
    pub end: f64,
    /// As the model returned them, timed from the start of the piece.
    pub phrases: Vec<Phrase>,
}

/// The pieces' phrases on the track's timeline, in order, with each speaker numbered the same
/// in every piece as far as the overlaps tell, counted from 0 in the order they first speak.
pub fn stitch(parts: Vec<Part>) -> Vec<Phrase> {
    let parts: Vec<_> = parts.into_iter().map(shifted).collect();
    let overlaps: Vec<_> = parts
        .windows(2)
        .map(|pair| (pair[1].start, pair[0].end))
        .collect();
    let cuts: Vec<_> = parts
        .windows(2)
        .zip(&overlaps)
        .map(|(pair, &(from, to))| cut(&pair[0].phrases, &pair[1].phrases, from, to))
        .collect();

    // Each piece takes the speaker numbers of the piece before it, which already has the numbers
    // of the pieces before that. Anyone new gets a number no one has.
    let mut fresh = parts
        .iter()
        .flat_map(|part| &part.phrases)
        .filter_map(|phrase| phrase.speaker)
        .max()
        .map_or(0, |most| most + 1);
    let mut named: Vec<Vec<Phrase>> = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        let heard = first_heard(&part.phrases);
        let links = match named.last() {
            Some(previous) => {
                let (from, to) = overlaps[index - 1];
                links(previous, &part.phrases, from, to)
            }
            None => heard.iter().map(|&speaker| (speaker, speaker)).collect(),
        };
        let names: HashMap<_, _> = heard
            .into_iter()
            .map(|speaker| {
                let name = links.get(&speaker).copied().unwrap_or_else(|| {
                    fresh += 1;
                    fresh - 1
                });
                (speaker, name)
            })
            .collect();
        named.push(
            part.phrases
                .iter()
                .map(|phrase| Phrase {
                    speaker: phrase.speaker.map(|speaker| names[&speaker]),
                    ..phrase.clone()
                })
                .collect(),
        );
    }

    let kept = named.iter().enumerate().map(|(index, phrases)| {
        let from = index
            .checked_sub(1)
            .map_or(f64::NEG_INFINITY, |previous| cuts[previous]);
        let to = cuts.get(index).copied().unwrap_or(f64::INFINITY);
        let mut kept: Vec<_> = phrases
            .iter()
            .filter_map(|phrase| within(phrase, from, to))
            .collect();
        kept.sort_by(|a, b| a.start.total_cmp(&b.start));
        kept
    });
    let joined = kept.fold(Vec::new(), |mut joined: Vec<Phrase>, part| {
        let mut part = part.into_iter().peekable();
        // One person talking across the switch is one phrase, as the model gives a whole turn.
        if let (Some(last), Some(first)) = (joined.last_mut(), part.peek())
            && last.speaker.is_some()
            && last.speaker == first.speaker
        {
            *last = joined_phrases(last, first);
            part.next();
        }
        joined.extend(part);
        joined
    });
    renumbered(joined)
}

/// A part with its phrases timed from the start of the track.
fn shifted(part: Part) -> Part {
    let offset = part.start;
    Part {
        phrases: part
            .phrases
            .into_iter()
            .map(|phrase| Phrase {
                start: phrase.start + offset,
                end: phrase.end + offset,
                words: phrase
                    .words
                    .into_iter()
                    .map(|word| Word {
                        start: word.start + offset,
                        end: word.end + offset,
                        ..word
                    })
                    .collect(),
                ..phrase
            })
            .collect(),
        ..part
    }
}

/// Where to switch from `previous`'s transcript to `next`'s, given the stretch from `from` to
/// `to` that both transcribed: the middle of the longest pause in it that neither heard words
/// in, away from its ends. When there's no pause, the middle of the stretch.
fn cut(previous: &[Phrase], next: &[Phrase], from: f64, to: f64) -> f64 {
    let edge = EDGE.min((to - from) / 4.);
    let (from, to) = (from + edge, to - edge);
    let mut spoken: Vec<_> = previous
        .iter()
        .chain(next)
        .flat_map(spans)
        .filter(|&(start, end)| end > from && start < to)
        .collect();
    spoken.sort_by(|a, b| a.0.total_cmp(&b.0));
    let middle = (from + to) / 2.;
    let ((start, end), _) = spoken.into_iter().chain([(to, to)]).fold(
        ((middle, middle), from),
        |(longest, heard_until), (start, end)| {
            let pause = (heard_until, start);
            let longest = if pause.1 - pause.0 > longest.1 - longest.0 {
                pause
            } else {
                longest
            };
            (longest, heard_until.max(end))
        },
    );
    (start + end) / 2.
}

/// When a phrase's words were said, or the whole phrase when its words aren't timed.
fn spans(phrase: &Phrase) -> Vec<(f64, f64)> {
    if phrase.words.is_empty() {
        vec![(phrase.start, phrase.end)]
    } else {
        phrase
            .words
            .iter()
            .map(|word| (word.start, word.end))
            .collect()
    }
}

/// Which of `next`'s speakers are which of `previous`'s, judged by who talks at the same time in
/// the stretch from `from` to `to` that both transcribed. Pairs that talk together longest are
/// matched first, each speaker at most once.
fn links(previous: &[Phrase], next: &[Phrase], from: f64, to: f64) -> HashMap<u32, u32> {
    let during = |phrases: &[Phrase]| -> Vec<(u32, f64, f64)> {
        phrases
            .iter()
            .filter_map(|phrase| {
                Some((phrase.speaker?, phrase.start.max(from), phrase.end.min(to)))
            })
            .filter(|(_, start, end)| end > start)
            .collect()
    };
    let (earlier, later) = (during(previous), during(next));
    let together = earlier
        .iter()
        .fold(HashMap::new(), |together, &(a, start, end)| {
            later
                .iter()
                .fold(together, |mut together, &(b, other_start, other_end)| {
                    let shared = end.min(other_end) - start.max(other_start);
                    if shared > 0. {
                        *together.entry((b, a)).or_insert(0.) += shared;
                    }
                    together
                })
        });
    let mut pairs: Vec<((u32, u32), f64)> = together
        .into_iter()
        .filter(|&(_, shared)| shared >= MATCHED)
        .collect();
    pairs.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs
        .into_iter()
        .fold(HashMap::new(), |mut links, ((later, earlier), _)| {
            if !links.contains_key(&later) && !links.values().any(|&taken| taken == earlier) {
                links.insert(later, earlier);
            }
            links
        })
}

/// The part of `phrase` said from `from` until `to`, going by when each word starts.
fn within(phrase: &Phrase, from: f64, to: f64) -> Option<Phrase> {
    let inside = |time: f64| (from..to).contains(&time);
    if phrase.start >= from && phrase.end <= to {
        return Some(phrase.clone());
    }
    if phrase.words.is_empty() {
        return inside(phrase.start).then(|| phrase.clone());
    }
    let words: Vec<_> = phrase
        .words
        .iter()
        .filter(|word| inside(word.start))
        .cloned()
        .collect();
    let (first, last) = (words.first()?, words.last()?);
    Some(Phrase {
        start: first.start,
        end: last.end,
        text: written(&phrase.text, &words),
        words,
        ..phrase.clone()
    })
}

/// Two phrases as one, the second following the first.
fn joined_phrases(first: &Phrase, second: &Phrase) -> Phrase {
    let words: Vec<_> = first.words.iter().chain(&second.words).cloned().collect();
    Phrase {
        end: second.end,
        text: if words.is_empty() {
            format!("{} {}", first.text.trim_end(), second.text.trim_start())
        } else {
            written(&first.text, &words)
        },
        words,
        ..first.clone()
    }
}

/// Words written out as a phrase like `like`, with spaces between them unless it has none, as
/// in Chinese or Japanese.
fn written(like: &str, words: &[Word]) -> String {
    let space = if like.trim().contains(char::is_whitespace) {
        " "
    } else {
        ""
    };
    words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(space)
}

/// Speakers in the order they first speak, each once.
fn first_heard(phrases: &[Phrase]) -> Vec<u32> {
    let mut ordered: Vec<_> = phrases.iter().collect();
    ordered.sort_by(|a, b| a.start.total_cmp(&b.start));
    ordered
        .into_iter()
        .filter_map(|phrase| phrase.speaker)
        .fold(Vec::new(), |mut heard, speaker| {
            if !heard.contains(&speaker) {
                heard.push(speaker);
            }
            heard
        })
}

/// Speakers numbered from 0 in the order they first speak.
fn renumbered(phrases: Vec<Phrase>) -> Vec<Phrase> {
    let order: HashMap<u32, u32> = first_heard(&phrases).into_iter().zip(0..).collect();
    phrases
        .into_iter()
        .map(|phrase| Phrase {
            speaker: phrase.speaker.map(|speaker| order[&speaker]),
            ..phrase
        })
        .collect()
}
