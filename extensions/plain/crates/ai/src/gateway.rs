//! Calls to Vercel's AI Gateway, which reaches many providers' models with one key.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use ureq::Agent;

use crate::keys::Key;

pub(crate) const GATEWAY: &str = "https://ai-gateway.vercel.sh";

/// The best transcription model the gateway offers for meetings: it tells speakers apart and
/// takes a list of words to listen for.
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "microsoft/mai-transcribe-2";

/// The most audio one transcription request can carry. The gateway refuses request bodies over
/// 100 MB, and the audio goes in them as base64, a third bigger than the file. Measured on
/// 2026-10-19: a 99.9 MB body went through and a 100.1 MB one got a 413.
pub const MAX_TRANSCRIPTION_BYTES: usize = 74_000_000;

/// The longest audio to send in one transcription request. Azure, which serves Microsoft's
/// models, documents 2 hours. The gateway took more on 2026-10-19 (5 h 10 min of mostly silence,
/// and 2 h 13 min of four people talking, told apart correctly in 44 s), but past 2 hours nothing
/// promises it keeps working.
pub const MAX_TRANSCRIPTION_SECONDS: f64 = 2. * 60. * 60.;

/// What to transcribe and how.
pub struct TranscriptionRequest<'a> {
    /// The audio file's bytes. Microsoft's models take MP3, WAV, FLAC and Ogg/Opus, not MP4.
    pub audio: &'a [u8],
    /// Its type, like "audio/mpeg".
    pub media_type: &'a str,
    /// A gateway model id, like [`DEFAULT_TRANSCRIPTION_MODEL`].
    pub model: &'a str,
    /// Tell different speakers apart, when the model can.
    pub speakers: bool,
    /// Names and terms likely to come up, so they're spelled right.
    pub vocabulary: &'a [String],
    /// Time each word too, in [`Phrase::words`], when the model can.
    pub words: bool,
}

/// A transcript, in phrases.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Transcription {
    pub text: String,
    pub language: Option<String>,
    pub phrases: Vec<Phrase>,
}

/// A stretch of speech, with when it was said and, when the model tells speakers apart, who
/// said it.
#[derive(Clone, Debug, PartialEq)]
pub struct Phrase {
    /// Which speaker, counted from 0 in the order they first speak. None when the model doesn't
    /// tell speakers apart.
    pub speaker: Option<u32>,
    /// Seconds from the start of the audio.
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Its words, when they were asked for and the model times them.
    pub words: Vec<Word>,
}

/// One word of a phrase, as it's written in the phrase's text, with its punctuation.
#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    /// Seconds from the start of the audio.
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// The gateway's reply, as far as it's used.
#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    segments: Vec<Segment>,
    #[serde(default, rename = "providerMetadata")]
    metadata: Value,
}

#[derive(Deserialize)]
struct Segment {
    text: String,
    #[serde(rename = "startSecond")]
    start: f64,
    #[serde(rename = "endSecond")]
    end: f64,
}

/// A phrase as Microsoft's models return it, with its speaker.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzurePhrase {
    text: String,
    offset_milliseconds: f64,
    duration_milliseconds: f64,
    speaker: Option<u32>,
    #[serde(default)]
    words: Vec<AzureWord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzureWord {
    text: String,
    offset_milliseconds: f64,
    duration_milliseconds: f64,
}

/// Transcribes audio through the gateway. Blocks until the transcript arrives, which takes
/// about twenty seconds for an hour of audio, so call it off the main thread.
pub fn transcribe(key: &Key, request: &TranscriptionRequest) -> Result<Transcription, String> {
    let microsoft = request.model.starts_with("microsoft/mai-transcribe-2");
    let options = microsoft.then(|| {
        json!({
            "azure": {
                "transcribeStyle": "clean",
                "timestamps": if request.words { "word" } else { "segment" },
                "diarization": { "enabled": request.speakers },
                "phraseList": { "phrases": request.vocabulary },
            }
        })
    });
    let body = json!({
        "audio": STANDARD.encode(request.audio),
        "mediaType": request.media_type,
        "providerOptions": options,
    });
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15 * 60)))
        .build()
        .into();
    let mut response = agent
        .post(format!("{GATEWAY}/v4/ai/transcription-model"))
        .header("Authorization", format!("Bearer {}", key.value()))
        .header("ai-gateway-protocol-version", "0.0.1")
        .header("ai-transcription-model-specification-version", "4")
        .header("ai-model-id", request.model)
        .send_json(&body)
        .map_err(|error| format!("Couldn't reach the AI Gateway: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let message = response
            .body_mut()
            .read_json::<Value>()
            .ok()
            .and_then(|reply| reply["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| status.to_string());
        return Err(format!("The AI Gateway couldn't transcribe it: {message}"));
    }
    let reply: Reply = response
        .body_mut()
        .with_config()
        .limit(256 * 1024 * 1024)
        .read_json()
        .map_err(|error| format!("The AI Gateway's reply didn't make sense: {error}"))?;
    Ok(parse(reply))
}

/// Phrases with speakers from Microsoft's metadata when there, or else the plain segments.
fn parse(reply: Reply) -> Transcription {
    let azure: Option<Vec<AzurePhrase>> =
        serde_json::from_value(reply.metadata["azure"]["phrases"].clone()).ok();
    let phrases = match azure {
        Some(phrases) if !phrases.is_empty() => phrases
            .into_iter()
            .map(|phrase| Phrase {
                speaker: phrase.speaker,
                start: phrase.offset_milliseconds / 1000.,
                end: (phrase.offset_milliseconds + phrase.duration_milliseconds) / 1000.,
                text: phrase.text,
                words: phrase
                    .words
                    .into_iter()
                    .map(|word| Word {
                        start: word.offset_milliseconds / 1000.,
                        end: (word.offset_milliseconds + word.duration_milliseconds) / 1000.,
                        text: word.text,
                    })
                    .collect(),
            })
            .collect(),
        _ => reply
            .segments
            .into_iter()
            .map(|segment| Phrase {
                speaker: None,
                start: segment.start,
                end: segment.end,
                text: segment.text,
                words: Vec::new(),
            })
            .collect(),
    };
    Transcription {
        text: reply.text,
        language: reply.language,
        phrases,
    }
}
