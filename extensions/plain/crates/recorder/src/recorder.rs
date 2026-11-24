//! The app's state: the recordings, the one in progress, and what to record next. Every change
//! goes through here, so the window, the menu bar and agents all see the same thing.

use std::{collections::HashSet, path::PathBuf, thread, time::Instant};

use ai::Provider;
use futures::channel::oneshot;
use gpui::{Context, Task};
use objc2_foundation::{NSFileManager, NSString, NSURL};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    capture::{self, Capture, Settings, Source, Sources},
    choose::{self, Choice},
    library::{self, Recording},
    player::Player,
    transcript,
};

const NO_KEY: &str = "Transcription needs an AI Gateway key";

/// What to record next. Kept between launches.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preferences {
    /// None records the main screen.
    pub source: Option<Source>,
    pub microphone: bool,
    pub system_audio: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            source: None,
            microphone: true,
            system_audio: true,
        }
    }
}

pub enum Session {
    Idle,
    Starting,
    Recording(Box<Active>),
    Stopping,
}

pub struct Active {
    capture: Capture,
    pub recording: Recording,
    pub started: Instant,
}

/// The key transcription uses, as far as the window and agents need to know.
#[derive(Clone, Debug, PartialEq)]
pub enum KeyStatus {
    Looking,
    Found { origin: String, hint: String },
    Missing,
}

pub struct Recorder {
    pub recordings: Vec<Recording>,
    /// The recording shown, or None for the page that starts one.
    pub selected: Option<u64>,
    pub preferences: Preferences,
    /// What could be recorded when last looked.
    pub sources: Sources,
    pub session: Session,
    pub transcribing: HashSet<u64>,
    pub key: KeyStatus,
    /// Why the last attempt to record failed, until the next one.
    pub problem: Option<String>,
    /// The shown recording's video, ready to play in the window.
    pub playback: Option<Playback>,
}

pub struct Playback {
    pub id: u64,
    pub player: Player,
}

impl Recorder {
    pub fn new(preferences: Preferences, cx: &mut Context<Self>) -> Self {
        let recorder = Self {
            recordings: library::load(),
            selected: None,
            preferences,
            sources: Sources::default(),
            session: Session::Idle,
            transcribing: HashSet::new(),
            key: KeyStatus::Looking,
            problem: None,
            playback: None,
        };
        cx.spawn(async move |this, cx| {
            let key = find_key().await;
            this.update(cx, |this, cx| {
                this.key = key;
                cx.notify();
            })
        })
        .detach();
        recorder
    }

    pub fn recording(&self, id: u64) -> Option<&Recording> {
        self.recordings.iter().find(|recording| recording.id == id)
    }

    fn recording_mut(&mut self, id: u64) -> Option<&mut Recording> {
        self.recordings
            .iter_mut()
            .find(|recording| recording.id == id)
    }

    /// The recording `id` names, or the selected one.
    fn target(&self, id: Option<u64>) -> Result<u64, String> {
        id.or(self.selected)
            .filter(|&id| self.recording(id).is_some())
            .ok_or_else(|| match id {
                Some(id) => format!("No recording has id {id}"),
                None => "No recording is selected".into(),
            })
    }

    /// What recording would record: the chosen source, or the main screen.
    pub fn chosen_source(&self) -> Option<Source> {
        resolve(self.preferences.source, &self.sources)
    }

    pub fn is_idle(&self) -> bool {
        matches!(self.session, Session::Idle)
    }

    pub fn active(&self) -> Option<&Active> {
        match &self.session {
            Session::Recording(active) => Some(active),
            _ => None,
        }
    }

    pub fn refresh_sources(&mut self, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        cx.spawn(async move |this, cx| {
            let sources = capture::sources().await?;
            this.update(cx, |this, cx| {
                this.sources = sources;
                cx.notify();
            })
            .map_err(|error| error.to_string())
        })
    }

    /// The screen or window `choice` means. Words are matched against what can be recorded
    /// right now, so the list is looked at again first.
    pub fn choose(
        &mut self,
        choice: Choice,
        cx: &mut Context<Self>,
    ) -> Task<Result<Source, String>> {
        let words = match choice {
            Choice::Id(source) => return Task::ready(Ok(source)),
            Choice::Words(words) => words,
        };
        cx.spawn(async move |this, cx| {
            let sources = capture::sources().await?;
            let understood = this
                .update(cx, |this, cx| {
                    this.sources = sources.clone();
                    cx.notify();
                    choose::understand(words, sources, cx)
                })
                .map_err(|error| error.to_string())?;
            understood.await
        })
    }

    /// Starts recording with the preferences, after applying `changes` to them.
    pub fn start(
        &mut self,
        changes: impl FnOnce(&mut Preferences),
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        if !self.is_idle() {
            return Task::ready(Err("Already recording".into()));
        }
        changes(&mut self.preferences);
        let preferences = self.preferences;
        self.session = Session::Starting;
        self.problem = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let started = begin(preferences).await;
            this.update(cx, |this, cx| {
                cx.notify();
                match started {
                    Ok((sources, source, mut capture, recording)) => {
                        this.sources = sources;
                        let poster = recording.poster();
                        cx.spawn(async move |_, _| save_poster(source, poster).await)
                            .detach();
                        // Recording can stop on its own, like when the window being recorded
                        // closes. It's saved the same way.
                        if let Some(interrupted) = capture.interrupted() {
                            cx.spawn(async move |this, cx| {
                                if interrupted.await.is_ok() {
                                    this.update(cx, |this, cx| this.stop(cx).detach()).ok();
                                }
                            })
                            .detach();
                        }
                        this.session = Session::Recording(Box::new(Active {
                            capture,
                            recording,
                            started: Instant::now(),
                        }));
                        this.show(None);
                        Ok(())
                    }
                    Err(error) => {
                        this.session = Session::Idle;
                        this.problem = Some(error.clone());
                        Err(error)
                    }
                }
            })
            .map_err(|error| error.to_string())?
        })
    }

    /// Stops recording, saves it, shows it and starts transcribing it.
    pub fn stop(&mut self, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        // A stream that stops on its own right after being stopped asks again, once idle, and
        // must leave the session as it is.
        let active = match std::mem::replace(&mut self.session, Session::Stopping) {
            Session::Recording(active) => active,
            session => {
                let stopping = matches!(session, Session::Stopping);
                self.session = session;
                return Task::ready(if stopping {
                    Ok(())
                } else {
                    Err("Not recording".into())
                });
            }
        };
        cx.notify();
        let executor = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let Active {
                capture,
                mut recording,
                started,
            } = *active;
            let stopped = capture.stop(&executor).await;
            recording.duration = started.elapsed().as_secs_f64();
            let saved = recording.save();
            let id = recording.id;
            this.update(cx, |this, cx| {
                this.session = Session::Idle;
                this.recordings.insert(0, recording);
                this.show(Some(id));
                if let Err(error) = &stopped {
                    this.problem = Some(error.clone());
                }
                cx.notify();
                this.transcribe(Some(id), cx).detach();
            })
            .map_err(|error| error.to_string())?;
            stopped.and(saved)
        })
    }

    /// Transcribes a recording, replacing any transcript it has.
    pub fn transcribe(
        &mut self,
        id: Option<u64>,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        let id = match self.target(id) {
            Ok(id) => id,
            Err(error) => return Task::ready(Err(error)),
        };
        let Some((microphone, system_audio)) = self.recording(id).map(Recording::audio) else {
            return Task::ready(Err(format!("No recording has id {id}")));
        };
        if microphone.is_none() && system_audio.is_none() {
            return Task::ready(Err("This recording has no audio to transcribe".into()));
        }
        if !self.transcribing.insert(id) {
            return Task::ready(Ok(()));
        }
        cx.notify();
        let (sender, receiver) = oneshot::channel();
        // The request takes a while, and blocks a thread the whole time.
        thread::spawn(move || {
            let lines = ai::keys::find(Provider::Gateway)
                .ok_or_else(|| NO_KEY.to_string())
                .and_then(|key| {
                    transcript::transcribe(&key, microphone.as_deref(), system_audio.as_deref())
                });
            sender.send(lines).ok();
        });
        cx.spawn(async move |this, cx| {
            let lines = receiver
                .await
                .unwrap_or_else(|_| Err("Transcription stopped unexpectedly".into()));
            this.update(cx, |this, cx| {
                this.transcribing.remove(&id);
                cx.notify();
                let recording = this
                    .recording_mut(id)
                    .ok_or("The recording was removed while it was transcribed")?;
                match lines {
                    Ok(lines) => {
                        recording.transcript = Some(lines);
                        recording.transcription_error = None;
                        recording.save()
                    }
                    Err(error) => {
                        recording.transcription_error = Some(error.clone());
                        recording.save().ok();
                        Err(error)
                    }
                }
            })
            .map_err(|error| error.to_string())?
        })
    }

    pub fn select(&mut self, id: Option<u64>) -> Result<(), String> {
        if let Some(id) = id {
            self.target(Some(id))?;
        }
        self.show(id);
        Ok(())
    }

    /// Shows recording `id`, or the page that starts one, with the recording's video ready to
    /// play.
    fn show(&mut self, id: Option<u64>) {
        self.selected = id;
        if self.playback.as_ref().map(|playback| playback.id) == id {
            return;
        }
        self.playback = id.and_then(|id| {
            let recording = self.recording(id)?;
            let video = recording.files().video;
            let player = Player::open(&video, recording.duration).filter(|_| video.exists())?;
            Some(Playback { id, player })
        });
    }

    /// Plays recording `id`, or the shown one, from `from` seconds in if given, showing it.
    pub fn play(&mut self, id: Option<u64>, from: Option<f64>) -> Result<(), String> {
        let id = self.target(id)?;
        self.show(Some(id));
        let playback = self
            .playback
            .as_ref()
            .ok_or("This recording's video is missing")?;
        if let Some(from) = from {
            playback.player.seek(from);
        }
        playback.player.play();
        Ok(())
    }

    pub fn pause(&mut self) {
        if let Some(playback) = &self.playback {
            playback.player.pause();
        }
    }

    pub fn toggle_playback(&mut self) -> Result<(), String> {
        match &self.playback {
            Some(playback) if playback.player.is_playing() => {
                playback.player.pause();
                Ok(())
            }
            _ => self.play(None, None),
        }
    }

    /// Moves playback `seconds` later, or earlier when negative.
    pub fn skip(&mut self, seconds: f64) {
        if let Some(playback) = &self.playback {
            playback.player.seek(playback.player.time() + seconds);
        }
    }

    /// Moves playback to `seconds` in, without starting or stopping it.
    pub fn seek(&mut self, seconds: f64) {
        if let Some(playback) = &self.playback {
            playback.player.seek(seconds);
        }
    }

    /// Moves the selection through the new-recording page, then each recording.
    pub fn select_by_offset(&mut self, offset: isize) {
        let pages: Vec<_> = std::iter::once(None)
            .chain(self.recordings.iter().map(|recording| Some(recording.id)))
            .collect();
        let current = pages
            .iter()
            .position(|page| *page == self.selected)
            .unwrap_or(0);
        let next = current.saturating_add_signed(offset).min(pages.len() - 1);
        self.show(pages[next]);
    }

    pub fn rename_speaker(
        &mut self,
        id: Option<u64>,
        speaker: &str,
        name: &str,
    ) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Speakers need a name".into());
        }
        let id = self.target(id)?;
        let recording = self.recording_mut(id).ok_or("No such recording")?;
        recording.rename_speaker(speaker, name)?;
        recording.save()
    }

    pub fn move_to_trash(&mut self, id: Option<u64>) -> Result<(), String> {
        let id = self.target(id)?;
        let index = self
            .recordings
            .iter()
            .position(|recording| recording.id == id)
            .ok_or("No such recording")?;
        let folder = &self.recordings[index].folder;
        // The player would keep the video open.
        if self
            .playback
            .as_ref()
            .is_some_and(|playback| playback.id == id)
        {
            self.playback = None;
        }
        let url = NSURL::fileURLWithPath(&NSString::from_str(&folder.to_string_lossy()));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|error| {
                format!(
                    "Couldn't move it to the Trash: {}",
                    error.localizedDescription()
                )
            })?;
        self.recordings.remove(index);
        if self.selected == Some(id) {
            let next = self
                .recordings
                .get(index.min(self.recordings.len().saturating_sub(1)))
                .map(|recording| recording.id);
            self.show(next);
        }
        Ok(())
    }

    /// What agents see in `get_state`.
    pub fn report(&self) -> Value {
        let status = match self.session {
            Session::Idle => "idle",
            Session::Starting => "starting",
            Session::Recording(_) => "recording",
            Session::Stopping => "stopping",
        };
        let recordings: Vec<_> = self
            .recordings
            .iter()
            .map(|recording| {
                let transcript = if self.transcribing.contains(&recording.id) {
                    json!("transcribing")
                } else if recording.transcript.is_some() {
                    json!(recording.transcript_file())
                } else {
                    Value::Null
                };
                json!({
                    "id": recording.id,
                    "title": recording.title,
                    "started": recording.started().strftime("%Y-%m-%dT%H:%M:%S%:z").to_string(),
                    "duration_seconds": recording.duration.round(),
                    "folder": recording.folder,
                    "video": recording.files().video,
                    "transcript": transcript,
                    "speakers": recording.speakers(),
                    "transcription_error": recording.transcription_error,
                })
            })
            .collect();
        json!({
            "status": status,
            "recording": self.active().map(|active| json!({
                "title": active.recording.title,
                "elapsed_seconds": active.started.elapsed().as_secs(),
                "folder": active.recording.folder,
            })),
            "problem": self.problem,
            "next": {
                "source": self.preferences.source,
                "microphone": self.preferences.microphone,
                "system_audio": self.preferences.system_audio,
            },
            "sources": self.sources,
            "recordings": recordings,
            "selected": self.selected,
            "playback": self.playback.as_ref().map(|playback| json!({
                "id": playback.id,
                "playing": playback.player.is_playing(),
                "seconds": (playback.player.time() * 10.).round() / 10.,
            })),
            "transcription_key": match &self.key {
                KeyStatus::Found { origin, hint } => json!(format!("{origin}, {hint}")),
                KeyStatus::Looking => json!("looking"),
                KeyStatus::Missing => Value::Null,
            },
        })
    }
}

/// What `chosen` means among the `sources` there are now. A screen that's been unplugged since
/// it was chosen gives way to the main screen, since screens come and go with a laptop and are
/// renumbered when they do. A window that's closed stays chosen, so recording says it's gone.
fn resolve(chosen: Option<Source>, sources: &Sources) -> Option<Source> {
    let connected = |id| sources.screens.iter().any(|screen| screen.id == id);
    match chosen {
        Some(Source::Screen(id)) if connected(id) => chosen,
        Some(Source::Window(_)) => chosen,
        _ => sources
            .screens
            .first()
            .map(|screen| Source::Screen(screen.id)),
    }
}

/// Looks for what to record, then starts recording it into a new recording's folder.
async fn begin(preferences: Preferences) -> Result<(Sources, Source, Capture, Recording), String> {
    let sources = capture::sources().await?;
    let source = resolve(preferences.source, &sources).ok_or("No screen to record")?;
    let title = match source {
        Source::Screen(_) => "Screen Recording".to_string(),
        Source::Window(id) => {
            let window = sources
                .windows
                .iter()
                .find(|window| window.id == id)
                .ok_or("That window isn't open anymore")?;
            if window.title.is_empty() {
                window.app.clone()
            } else {
                window.title.clone()
            }
        }
    };
    let recording = Recording::create(&title, preferences.microphone, preferences.system_audio)?;
    let settings = Settings {
        source,
        microphone: preferences.microphone,
        system_audio: preferences.system_audio,
    };
    match Capture::start(settings, &recording.files()).await {
        Ok(capture) => Ok((sources, source, capture, recording)),
        Err(error) => {
            recording.discard();
            Err(error)
        }
    }
}

/// Saves a still of what's being recorded, shown for the recording in the window.
async fn save_poster(source: Source, path: PathBuf) {
    let Ok(still) = capture::snapshot(source, 960.).await else {
        return;
    };
    if let Ok(jpeg) = imaging::codec::encode(&still, imaging::codec::Format::Jpeg, 0.8) {
        std::fs::write(path, jpeg).ok();
    }
}

/// Finds the transcription key on another thread, since the first look may wait on the login
/// shell.
async fn find_key() -> KeyStatus {
    let (sender, receiver) = oneshot::channel();
    thread::spawn(move || {
        sender.send(ai::keys::find(Provider::Gateway)).ok();
    });
    match receiver.await.ok().flatten() {
        Some(key) => KeyStatus::Found {
            origin: key.origin(),
            hint: key.hint(),
        },
        None => KeyStatus::Missing,
    }
}
