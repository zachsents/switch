//! Typing a crop in words while cropping, like "square" or "the left half", in the line under
//! the picture. The crop's frame previews what the words mean as they're typed, and Enter crops
//! through `crop_to`, so the window and agents read words the same way.

use std::time::Duration;

use gpui::{
    Action, AnyElement, App, AppContext, Context, Entity, InteractiveElement, IntoElement,
    ParentElement, StatefulInteractiveElement, Styled, Subscription, Task, Window, div, prelude::*,
    px,
};
use kit::{ActiveTheme, TextField, TextFieldEvent};

use super::DocumentWindow;
use crate::{
    actions::{CropTo, DescribeCrop, ToggleCrop},
    crop::Rect,
    framing::{self, Framing},
};

/// Words being typed for the crop.
pub(super) struct CropWords {
    input: Entity<TextField>,
    /// What the decision model made of words the parser couldn't read.
    understood: Option<(String, Result<Framing, String>)>,
    /// Asks the decision model about the words once typing pauses.
    reading: Option<Task<()>>,
    _events: Subscription,
    /// Redraws the window as the words change, for the preview.
    _changes: Subscription,
}

impl CropWords {
    /// What the typed words mean, once known.
    fn framing(&self, cx: &App) -> Option<Result<Framing, String>> {
        let text = self.input.read(cx).text().trim();
        match Framing::parse(text) {
            Ok(framing) => Some(Ok(framing)),
            Err(_) => self
                .understood
                .as_ref()
                .filter(|(understood, _)| understood == text)
                .map(|(_, framing)| framing.clone()),
        }
    }
}

impl DocumentWindow {
    /// Opens a field for the crop in words, cropping first if it hasn't started. Enter or
    /// clicking away crops to the words; Escape leaves the crop as it was.
    pub(super) fn describe_crop(
        &mut self,
        _: &DescribeCrop,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.crop_editor.is_none() {
            self.toggle_crop(&ToggleCrop, window, cx);
        }
        if self
            .crop_editor
            .as_ref()
            .is_none_or(|editor| editor.words.is_some())
        {
            return;
        }
        let input = cx.new(|cx| TextField::new("", window, cx));
        let events = cx.subscribe_in(&input, window, |this, input, event, window, cx| {
            let words = input.read(cx).text().trim().to_string();
            if let TextFieldEvent::Confirm = event
                && !words.is_empty()
            {
                let crop = CropTo {
                    document: Some(this.id(cx)),
                    to: words,
                };
                window.dispatch_action(crop.boxed_clone(), cx);
            }
            // Cancelling moves focus away, which also confirms, so only the first event counts.
            let closed = this
                .crop_editor
                .as_mut()
                .and_then(|editor| editor.words.take());
            if closed.is_some() {
                window.focus(&this.focus_handle, cx);
                cx.notify();
            }
        });
        let changes = cx.observe(&input, |this, _, cx| {
            this.read_typed_crop(cx);
            cx.notify();
        });
        if let Some(editor) = &mut self.crop_editor {
            editor.words = Some(CropWords {
                input,
                understood: None,
                reading: None,
                _events: events,
                _changes: changes,
            });
        }
        cx.notify();
    }

    /// Once typing pauses on words the parser can't read, asks the decision model what they
    /// mean, so the frame can preview them before Enter.
    fn read_typed_crop(&mut self, cx: &mut Context<Self>) {
        let size = self.crop_target(cx).map(|(_, size)| size);
        let Some(words) = self
            .crop_editor
            .as_mut()
            .and_then(|editor| editor.words.as_mut())
        else {
            return;
        };
        let text = words.input.read(cx).text().trim().to_string();
        words.reading = None;
        if text.is_empty() || words.framing(cx).is_some() {
            return;
        }
        let Some((width, height)) = size else {
            return;
        };
        words.reading = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(350))
                .await;
            let Ok(understanding) = this.update(cx, |_, cx| {
                framing::understand(text.clone(), width, height, cx)
            }) else {
                return;
            };
            let understood = understanding.await;
            this.update(cx, |this, cx| {
                let words = this
                    .crop_editor
                    .as_mut()
                    .and_then(|editor| editor.words.as_mut());
                if let Some(words) = words {
                    words.understood = Some((text, understood));
                    words.reading = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The crop the typed words make, for the frame to show before Enter, or why they can't
    /// crop. None until there are words and they've been read.
    pub(super) fn crop_preview(&self, cx: &App) -> Option<Result<Rect, String>> {
        let (_, (width, height)) = self.crop_target(cx)?;
        let framing = self.crop_editor.as_ref()?.words.as_ref()?.framing(cx)?;
        Some(
            framing
                .and_then(|framing| framing.crop_on(width, height))
                .map(|crop| crop.map_or(Rect::whole(width, height), |crop| crop.rect)),
        )
    }

    /// The crop's size, which opens the field for words when clicked, or while typing, the
    /// field and the size the words make.
    pub(super) fn render_crop_words(
        &self,
        rect: Rect,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme();
        let row = div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .items_center()
            .gap(px(8.));
        let dimensions = |rect: Rect| format!("{} × {}", rect.width, rect.height);
        let Some(words) = self
            .crop_editor
            .as_ref()
            .and_then(|editor| editor.words.as_ref())
        else {
            return row
                .child(
                    div()
                        .id("crop-words")
                        .relative()
                        .flex_none()
                        .px(px(6.))
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.surface))
                        .on_click(|_, window, cx| {
                            window.dispatch_action(DescribeCrop.boxed_clone(), cx)
                        })
                        .child(dimensions(rect))
                        .children(kit::reveal_shortcut(&DescribeCrop, window, cx)),
                )
                .when_some(self.document.read(cx).problem.clone(), |row, problem| {
                    row.child(div().min_w(px(0.)).truncate().child(problem))
                })
                .into_any_element();
        };
        let note = match self.crop_preview(cx) {
            Some(Ok(previewed)) => dimensions(previewed),
            Some(Err(problem)) => problem,
            None if words.reading.is_some() => "…".into(),
            None => dimensions(rect),
        };
        row.child(div().w(px(160.)).flex_none().child(words.input.clone()))
            .child(div().min_w(px(0.)).truncate().child(note))
            .into_any_element()
    }
}
