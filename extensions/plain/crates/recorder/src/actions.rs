//! Every command in the app. Each one has a keyboard shortcut or a menu item, and is an MCP
//! tool for agents: the doc comment is the tool's description and the fields are its input.

use gpui::{Action, actions};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::choose::Choice;

/// Start recording. Settings left out keep their last values, which start as the main screen
/// with the microphone and system audio on. The recording is transcribed after it stops.
/// The source can be words, like "the Zoom window" or "the second screen", matched against
/// what's open right now.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct StartRecording {
    /// What to record: a screen or a window from the state's `sources`, by id or in words.
    #[serde(default)]
    pub source: Option<Choice>,
    /// Whether to record the microphone.
    #[serde(default)]
    pub microphone: Option<bool>,
    /// Whether to record the sound the computer plays, like the other people in a call.
    #[serde(default)]
    pub system_audio: Option<bool>,
}

/// Choose what to record next: a screen or a window from the state's `sources`, by id or in
/// words like "the Zoom window", "Chrome's Google Meet window", "Finder" or "the second
/// screen". Words are matched against app names and window titles open right now, and when
/// they could mean several windows, a fast model picks the likeliest, which takes about a
/// second. The state's `next.source` shows what was chosen.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct SetSource {
    pub source: Choice,
}

/// Turn recording the microphone on or off.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct ToggleMicrophone {
    /// On or off. Defaults to switching it.
    #[serde(default)]
    pub on: Option<bool>,
}

/// Turn recording the sound the computer plays on or off.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct ToggleSystemAudio {
    /// On or off. Defaults to switching it.
    #[serde(default)]
    pub on: Option<bool>,
}

/// Transcribe a recording again, replacing its transcript. Recordings are transcribed on their
/// own when they stop, so this is for retrying.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct Transcribe {
    /// Which recording. Defaults to the selected one.
    #[serde(default)]
    pub id: Option<u64>,
}

/// Show a recording and its transcript.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct Select {
    /// Which recording.
    pub id: u64,
}

/// Play a recording in the window, from a moment if given. Its transcript follows along.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct Play {
    /// Which recording. Defaults to the selected one.
    #[serde(default)]
    pub id: Option<u64>,
    /// Where to start, like "1:30", "1:02:05" or "90" (seconds). Defaults to where it's paused.
    #[serde(default)]
    pub from: Option<String>,
}

/// Rename a speaker throughout a recording's transcript, like "Speaker 1" to "Ana".
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct RenameSpeaker {
    /// Which recording. Defaults to the selected one.
    #[serde(default)]
    pub id: Option<u64>,
    /// The speaker's name now, as in the transcript.
    pub speaker: String,
    /// Their new name.
    pub name: String,
}

/// Move a recording's folder, with its video and transcript, to the Trash.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = recorder)]
#[serde(deny_unknown_fields)]
pub struct MoveToTrash {
    /// Which recording. Defaults to the selected one.
    #[serde(default)]
    pub id: Option<u64>,
}

actions!(
    recorder,
    [
        /// Stop recording and save it. It's transcribed right after.
        StopRecording,
        /// Pause the recording playing in the window.
        Pause,
        /// Look again for the screens and windows that can be recorded, listed in the state's
        /// `sources`.
        RefreshSources,
        /// Select the recording above the selected one.
        SelectPrevious,
        /// Select the recording below the selected one.
        SelectNext,
    ]
);

// Actions that only drive the window live in their own namespace, so they aren't offered to
// agents. Opening the video or Finder would bring another app forward.
actions!(
    recorder_window,
    [
        /// Start recording, or stop if recording.
        ToggleRecording,
        /// Show the page for starting a recording.
        ShowNewRecording,
        /// Open the selected recording's video in the default player.
        PlayVideo,
        /// Show the selected recording's folder in Finder.
        ShowInFinder,
        /// Copy the selected recording's transcript.
        CopyTranscript,
        /// Record a whole screen.
        RecordScreen,
        /// Record one window.
        RecordWindow,
        /// Play or pause the shown recording.
        TogglePlayback,
        /// Go back 5 seconds in the shown recording.
        SkipBack,
        /// Go forward 5 seconds in the shown recording.
        SkipForward,
    ]
);
