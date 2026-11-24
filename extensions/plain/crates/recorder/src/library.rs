//! Recordings on disk. Each is a folder in ~/Movies/Recorder with the video and, once
//! transcribed, `Transcript.md`. Hidden beside them is what Recorder works from: the audio
//! tracks for transcription and `.recording.json`.

use std::{cmp::Reverse, fs, io, path::PathBuf};

use jiff::{Timestamp, Zoned, tz::TimeZone};
use serde::{Deserialize, Serialize};

use crate::{
    capture::Files,
    transcript::{self, Line},
};

const DETAILS: &str = ".recording.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recording {
    /// When it started, in milliseconds since 1970. Also how it's identified.
    pub id: u64,
    pub title: String,
    /// The video's file name in its folder.
    pub video: String,
    /// In seconds.
    pub duration: f64,
    pub microphone: bool,
    pub system_audio: bool,
    #[serde(default)]
    pub transcript: Option<Vec<Line>>,
    /// Why the last transcription failed.
    #[serde(default)]
    pub transcription_error: Option<String>,
    #[serde(skip)]
    pub folder: PathBuf,
}

/// Where recordings go.
pub fn root() -> PathBuf {
    std::env::home_dir()
        .unwrap_or_default()
        .join("Movies")
        .join("Recorder")
}

/// Every recording, newest first. Folders that aren't recordings are left alone.
pub fn load() -> Vec<Recording> {
    let Ok(entries) = fs::read_dir(root()) else {
        return Vec::new();
    };
    let mut recordings: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let folder = entry.path();
            let details = fs::read(folder.join(DETAILS)).ok()?;
            let recording: Recording = serde_json::from_slice(&details).ok()?;
            Some(Recording {
                folder,
                ..recording
            })
        })
        .collect();
    recordings.sort_by_key(|recording| Reverse(recording.id));
    recordings
}

impl Recording {
    /// Makes the folder for a recording starting now, named for when it started and `title`.
    pub fn create(title: &str, microphone: bool, system_audio: bool) -> Result<Self, String> {
        let now = Zoned::now();
        let name = format!("{} {}", now.strftime("%Y-%m-%d %H.%M"), file_name(title));
        let root = root();
        let folder = (1..)
            .map(|number| match number {
                1 => root.join(&name),
                _ => root.join(format!("{name} {number}")),
            })
            .find(|folder| !folder.exists())
            .expect("some name is free");
        fs::create_dir_all(&folder)
            .map_err(|error| format!("Couldn't make {}: {error}", folder.display()))?;
        Ok(Self {
            id: now.timestamp().as_millisecond() as u64,
            title: title.to_string(),
            video: format!("{name}.mp4"),
            duration: 0.,
            microphone,
            system_audio,
            transcript: None,
            transcription_error: None,
            folder,
        })
    }

    pub fn files(&self) -> Files {
        Files {
            video: self.folder.join(&self.video),
            system_audio: self.folder.join(".system-audio.mp3"),
            microphone: self.folder.join(".microphone.mp3"),
        }
    }

    pub fn transcript_file(&self) -> PathBuf {
        self.folder.join("Transcript.md")
    }

    /// A still from when it started.
    pub fn poster(&self) -> PathBuf {
        self.folder.join(".poster.jpg")
    }

    /// The audio tracks it has, for transcription.
    pub fn audio(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        let files = self.files();
        let present = |wanted: bool, path: PathBuf| (wanted && path.exists()).then_some(path);
        (
            present(self.microphone, files.microphone),
            present(self.system_audio, files.system_audio),
        )
    }

    /// Writes its details, and its transcript as Markdown.
    pub fn save(&self) -> Result<(), String> {
        let failed = |error: io::Error| format!("Couldn't save the recording: {error}");
        let details = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        fs::write(self.folder.join(DETAILS), details).map_err(failed)?;
        if let Some(lines) = &self.transcript {
            let markdown = transcript::markdown(&self.title, &self.subtitle(), lines);
            fs::write(self.transcript_file(), markdown).map_err(failed)?;
        }
        Ok(())
    }

    /// Gives every line by `speaker` to `name` instead.
    pub fn rename_speaker(&mut self, speaker: &str, name: &str) -> Result<(), String> {
        let lines = self
            .transcript
            .as_mut()
            .ok_or("This recording hasn't been transcribed")?;
        let theirs: Vec<_> = lines
            .iter_mut()
            .filter(|line| line.speaker == speaker)
            .collect();
        if theirs.is_empty() {
            return Err(format!(
                "No one called \"{speaker}\" speaks in this recording"
            ));
        }
        theirs
            .into_iter()
            .for_each(|line| line.speaker = name.to_string());
        Ok(())
    }

    /// The speakers in its transcript, in the order they first speak.
    pub fn speakers(&self) -> Vec<&str> {
        let mut speakers: Vec<&str> = Vec::new();
        for line in self.transcript.iter().flatten() {
            if !speakers.contains(&line.speaker.as_str()) {
                speakers.push(&line.speaker);
            }
        }
        speakers
    }

    pub fn started(&self) -> Zoned {
        Timestamp::from_millisecond(self.id as i64)
            .unwrap_or_default()
            .to_zoned(TimeZone::system())
    }

    /// When it was recorded and for how long, like "Monday, October 19, 2026 at 11:20 AM ·
    /// 42 min".
    pub fn subtitle(&self) -> String {
        format!(
            "{} · {}",
            self.started().strftime("%A, %B %-d, %Y at %-I:%M %p"),
            duration(self.duration)
        )
    }
}

/// A length of time in words, like "42 sec", "12 min" or "1 hr 5 min".
pub fn duration(seconds: f64) -> String {
    let seconds = seconds.round() as u64;
    match (seconds / 3600, seconds / 60 % 60) {
        (0, 0) => format!("{seconds} sec"),
        (0, minutes) => format!("{minutes} min"),
        (hours, 0) => format!("{hours} hr"),
        (hours, minutes) => format!("{hours} hr {minutes} min"),
    }
}

/// `title` without the characters that can't go in a file name.
fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|character| match character {
            '/' | ':' => '-',
            character if character.is_control() => ' ',
            character => character,
        })
        .take(80)
        .collect();
    cleaned.trim().trim_start_matches('.').to_string()
}

impl Recording {
    /// Removes the folder of a recording that didn't start, with the empty files made for it.
    /// Anything else in the folder keeps it.
    pub fn discard(self) {
        let files = self.files();
        for file in [
            files.video,
            files.system_audio,
            files.microphone,
            self.poster(),
        ] {
            fs::remove_file(file).ok();
        }
        fs::remove_dir(&self.folder).ok();
    }
}
