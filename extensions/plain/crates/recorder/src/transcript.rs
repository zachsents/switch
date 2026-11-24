//! A recording's transcript: who said what, and when.
//!
//! The microphone and the system audio are transcribed separately. With both, everything on the
//! microphone is "You" and the system audio is split into the other speakers. Without
//! headphones, the microphone also picks up the other speakers from the Mac's speakers. Those
//! echoes are dropped, since the system audio has them already.
//!
//! A track longer than one request can take is transcribed in overlapping pieces at once, and
//! their transcripts are stitched back together (see [`stitch`]).

mod stitch;

use std::{
    collections::HashSet,
    path::Path,
    thread::{self, ScopedJoinHandle},
};

use ai::{
    Key, Phrase, TranscriptionRequest,
    gateway::{DEFAULT_TRANSCRIPTION_MODEL, MAX_TRANSCRIPTION_BYTES, MAX_TRANSCRIPTION_SECONDS},
};
use serde::{Deserialize, Serialize};

use crate::track;
use stitch::Part;

pub const YOU: &str = "You";
/// How much of a long track neighboring pieces share. Enough for the people talking around the
/// switch from one piece to the next to be heard in both, so they keep their speaker numbers.
const OVERLAP: f64 = 5. * 60.;

/// Something one person said.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub speaker: String,
    /// Seconds from the start of the recording.
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Transcribes a recording's audio tracks into lines in the order they were said. Either track
/// may be missing. Blocks for as long as the transcription takes, under a minute for a two hour
/// track, so call it off the main thread.
pub fn transcribe(
    key: &Key,
    microphone: Option<&Path>,
    system_audio: Option<&Path>,
) -> Result<Vec<Line>, String> {
    let both = microphone.is_some() && system_audio.is_some();
    let (mine, theirs) = thread::scope(|scope| {
        // With the system audio there, the microphone is one person: you.
        let mine = microphone.map(|path| scope.spawn(move || phrases(key, path, !both)));
        let theirs = system_audio.map(|path| scope.spawn(move || phrases(key, path, true)));
        (
            mine.map(finished).transpose(),
            theirs.map(finished).transpose(),
        )
    });
    Ok(merge(
        &mine?.unwrap_or_default(),
        &theirs?.unwrap_or_default(),
        both,
    ))
}

/// One track's phrases. A track too long for one request goes in pieces, all at once.
fn phrases(key: &Key, path: &Path, speakers: bool) -> Result<Vec<Phrase>, String> {
    let audio = std::fs::read(path).map_err(|error| format!("Couldn't read the audio: {error}"))?;
    if audio.is_empty() {
        return Ok(Vec::new());
    }
    let pieces = track::split(
        &audio,
        MAX_TRANSCRIPTION_SECONDS,
        MAX_TRANSCRIPTION_BYTES,
        OVERLAP,
    );
    // Word times are what lets pieces be stitched between words.
    let words = pieces.len() > 1;
    let parts = thread::scope(|scope| {
        let handles: Vec<_> = pieces
            .iter()
            .map(|piece| {
                scope.spawn(move || {
                    ai::transcribe(
                        key,
                        &TranscriptionRequest {
                            audio: piece.mp3,
                            media_type: "audio/mpeg",
                            model: DEFAULT_TRANSCRIPTION_MODEL,
                            speakers,
                            vocabulary: &[],
                            words,
                        },
                    )
                    .map(|transcription| Part {
                        start: piece.start,
                        end: piece.end,
                        phrases: transcription.phrases,
                    })
                })
            })
            .collect();
        handles.into_iter().map(finished).collect::<Result<_, _>>()
    })?;
    Ok(stitch::stitch(parts))
}

/// What a transcription thread came back with.
fn finished<T>(handle: ScopedJoinHandle<Result<T, String>>) -> Result<T, String> {
    handle
        .join()
        .unwrap_or_else(|_| Err("Transcription stopped unexpectedly".into()))
}

/// Puts the microphone's and the system audio's phrases in one timeline, naming speakers.
/// `both` is whether there were both tracks; then the microphone is "You".
fn merge(microphone: &[Phrase], system_audio: &[Phrase], both: bool) -> Vec<Line> {
    let line = |phrase: &Phrase, speaker: String| Line {
        speaker,
        start: phrase.start,
        end: phrase.end,
        text: phrase.text.trim().to_string(),
    };
    let mine = microphone
        .iter()
        .filter(|phrase| !both || !echoes(phrase, system_audio))
        .map(|phrase| {
            let speaker = if both {
                YOU.to_string()
            } else {
                speaker_name(phrase.speaker)
            };
            line(phrase, speaker)
        });
    let theirs = system_audio
        .iter()
        .map(|phrase| line(phrase, speaker_name(phrase.speaker)));
    let mut lines: Vec<_> = mine
        .chain(theirs)
        .filter(|line| !line.text.is_empty())
        .collect();
    lines.sort_by(|a, b| a.start.total_cmp(&b.start));
    lines
}

fn speaker_name(speaker: Option<u32>) -> String {
    speaker.map_or_else(
        || "Speaker".into(),
        |number| format!("Speaker {}", number + 1),
    )
}

/// Whether a microphone phrase is the speakers' sound picked up again: most of its words were
/// in the system audio around the same time.
fn echoes(phrase: &Phrase, system_audio: &[Phrase]) -> bool {
    const NEAR: f64 = 1.5;
    let heard: HashSet<String> = system_audio
        .iter()
        .filter(|other| other.start < phrase.end + NEAR && other.end > phrase.start - NEAR)
        .flat_map(|other| words(&other.text))
        .collect();
    let said = words(&phrase.text);
    let repeated = said.iter().filter(|word| heard.contains(*word)).count();
    !said.is_empty() && repeated * 10 >= said.len() * 6
}

fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric() && character != '\'')
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// The transcript as Markdown: a heading, then each turn with its speaker and when it started.
/// Consecutive lines from one speaker are one paragraph.
pub fn markdown(title: &str, subtitle: &str, lines: &[Line]) -> String {
    let turns = lines.chunk_by(|a, b| a.speaker == b.speaker).map(|turn| {
        let said: Vec<_> = turn.iter().map(|line| line.text.as_str()).collect();
        let first = &turn[0];
        format!(
            "**{}** · {}\n{}\n",
            first.speaker,
            timestamp(first.start),
            said.join(" ")
        )
    });
    std::iter::once(format!("# {title}\n\n{subtitle}\n"))
        .chain(turns)
        .collect::<Vec<_>>()
        .join("\n")
}

/// A moment written like "1:30", "1:02:05" or "90", in seconds.
pub fn moment(text: &str) -> Result<f64, String> {
    let unreadable = || format!("\"{text}\" isn't a time like 1:30");
    text.trim()
        .trim_end_matches('s')
        .split(':')
        .try_fold(0., |seconds, part| {
            part.trim()
                .parse::<f64>()
                .map(|value| seconds * 60. + value)
        })
        .ok()
        .filter(|seconds| *seconds >= 0.)
        .ok_or_else(unreadable)
}

/// Seconds as "1:05" or, past an hour, "1:02:05".
pub fn timestamp(seconds: f64) -> String {
    let total = seconds.max(0.) as u64;
    let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}
