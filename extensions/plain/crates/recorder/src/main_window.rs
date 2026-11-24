mod recording;

use std::{cell::Cell, ops::Range, rc::Rc, sync::Arc, time::Duration};

use gpui::{
    AnyElement, Context, Div, Entity, FocusHandle, ImageSource, IntoElement, ObjectFit,
    ParentElement, Pixels, Render, RenderImage, ScrollHandle, SharedString, Styled, Subscription,
    Task, UniformListScrollHandle, Window, WindowVisibility, div, img, prelude::*, px,
    uniform_list,
};
use image::Frame;
use imaging::RgbaImage;
use kit::{
    ActiveTheme, Button, ButtonVariant, Grid, GridCell, Icon, Segmented, StyledExt, icon, text,
};

use crate::{
    actions::{
        RecordScreen, RecordWindow, RefreshSources, Select, SetSource, ShowNewRecording,
        ToggleMicrophone, TogglePlayback, ToggleRecording, ToggleSystemAudio,
    },
    capture::{self, Source},
    library::{self, Recording},
    recorder::{Recorder, Session},
    transcript,
};

/// How often the preview of what would be recorded refreshes.
const PREVIEW_INTERVAL: Duration = Duration::from_millis(400);

/// The app window: recordings in a sidebar, and beside them either the page that starts a
/// recording, with a live preview of what it would record, or the selected recording with its
/// transcript. Every change goes through an action handled app-wide.
pub struct MainWindow {
    recorder: Entity<Recorder>,
    focus_handle: FocusHandle,
    recordings: UniformListScrollHandle,
    sources: UniformListScrollHandle,
    transcript: ScrollHandle,
    /// What the chosen screen or window shows right now.
    preview: Option<Arc<RenderImage>>,
    /// Refreshes `preview` while the page that starts a recording shows.
    previewing: Option<Task<()>>,
    /// Redraws every second while recording, for the time.
    ticker: Option<Task<()>>,
    /// The shown recording's current video frame, and which recording it's of.
    video: Option<(u64, Arc<RenderImage>)>,
    /// Draws the shown recording's video as it plays.
    drawing_video: Option<Task<()>>,
    /// Which recording and moment, in thirtieths of a second, the shown still is of, while
    /// paused.
    still_of: Option<(u64, i64)>,
    /// Fetches a still for where playback is paused.
    fetching_still: Option<Task<()>>,
    /// A speaker's name being edited.
    renaming: Option<recording::Renaming>,
    /// The transcript turn playback was last at, to keep it in view as it changes.
    followed_turn: Option<usize>,
    /// Whether the playhead is being dragged.
    scrubbing: Rc<Cell<bool>>,
    _observe: Subscription,
}

impl MainWindow {
    pub fn new(recorder: Entity<Recorder>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        window.focus(&focus_handle, cx);
        // The window lists what can be recorded, so the list starts out current.
        cx.dispatch_action(&RefreshSources);
        Self {
            _observe: cx.observe(&recorder, |_, _, cx| cx.notify()),
            recorder,
            focus_handle,
            recordings: UniformListScrollHandle::new(),
            sources: UniformListScrollHandle::new(),
            transcript: ScrollHandle::new(),
            preview: None,
            previewing: None,
            ticker: None,
            video: None,
            drawing_video: None,
            still_of: None,
            fetching_still: None,
            renaming: None,
            followed_turn: None,
            scrubbing: Rc::default(),
        }
    }

    /// Keeps the shown recording time current, only while recording.
    fn tick(&mut self, recording: bool, cx: &mut Context<Self>) {
        if !recording {
            self.ticker = None;
        } else if self.ticker.is_none() {
            self.ticker = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    /// Refreshes the preview a few times a second while `wanted` and the window can be seen,
    /// and lets it go otherwise.
    fn keep_previewing(&mut self, wanted: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !wanted {
            self.previewing = None;
            if let Some(old) = self.preview.take() {
                window.drop_image(old).ok();
            }
            return;
        }
        if self.previewing.is_some() {
            return;
        }
        self.previewing = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let source = this.update_in(cx, |this, window, cx| {
                    let visible = window.visibility() == WindowVisibility::Visible;
                    visible
                        .then(|| this.recorder.read(cx).chosen_source())
                        .flatten()
                });
                let Ok(source) = source else {
                    break;
                };
                if let Some(source) = source
                    && let Ok(still) = capture::snapshot(source, 900.).await
                {
                    let shown = this.update_in(cx, |this, window, cx| {
                        if let Some(old) = this.preview.replace(texture(still)) {
                            window.drop_image(old).ok();
                        }
                        cx.notify();
                    });
                    if shown.is_err() {
                        break;
                    }
                }
                cx.background_executor().timer(PREVIEW_INTERVAL).await;
            }
        }));
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let recorder = self.recorder.read(cx);
        let elapsed = recorder
            .active()
            .map(|active| transcript::timestamp(active.started.elapsed().as_secs_f64()));
        let count = recorder.recordings.len();
        div()
            .w(px(220.))
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.border)
            .child(kit::titlebar())
            .child(
                div().px(px(6.)).child(
                    kit::row("new-recording", recorder.selected.is_none(), cx)
                        .h(px(32.))
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ShowNewRecording), cx)
                        })
                        .child(
                            icon(if elapsed.is_some() {
                                Icon::Recording
                            } else {
                                Icon::Record
                            })
                            .text_color(theme.text),
                        )
                        .child(div().flex_1().child(if elapsed.is_some() {
                            "Recording"
                        } else {
                            "New Recording"
                        }))
                        .children(elapsed.map(|elapsed| div().tabular_nums().child(elapsed))),
                ),
            )
            .child(
                div()
                    .h(px(28.))
                    .px(px(14.))
                    .flex()
                    .items_end()
                    .pb(px(4.))
                    .text_size(text::SMALL)
                    .text_color(theme.text_muted)
                    .child("Recordings"),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .relative()
                    .child(
                        uniform_list(
                            "recordings",
                            count,
                            cx.processor(|this, range: Range<usize>, _, cx| {
                                let recorder = this.recorder.read(cx);
                                recorder.recordings[range]
                                    .iter()
                                    .map(|recording| {
                                        recording_row(
                                            recording,
                                            recorder.selected == Some(recording.id),
                                            recorder.transcribing.contains(&recording.id),
                                            cx,
                                        )
                                    })
                                    .collect()
                            }),
                        )
                        .track_scroll(&self.recordings)
                        .size_full()
                        .px(px(6.)),
                    )
                    .child(kit::scrollbar("recordings-scrollbar", &self.recordings)),
            )
    }

    fn render_new_recording(&self, cx: &mut Context<Self>) -> Div {
        let theme = cx.theme();
        let recorder = self.recorder.read(cx);
        let preferences = recorder.preferences;
        let window_chosen = matches!(preferences.source, Some(Source::Window(_)));
        let idle = recorder.is_idle();
        let source_count = if window_chosen {
            recorder.sources.windows.len()
        } else {
            recorder.sources.screens.len()
        };
        let record = match &recorder.session {
            Session::Idle => Button::new("record", "Record", ToggleRecording).icon(Icon::Record),
            Session::Starting => Button::new("record", "Starting", ToggleRecording)
                .icon(Icon::Record)
                .disabled(true),
            Session::Recording(_) => {
                Button::new("record", "Stop", ToggleRecording).icon(Icon::Stop)
            }
            Session::Stopping => Button::new("record", "Saving", ToggleRecording)
                .icon(Icon::Stop)
                .disabled(true),
        };
        pane("New Recording", cx).child(
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .px(px(12.))
                .pb(px(12.))
                .child(picture(
                    self.preview.clone().map(ImageSource::Render),
                    None,
                    cx,
                ))
                .child(
                    Segmented::new("source-kind")
                        .option("Screen", RecordScreen)
                        .option("Window", RecordWindow)
                        .chosen(Some(usize::from(window_chosen))),
                )
                .child(
                    div()
                        .h(px(120.))
                        .flex_none()
                        .relative()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(theme.border)
                        .child(
                            uniform_list(
                                "sources",
                                source_count,
                                cx.processor(move |this, range: Range<usize>, _, cx| {
                                    this.render_sources(window_chosen, range, cx)
                                }),
                            )
                            .track_scroll(&self.sources)
                            .size_full()
                            .p(px(4.)),
                        )
                        .child(kit::scrollbar("sources-scrollbar", &self.sources)),
                )
                .child(
                    div().flex().child(
                        Grid::new("audio").grow().cells([
                            GridCell::text("Microphone", ToggleMicrophone::default())
                                .on(preferences.microphone)
                                .disabled(!idle),
                            GridCell::text("System Audio", ToggleSystemAudio::default())
                                .on(preferences.system_audio)
                                .disabled(!idle),
                        ]),
                    ),
                )
                .children(
                    recorder
                        .problem
                        .clone()
                        .map(|problem| div().text_color(theme.text).child(problem)),
                )
                .child(
                    div()
                        .flex()
                        .child(record.variant(ButtonVariant::Primary).grow()),
                ),
        )
    }

    fn render_sources(
        &self,
        windows: bool,
        range: Range<usize>,
        cx: &Context<Self>,
    ) -> Vec<AnyElement> {
        let recorder = self.recorder.read(cx);
        let chosen = recorder.chosen_source();
        let entries: Vec<(Source, SharedString, SharedString)> = if windows {
            recorder.sources.windows[range]
                .iter()
                .map(|window| {
                    (
                        Source::Window(window.id),
                        window.app.clone().into(),
                        window.title.clone().into(),
                    )
                })
                .collect()
        } else {
            recorder.sources.screens[range.clone()]
                .iter()
                .zip(range)
                .map(|(screen, index)| {
                    let name = if index == 0 {
                        "Main Screen".to_string()
                    } else {
                        format!("Screen {}", index + 1)
                    };
                    (
                        Source::Screen(screen.id),
                        name.into(),
                        format!("{} × {}", screen.width, screen.height).into(),
                    )
                })
                .collect()
        };
        let theme = cx.theme();
        entries
            .into_iter()
            .map(|(source, name, detail)| {
                let id = match source {
                    Source::Screen(id) | Source::Window(id) => id,
                };
                kit::row(("source", id), chosen == Some(source), cx)
                    .on_click(move |_, window, cx| {
                        let source = source.into();
                        window.dispatch_action(Box::new(SetSource { source }), cx)
                    })
                    .child(div().flex_none().child(name))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .truncate()
                            .text_color(theme.text_muted)
                            .child(detail),
                    )
                    .into_any_element()
            })
            .collect()
    }
}

/// A picture of a screen, letterboxed: the live preview of what would be recorded, or a
/// recording's video, which plays or pauses when clicked. With no `height` it takes the space
/// that's left.
fn picture(
    image: Option<ImageSource>,
    height: Option<Pixels>,
    cx: &Context<MainWindow>,
) -> AnyElement {
    let theme = cx.theme();
    let video = height.is_some();
    div()
        .id(if video { "video" } else { "preview" })
        .map(|this| match height {
            Some(height) => this.h(height).flex_none(),
            None => this.flex_1().min_h(px(120.)),
        })
        .rounded(px(6.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center()
        .children(image.map(|image| img(image).size_full().object_fit(ObjectFit::Contain)))
        .when(video, |this| {
            this.cursor_pointer()
                .on_click(|_, window, cx| window.dispatch_action(Box::new(TogglePlayback), cx))
        })
        .into_any_element()
}

/// A still as a texture GPUI can draw, which takes its pixels as BGRA.
fn texture(still: RgbaImage) -> Arc<RenderImage> {
    bgra_texture(swap_red_and_blue(still))
}

fn swap_red_and_blue(mut still: RgbaImage) -> RgbaImage {
    still
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .for_each(|pixel| pixel.swap(0, 2));
    still
}

/// Pixels that are already BGRA as a texture.
fn bgra_texture(pixels: RgbaImage) -> Arc<RenderImage> {
    Arc::new(RenderImage::new([Frame::new(pixels)]))
}

/// A detail pane with its title in the titlebar strip.
fn pane(title: impl Into<SharedString>, cx: &Context<MainWindow>) -> Div {
    div().flex_1().min_w(px(0.)).flex().flex_col().child(
        kit::titlebar()
            .justify_center()
            .px(px(12.))
            .text_color(cx.theme().text_muted)
            .child(div().truncate().child(title.into())),
    )
}

fn placeholder(message: impl Into<SharedString>, cx: &Context<MainWindow>) -> Div {
    div()
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .px(px(24.))
        .border_t_1()
        .border_color(cx.theme().border)
        .text_color(cx.theme().text_faint)
        .child(message.into())
}

fn recording_row(
    recording: &Recording,
    selected: bool,
    transcribing: bool,
    cx: &Context<MainWindow>,
) -> AnyElement {
    let theme = cx.theme();
    let id = recording.id;
    let when = recording
        .started()
        .strftime("%b %-d, %-I:%M %p")
        .to_string();
    let detail = if transcribing {
        format!("{when} · Transcribing")
    } else {
        format!("{when} · {}", library::duration(recording.duration))
    };
    kit::row(("recording", id), selected, cx)
        .h(px(44.))
        .on_click(move |_, window, cx| window.dispatch_action(Box::new(Select { id }), cx))
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .flex()
                .flex_col()
                .child(div().truncate().child(recording.title.clone()))
                .child(
                    div()
                        .truncate()
                        .text_size(text::SMALL)
                        .text_color(theme.text_muted)
                        .child(detail),
                ),
        )
        .into_any_element()
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (recording, selected) = {
            let recorder = self.recorder.read(cx);
            let selected = recorder
                .selected
                .and_then(|id| recorder.recording(id))
                .cloned();
            (recorder.active().is_some(), selected)
        };
        self.tick(recording, cx);
        self.keep_previewing(selected.is_none(), window, cx);
        self.keep_drawing_video(selected.as_ref().map(|recording| recording.id), window, cx);
        let detail = match selected {
            Some(recording) => self.render_recording(&recording, cx),
            None => self.render_new_recording(cx),
        };
        kit::root(cx)
            .flex_row()
            .track_focus(&self.focus_handle)
            .key_context("Recorder")
            .child(self.render_sidebar(cx))
            .child(detail)
    }
}
