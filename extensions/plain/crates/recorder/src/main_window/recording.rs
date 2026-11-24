//! The page for one recording: its video, playing in place, and its transcript, which follows
//! the playback and jumps it to any line that's clicked.

use std::time::Duration;

use gpui::{
    AnyElement, App, Bounds, Context, CursorStyle, Div, Entity, FontWeight, HighlightStyle,
    HitboxBehavior, ImageSource, InteractiveText, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Styled, StyledText, Subscription, Window,
    WindowVisibility, canvas, div, fill, point, prelude::*, px, size,
};
use kit::{ActiveTheme, Grid, GridCell, Icon, StyledExt, TextField, TextFieldEvent, Theme, text};

use super::{MainWindow, bgra_texture, pane, picture, placeholder, texture};
use crate::{
    actions::{
        CopyTranscript, MoveToTrash, Play, PlayVideo, RenameSpeaker, ShowInFinder, TogglePlayback,
        Transcribe,
    },
    library::Recording,
    recorder::Recorder,
    transcript::{Line, timestamp},
};

/// How big video frames are drawn, on their longer side, in pixels.
const FRAME_SIZE: usize = 1280;
const VIDEO_HEIGHT: Pixels = px(260.);

/// A speaker's name being edited in place.
pub(super) struct Renaming {
    turn: usize,
    input: Entity<TextField>,
    _events: Subscription,
}

impl MainWindow {
    /// Draws recording `shown`'s video as it plays, and lets go of its frames once it isn't
    /// shown.
    pub(super) fn keep_drawing_video(
        &mut self,
        shown: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.video.as_ref().map(|(id, _)| *id) != shown
            && let Some((_, old)) = self.video.take()
        {
            window.drop_image(old).ok();
        }
        if shown.is_none() {
            self.drawing_video = None;
            self.still_of = None;
            self.fetching_still = None;
            self.followed_turn = None;
            return;
        }
        if self.drawing_video.is_some() {
            return;
        }
        self.drawing_video = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let playing =
                    this.update_in(cx, |this, window, cx| this.draw_video_frame(window, cx));
                let Ok(playing) = playing else {
                    break;
                };
                // About every frame while playing; often enough to catch a seek while paused.
                let wait = if playing { 33 } else { 150 };
                cx.background_executor()
                    .timer(Duration::from_millis(wait))
                    .await;
            }
        }));
    }

    /// Takes the shown recording's newest frame while it plays, or a still of where it's paused,
    /// and keeps the line being said in view. Returns whether it's playing.
    fn draw_video_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let visible = window.visibility() == WindowVisibility::Visible;
        let (id, playing, frame, turn, still) = {
            let recorder = self.recorder.read(cx);
            let Some(playback) = recorder
                .playback
                .as_ref()
                .filter(|playback| Some(playback.id) == recorder.selected)
            else {
                return false;
            };
            let player = &playback.player;
            let frame = visible.then(|| player.frame(FRAME_SIZE)).flatten();
            let turn = recorder
                .recording(playback.id)
                .and_then(|recording| recording.transcript.as_deref())
                .and_then(|lines| current_line(lines, player.time()).map(|at| turn_of(lines, at)));
            let playing = player.is_playing();
            let moment = (playback.id, (player.time() * 30.).round() as i64);
            // A still is fetched once per moment, so it's fetched even while the window is
            // hidden, ready for when it shows.
            let still =
                (!playing && self.still_of != Some(moment) && self.fetching_still.is_none())
                    .then(|| (moment, player.still(player.time())));
            (playback.id, playing, frame, turn, still)
        };
        if let Some((moment, still)) = still {
            self.fetching_still = Some(cx.spawn_in(window, async move |this, cx| {
                let still = still.await.ok().flatten();
                this.update_in(cx, |this, window, cx| {
                    this.fetching_still = None;
                    // A still the video couldn't give yet, before it's loaded, is asked for
                    // again on the next tick.
                    let Some(still) = still else {
                        return;
                    };
                    this.still_of = Some(moment);
                    if let Some((_, old)) = this.video.replace((moment.0, texture(still))) {
                        window.drop_image(old).ok();
                    }
                    cx.notify();
                })
                .ok();
            }));
        }
        if let Some(frame) = frame {
            if let Some((_, old)) = self.video.replace((id, bgra_texture(frame))) {
                window.drop_image(old).ok();
            }
            cx.notify();
        } else if playing {
            cx.notify();
        }
        if playing && turn != self.followed_turn {
            if let Some(turn) = turn {
                self.transcript.scroll_to_item(turn);
            }
            self.followed_turn = turn;
        }
        playing
    }

    pub(super) fn render_recording(&self, recording: &Recording, cx: &mut Context<Self>) -> Div {
        let theme = *cx.theme();
        let recorder = self.recorder.read(cx);
        let transcribing = recorder.transcribing.contains(&recording.id);
        let (now, playing) = recorder
            .playback
            .as_ref()
            .filter(|playback| playback.id == recording.id)
            .map_or((None, false), |playback| {
                (Some(playback.player.time()), playback.player.is_playing())
            });
        // The poster shows until the video's first frame arrives.
        let shown = self
            .video
            .as_ref()
            .filter(|(id, _)| *id == recording.id)
            .map(|(_, frame)| ImageSource::Render(frame.clone()))
            .or_else(|| {
                let poster = recording.poster();
                poster.exists().then(|| ImageSource::from(poster))
            });
        let body = match (&recording.transcript, &recording.transcription_error) {
            _ if transcribing => placeholder("Transcribing", cx),
            (Some(lines), _) if !lines.is_empty() => {
                self.render_transcript(recording.id, lines, now, &theme, cx)
            }
            (Some(_), _) => placeholder("No speech", cx),
            (None, Some(error)) => placeholder(error.clone(), cx),
            (None, None) => placeholder("No transcript", cx),
        };
        pane(recording.title.clone(), cx)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(12.))
                    .pb(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .truncate()
                            .text_color(theme.text_muted)
                            .child(recording.subtitle()),
                    )
                    .child(
                        Grid::new("recording-actions").cells([
                            GridCell::icon(Icon::Export, "Open Video", PlayVideo),
                            GridCell::icon(Icon::Folder, "Show in Finder", ShowInFinder),
                            GridCell::icon(Icon::Copy, "Copy Transcript", CopyTranscript)
                                .disabled(recording.transcript.is_none()),
                            GridCell::icon(
                                Icon::Transcript,
                                "Transcribe Again",
                                Transcribe::default(),
                            )
                            .disabled(transcribing),
                            GridCell::icon(Icon::Trash, "Move to Trash", MoveToTrash::default()),
                        ]),
                    ),
            )
            .child(
                div()
                    .px(px(12.))
                    .pb(px(8.))
                    .child(picture(shown, Some(VIDEO_HEIGHT), cx)),
            )
            .child(self.render_controls(recording.duration, now.unwrap_or(0.), playing, &theme))
            .child(body)
    }

    /// Play or pause, the playhead, and the time.
    fn render_controls(&self, duration: f64, now: f64, playing: bool, theme: &Theme) -> Div {
        let toggle = if playing {
            GridCell::icon(Icon::Pause, "Pause", TogglePlayback)
        } else {
            GridCell::icon(Icon::Play, "Play", TogglePlayback)
        };
        div()
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(12.))
            .pb(px(12.))
            .child(Grid::new("playback").cell(toggle))
            .child(self.scrubber(now, duration, theme))
            .child(
                div()
                    .flex_none()
                    .tabular_nums()
                    .text_size(text::SMALL)
                    .text_color(theme.text_muted)
                    .child(format!("{} / {}", timestamp(now), timestamp(duration))),
            )
    }

    /// The playhead on a line for the whole recording. Clicking or dragging along it moves
    /// playback there.
    fn scrubber(&self, now: f64, duration: f64, theme: &Theme) -> impl IntoElement + use<> {
        let recorder = self.recorder.clone();
        let scrubbing = self.scrubbing.clone();
        let theme = *theme;
        let progress = (now / duration.max(0.001)).clamp(0., 1.) as f32;
        canvas(
            |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
            move |bounds, hitbox, window, _| {
                let track = Bounds::new(
                    point(bounds.left(), bounds.center().y - px(2.)),
                    size(bounds.size.width, px(4.)),
                );
                window.paint_quad(fill(track, theme.surface).corner_radii(px(2.)));
                let played = Bounds::new(track.origin, size(track.size.width * progress, px(4.)));
                window.paint_quad(fill(played, theme.text_muted).corner_radii(px(2.)));
                let head = Bounds::centered_at(
                    point(track.left() + track.size.width * progress, track.center().y),
                    size(px(10.), px(10.)),
                );
                window.paint_quad(fill(head, theme.text).corner_radii(px(5.)));
                window.set_cursor_style(CursorStyle::PointingHand, &hitbox);

                let seek = move |x: Pixels, recorder: &Entity<Recorder>, cx: &mut App| {
                    let fraction = ((x - bounds.left()) / bounds.size.width).clamp(0., 1.);
                    recorder.update(cx, |recorder, cx| {
                        recorder.seek(f64::from(fraction) * duration);
                        cx.notify();
                    });
                };
                window.on_mouse_event({
                    let (recorder, scrubbing) = (recorder.clone(), scrubbing.clone());
                    move |event: &MouseDownEvent, phase, window, cx| {
                        if phase.bubble()
                            && event.button == MouseButton::Left
                            && hitbox.is_hovered(window)
                        {
                            scrubbing.set(true);
                            seek(event.position.x, &recorder, cx);
                            cx.stop_propagation();
                        }
                    }
                });
                window.on_mouse_event({
                    let (recorder, scrubbing) = (recorder.clone(), scrubbing.clone());
                    move |event: &MouseMoveEvent, phase, _, cx| {
                        if phase.bubble() && scrubbing.get() {
                            if event.dragging() {
                                seek(event.position.x, &recorder, cx);
                            } else {
                                // Let go outside the window, where the release isn't seen.
                                scrubbing.set(false);
                            }
                        }
                    }
                });
                window.on_mouse_event({
                    let scrubbing = scrubbing.clone();
                    move |_: &MouseUpEvent, _, _, _| scrubbing.set(false)
                });
            },
        )
        .flex_1()
        .h(px(16.))
    }

    /// The transcript, a paragraph per turn. The line being said is highlighted, and clicking
    /// any line plays from it.
    fn render_transcript(
        &self,
        id: u64,
        lines: &[Line],
        now: Option<f64>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Div {
        let current = now.and_then(|now| current_line(lines, now));
        let turns: Vec<_> = lines
            .chunk_by(|a, b| a.speaker == b.speaker)
            .scan(0, |next, said| {
                let first = *next;
                *next += said.len();
                Some((first, said))
            })
            .enumerate()
            .map(|(turn, (first, said))| {
                let current = current
                    .filter(|line| (first..first + said.len()).contains(line))
                    .map(|line| line - first);
                self.render_turn(id, turn, said, current, theme, cx)
            })
            .collect();
        div()
            .flex_1()
            .min_h(px(0.))
            .relative()
            .border_t_1()
            .border_color(theme.border)
            .child(
                div()
                    .id("transcript")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.transcript)
                    .p(px(12.))
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .children(turns),
            )
            .child(kit::scrollbar("transcript-scrollbar", &self.transcript))
    }

    /// One speaker's turn: their name, which is clicked to rename them, when they started, and
    /// what they said. `current` is the line being said, counted within the turn.
    fn render_turn(
        &self,
        id: u64,
        turn: usize,
        said: &[Line],
        current: Option<usize>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut text = String::new();
        let ranges: Vec<_> = said
            .iter()
            .map(|line| {
                if !text.is_empty() {
                    text.push(' ');
                }
                let start = text.len();
                text.push_str(&line.text);
                start..text.len()
            })
            .collect();
        let highlight = current.map(|line| {
            let style = HighlightStyle {
                background_color: Some(theme.selection),
                ..HighlightStyle::default()
            };
            (ranges[line].clone(), style)
        });
        let starts: Vec<_> = said.iter().map(|line| line.start).collect();
        let speaker = said[0].speaker.clone();
        let name = match &self.renaming {
            Some(renaming) if renaming.turn == turn => div()
                .w(px(200.))
                .child(renaming.input.clone())
                .into_any_element(),
            _ => div()
                .id(("speaker", turn))
                .px(px(4.))
                .mx(px(-4.))
                .rounded(px(4.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|style| style.bg(theme.surface))
                .on_click(cx.listener({
                    let speaker = speaker.clone();
                    move |this, _, window, cx| {
                        this.start_renaming(turn, speaker.clone(), window, cx)
                    }
                }))
                .child(speaker)
                .into_any_element(),
        };
        let from = said[0].start;
        let play_from = move |seconds: f64, window: &mut Window, cx: &mut App| {
            let play = Play {
                id: Some(id),
                from: Some(seconds.to_string()),
            };
            window.dispatch_action(Box::new(play), cx);
        };
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div().flex().items_center().gap(px(8.)).child(name).child(
                    div()
                        .id(("time", turn))
                        .tabular_nums()
                        .text_color(theme.text_muted)
                        .cursor_pointer()
                        .on_click(move |_, window, cx| play_from(from, window, cx))
                        .child(timestamp(from)),
                ),
            )
            .child(
                div().cursor_pointer().child(
                    InteractiveText::new(
                        ("said", turn),
                        StyledText::new(text).with_highlights(highlight),
                    )
                    .on_click(ranges, move |line, window, cx| {
                        play_from(starts[line], window, cx)
                    }),
                ),
            )
            .into_any_element()
    }

    /// Replaces a speaker's name with a field holding it. Enter or clicking away renames them
    /// throughout the transcript; Escape cancels.
    fn start_renaming(
        &mut self,
        turn: usize,
        speaker: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.recorder.read(cx).selected else {
            return;
        };
        let input = cx.new(|cx| TextField::new(speaker.clone(), window, cx));
        let events = cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
            let name = input.read(cx).text().trim().to_string();
            if matches!(event, TextFieldEvent::Confirm) && !name.is_empty() && name != speaker {
                let rename = RenameSpeaker {
                    id: Some(id),
                    speaker: speaker.clone(),
                    name,
                };
                window.dispatch_action(Box::new(rename), cx);
            }
            // Cancelling moves focus away, which also confirms, so only the first event counts:
            // dropping the field drops this subscription.
            if this.renaming.take().is_some() {
                window.focus(&this.focus_handle, cx);
                cx.notify();
            }
        });
        self.renaming = Some(Renaming {
            turn,
            input,
            _events: events,
        });
        cx.notify();
    }
}

/// The line being said `seconds` in: the last one started by then.
fn current_line(lines: &[Line], seconds: f64) -> Option<usize> {
    lines.iter().rposition(|line| line.start <= seconds + 0.05)
}

/// Which turn, a run of lines by one speaker, line `index` is in.
fn turn_of(lines: &[Line], index: usize) -> usize {
    lines[..=index]
        .chunk_by(|a, b| a.speaker == b.speaker)
        .count()
        - 1
}
