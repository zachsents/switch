//! A text input for forms and messages: one line, or many that wrap, with a placeholder, masking
//! for secrets and a numbers-only mode. Unlike [`TextField`](crate::TextField), which edits a
//! name in place, it doesn't take the keyboard when it appears, and it reports every change as
//! it's typed.
//!
//! A multi-line input grows with what's in it, from the fewest lines [`Input::rows`] gives it to
//! the most, then scrolls. One that sends with Enter ([`Input::submit_on_enter`]) starts a new
//! line with ⇧ or ⌥ Enter. It moves and deletes by word (⌥) and to the line's ends (⌘) the way
//! macOS text does, selects a word with a double click and a paragraph with a triple, and
//! undoes a run of typing at a time.
//!
//! It answers to the same keys as `TextField` (its key context is `TextField`), so single-key
//! shortcuts bound with `!TextField` stay off while it has focus.

use std::{
    ops::Range,
    time::{Duration, Instant},
};

use gpui::{
    App, Bounds, BoxShadow, ClipboardItem, ContentMask, Context, CursorStyle, ElementId,
    ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    GlobalElementId, KeyDownEvent, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PaintQuad, Pixels, Point, ScrollWheelEvent, SharedString, Style, TextRun,
    UTF16Selection, UnderlineStyle, Window, WrappedLine, black, div, fill, point, prelude::*, px,
    relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    ActiveTheme, TEXT_FIELD_CONTEXT, text,
    text_field::{
        Backspace, Cancel, Confirm, Copy, Cut, Delete, DeleteToHome, DeleteWordLeft,
        DeleteWordRight, End, Home, Left, Newline, Paste, Redo, Right, SelectAll, SelectEnd,
        SelectHome, SelectLeft, SelectRight, SelectTextEnd, SelectTextStart, SelectWordLeft,
        SelectWordRight, ShowCharacterPalette, TextEnd, TextStart, Undo, WordLeft, WordRight,
    },
};

/// A pause this long ends a run of typing, so what's typed next undoes on its own.
const TYPING_RUN: Duration = Duration::from_millis(1500);
/// How many edits Undo can go back through.
const HISTORY: usize = 200;

/// What happened in an [`Input`].
pub enum InputEvent {
    /// The text changed; read it with [`Input::text`].
    Changed,
    /// Enter in a single-line input, or in a multi-line one that sends with Enter.
    Submit,
    /// The input took the keyboard.
    Focus,
    /// Focus left the input.
    Blur,
    /// Escape. The input lets go of the keyboard (unless it keeps it, see
    /// [`Input::blur_on_escape`]), then passes [`Cancel`] on, so what holds it can close too: a
    /// sheet, a panel, an edit.
    Cancel,
}

/// What a drag selects by: whatever the click that started it selected.
#[derive(Clone, Copy, PartialEq)]
enum Unit {
    Character,
    Word,
    Paragraph,
}

/// The kind of the last edit, so a run of typing or deleting undoes as one.
#[derive(Clone, Copy, PartialEq)]
enum Run {
    Typing,
    Deleting,
}

#[derive(Clone)]
struct Snapshot {
    content: String,
    selected_range: Range<usize>,
    selection_reversed: bool,
}

pub struct Input {
    focus_handle: FocusHandle,
    content: String,
    placeholder: SharedString,
    multiline: bool,
    obscured: bool,
    numeric: bool,
    /// Drawn without its own frame, for a container that draws one.
    bare: bool,
    /// Shows its text and lets it be selected and copied, but takes no edits.
    read_only: bool,
    /// Enter sends rather than starting a new line.
    submit_on_enter: bool,
    /// Escape lets go of the keyboard.
    blur_on_escape: bool,
    /// The fewest and most lines a multi-line input shows; past the most, it scrolls.
    rows: (usize, Option<usize>),
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    /// Each paragraph as last laid out, with where it starts in the shown text and its top.
    layout: Vec<(WrappedLine, usize, Pixels)>,
    last_bounds: Option<Bounds<Pixels>>,
    /// The height of a line, as last laid out.
    line_height: Pixels,
    /// How far the text is scrolled up, when it's taller than the input shows.
    scroll_top: Pixels,
    /// How tall the text is, as last laid out.
    content_height: Pixels,
    /// Bring the cursor into sight at the next paint, after an edit or a move.
    reveal_cursor: bool,
    is_selecting: bool,
    unit: Unit,
    /// What the click that started a drag selected; the drag extends from it.
    anchor: Range<usize>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    run: Option<(Run, Instant)>,
    _focus: gpui::Subscription,
    _blur: gpui::Subscription,
}

impl EventEmitter<InputEvent> for Input {}

impl Input {
    /// An empty single-line input. It doesn't take focus.
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle().tab_index(0).tab_stop(true);
        Self {
            _focus: cx.on_focus(&focus_handle, window, |_, _, cx| cx.emit(InputEvent::Focus)),
            _blur: cx.on_blur(&focus_handle, window, |_, _, cx| cx.emit(InputEvent::Blur)),
            focus_handle,
            content: String::new(),
            placeholder: SharedString::default(),
            multiline: false,
            obscured: false,
            numeric: false,
            bare: false,
            read_only: false,
            submit_on_enter: false,
            blur_on_escape: true,
            rows: (3, None),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            layout: Vec::new(),
            last_bounds: None,
            line_height: text::BODY * 1.4,
            scroll_top: px(0.),
            content_height: px(0.),
            reveal_cursor: false,
            is_selecting: false,
            unit: Unit::Character,
            anchor: 0..0,
            undo: Vec::new(),
            redo: Vec::new(),
            run: None,
        }
    }

    /// Shown, faint, while it's empty.
    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    /// Takes several lines: Enter starts a new one, and long lines wrap.
    pub fn multiline(mut self, multiline: bool) -> Self {
        self.multiline = multiline;
        self
    }

    /// Shows a dot for each character, for passwords and other secrets.
    pub fn obscured(mut self, obscured: bool) -> Self {
        self.obscured = obscured;
        self
    }

    /// Takes only what can make a number: digits, a point, a leading minus.
    pub fn numeric(mut self, numeric: bool) -> Self {
        self.numeric = numeric;
        self
    }

    /// Draws only the text, for a container that draws the frame, like a widget in its own
    /// look.
    pub fn bare(mut self, bare: bool) -> Self {
        self.bare = bare;
        self
    }

    /// Shows its text, which can be selected and copied, but takes no edits.
    pub fn read_only(mut self, read_only: bool) -> Self {
        self.read_only = read_only;
        self
    }

    /// In a multi-line input, Enter sends ([`InputEvent::Submit`]) and ⇧ or ⌥ Enter starts a
    /// new line, as in a message box.
    pub fn submit_on_enter(mut self, submit: bool) -> Self {
        self.submit_on_enter = submit;
        self
    }

    /// Whether Escape lets go of the keyboard (it does unless set). A message box that stays
    /// ready to type keeps it; Escape still goes on to what holds the input.
    pub fn blur_on_escape(mut self, blur: bool) -> Self {
        self.blur_on_escape = blur;
        self
    }

    /// How many lines a multi-line input shows: at least `min`, growing with its text up to
    /// `max` (no limit without one), past which it scrolls. Three and no limit unless set.
    pub fn rows(mut self, min: usize, max: Option<usize>) -> Self {
        self.rows = (min.max(1), max.map(|max| max.max(min.max(1))));
        self
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    /// Puts the keyboard here.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus_handle, cx);
    }

    pub fn is_focused(&self, window: &Window) -> bool {
        self.focus_handle.is_focused(window)
    }

    /// Replaces the text, as when the value it edits changed elsewhere. The cursor goes to the
    /// end and what Undo had is forgotten. It doesn't report a change.
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        let text = text.into();
        if text == self.content {
            return;
        }
        self.content = text;
        self.selected_range = self.content.len()..self.content.len();
        self.selection_reversed = false;
        self.marked_range = None;
        self.undo.clear();
        self.redo.clear();
        self.run = None;
        self.reveal_cursor = true;
        cx.notify();
    }

    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.placeholder = placeholder.into();
        cx.notify();
    }

    pub fn set_read_only(&mut self, read_only: bool, cx: &mut Context<Self>) {
        if self.read_only != read_only {
            self.read_only = read_only;
            self.marked_range = None;
            cx.notify();
        }
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// Changes how many lines it shows, as [`Input::rows`] sets them.
    pub fn set_rows(&mut self, min: usize, max: Option<usize>, cx: &mut Context<Self>) {
        self.rows = (min.max(1), max.map(|max| max.max(min.max(1))));
        cx.notify();
    }

    /// The selected range, in bytes of the text; empty where the cursor is.
    pub fn selection(&self) -> Range<usize> {
        self.selected_range.clone()
    }

    /// Where the cursor is, in bytes of the text.
    pub fn cursor(&self) -> usize {
        self.cursor_offset()
    }

    /// How many lines the text takes, wrapped as last drawn.
    pub fn lines(&self) -> usize {
        if self.layout.is_empty() || self.line_height <= px(0.) {
            return self.content.split('\n').count();
        }
        (self.content_height / self.line_height).round().max(1.) as usize
    }

    /// Selects `range` of the text (in bytes, clamped to it and to whole characters).
    pub fn select(&mut self, range: Range<usize>, window: &Window, cx: &mut Context<Self>) {
        let start = self.floor_char(range.start);
        let end = self.floor_char(range.end).max(start);
        self.set_selection(start..end, false, window, cx);
    }

    /// Puts the cursor at the end of the text.
    pub fn move_to_end(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), window, cx);
    }

    /// Puts `text` where the selection is, as pasting it would: one step of Undo, reported as a
    /// change.
    pub fn insert(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.edit(self.selected_range.clone(), text, None, window, cx);
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn accept(&self, text: &str) -> String {
        let text = if self.multiline {
            text.replace("\r\n", "\n")
        } else {
            text.replace(['\n', '\r'], " ")
        };
        if !self.numeric {
            return text;
        }
        text.chars()
            .filter(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | ',' | 'e' | 'E' | '+'))
            .collect()
    }

    // ---- Editing ----

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            content: self.content.clone(),
            selected_range: self.selected_range.clone(),
            selection_reversed: self.selection_reversed,
        }
    }

    /// Keeps what's there for Undo before an edit, unless the edit continues a run of the same
    /// kind.
    fn remember(&mut self, run: Option<Run>) {
        let now = Instant::now();
        let continues = matches!(
            (run, self.run),
            (Some(run), Some((last, at))) if run == last && now.duration_since(at) < TYPING_RUN
        );
        if !continues {
            self.undo.push(self.snapshot());
            if self.undo.len() > HISTORY {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.run = run.map(|run| (run, now));
    }

    /// Replaces `range` with `new_text`, leaving the cursor after it.
    fn edit(
        &mut self,
        range: Range<usize>,
        new_text: &str,
        run: Option<Run>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.read_only {
            return;
        }
        let new_text = self.accept(new_text);
        if range.is_empty() && new_text.is_empty() {
            return;
        }
        self.remember(run);
        self.content =
            self.content[0..range.start].to_owned() + &new_text + &self.content[range.end..];
        self.selected_range = range.start + new_text.len()..range.start + new_text.len();
        self.selection_reversed = false;
        self.marked_range = None;
        self.reveal_cursor = true;
        window.notify_text_input_changed(&self.focus_handle);
        self.changed(cx);
    }

    fn restore(&mut self, snapshot: Snapshot, window: &mut Window, cx: &mut Context<Self>) {
        self.content = snapshot.content;
        self.selected_range = snapshot.selected_range;
        self.selection_reversed = snapshot.selection_reversed;
        self.marked_range = None;
        self.run = None;
        self.reveal_cursor = true;
        window.notify_text_input_changed(&self.focus_handle);
        self.changed(cx);
    }

    fn undo(&mut self, _: &Undo, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        if let Some(snapshot) = self.undo.pop() {
            self.redo.push(self.snapshot());
            self.restore(snapshot, window, cx);
        }
    }

    fn redo(&mut self, _: &Redo, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        if let Some(snapshot) = self.redo.pop() {
            self.undo.push(self.snapshot());
            self.restore(snapshot, window, cx);
        }
    }

    /// Deletes the selection, or from the cursor to `to` when nothing's selected.
    fn delete_to(&mut self, to: usize, window: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selected_range.is_empty() {
            let at = self.cursor_offset();
            at.min(to)..at.max(to)
        } else {
            self.selected_range.clone()
        };
        let run = (self.selected_range.is_empty() && self.next_boundary(range.start) >= range.end)
            .then_some(Run::Deleting);
        self.edit(range, "", run, window, cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn delete_word_left(
        &mut self,
        _: &DeleteWordLeft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_to(self.word_start_before(self.cursor_offset()), window, cx);
    }

    fn delete_word_right(
        &mut self,
        _: &DeleteWordRight,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_to(self.word_end_after(self.cursor_offset()), window, cx);
    }

    fn delete_to_home(&mut self, _: &DeleteToHome, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.cursor_offset();
        let start = self.line_start(at);
        // At a line's start, ⌘⌫ joins it to the line before, as macOS does.
        let to = if start == at {
            self.previous_boundary(at)
        } else {
            start
        };
        self.delete_to(to, window, cx);
    }

    fn confirm(&mut self, _: &Confirm, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline && !self.submit_on_enter {
            self.edit(self.selected_range.clone(), "\n", None, window, cx);
        } else {
            cx.emit(InputEvent::Submit);
        }
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            self.edit(self.selected_range.clone(), "\n", None, window, cx);
        } else {
            cx.emit(InputEvent::Submit);
        }
    }

    fn cancel(&mut self, _: &Cancel, window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Cancel);
        if self.blur_on_escape {
            window.blur(cx);
        }
        // What holds it hears Escape too.
        cx.propagate();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.edit(self.selected_range.clone(), &text, None, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() && !self.obscured {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        } else {
            // Nothing selected here: what's selected on the page is copied instead.
            cx.propagate();
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() && !self.obscured && !self.read_only {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.edit(self.selected_range.clone(), "", None, window, cx)
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        if !self.read_only {
            window.show_character_palette();
        }
    }

    // ---- Moving ----

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), window, cx);
        } else {
            self.move_to(self.selected_range.start, window, cx)
        }
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), window, cx);
        } else {
            self.move_to(self.selected_range.end, window, cx)
        }
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn word_left(&mut self, _: &WordLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.word_start_before(self.cursor_offset()), window, cx);
    }

    fn word_right(&mut self, _: &WordRight, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.word_end_after(self.cursor_offset()), window, cx);
    }

    fn select_word_left(
        &mut self,
        _: &SelectWordLeft,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_to(self.word_start_before(self.cursor_offset()), window, cx);
    }

    fn select_word_right(
        &mut self,
        _: &SelectWordRight,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_to(self.word_end_after(self.cursor_offset()), window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.set_selection(0..self.content.len(), false, window, cx);
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_start(self.cursor_offset()), window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_end(self.cursor_offset()), window, cx);
    }

    fn select_home(&mut self, _: &SelectHome, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_start(self.cursor_offset()), window, cx);
    }

    fn select_end(&mut self, _: &SelectEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_end(self.cursor_offset()), window, cx);
    }

    fn text_start(&mut self, _: &TextStart, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, window, cx);
    }

    fn text_end(&mut self, _: &TextEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), window, cx);
    }

    fn select_text_start(
        &mut self,
        _: &SelectTextStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_to(0, window, cx);
    }

    fn select_text_end(&mut self, _: &SelectTextEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.content.len(), window, cx);
    }

    /// Up and Down move between lines, Tab moves to the next field.
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = &keystroke.modifiers;
        match keystroke.key.as_str() {
            "tab" if !modifiers.platform && !modifiers.control && !modifiers.alt => {
                if modifiers.shift {
                    window.focus_prev(cx);
                } else {
                    window.focus_next(cx);
                }
                cx.stop_propagation();
            }
            key @ ("up" | "down")
                if self.multiline && !modifiers.platform && !modifiers.control =>
            {
                let target = self.vertical(self.cursor_offset(), key == "up");
                if modifiers.shift {
                    self.select_to(target, window, cx);
                } else {
                    self.move_to(target, window, cx);
                }
                cx.stop_propagation();
            }
            _ => {}
        }
    }

    /// The offset a line above or below `offset`, at about the same x: the text's start above
    /// its first line, and its end below its last.
    fn vertical(&self, offset: usize, up: bool) -> usize {
        let line_height = self.line_height;
        let Some(at) = self.position_for(offset) else {
            return if up { 0 } else { self.content.len() };
        };
        let y = if up {
            at.y - line_height
        } else {
            at.y + line_height
        };
        if y < px(0.) {
            return 0;
        }
        if y >= self.content_height {
            return self.content.len();
        }
        self.index_at(point(at.x, y + line_height / 2.))
            .unwrap_or(self.content.len())
    }

    // ---- Mouse ----

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        self.is_selecting = true;
        self.run = None;
        let index = self.index_for_mouse_position(event.position);
        match event.click_count {
            0 | 1 => {
                self.unit = Unit::Character;
                if event.modifiers.shift {
                    self.select_to(index, window, cx);
                } else {
                    self.move_to(index, window, cx);
                }
                self.anchor = self.selected_range.clone();
            }
            2 => {
                self.unit = Unit::Word;
                self.anchor = self.word_range_at(index);
                self.set_selection(self.anchor.clone(), false, window, cx);
            }
            _ => {
                self.unit = Unit::Paragraph;
                self.anchor = self.paragraph_range_at(index);
                self.set_selection(self.anchor.clone(), false, window, cx);
            }
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.is_selecting {
            return;
        }
        let index = self.index_for_mouse_position(event.position);
        let under = match self.unit {
            Unit::Character => {
                self.select_to(index, window, cx);
                return;
            }
            Unit::Word => self.word_range_at(index),
            Unit::Paragraph => self.paragraph_range_at(index),
        };
        if under.start < self.anchor.start {
            self.set_selection(under.start..self.anchor.end, true, window, cx);
        } else {
            self.set_selection(
                self.anchor.start..under.end.max(self.anchor.end),
                false,
                window,
                cx,
            );
        }
    }

    fn on_scroll(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(bounds) = self.last_bounds else {
            return;
        };
        let overflow = self.content_height - bounds.size.height;
        if overflow <= px(0.) {
            return;
        }
        let delta = event.delta.pixel_delta(self.line_height).y;
        let next = (self.scroll_top - delta).clamp(px(0.), overflow);
        if next != self.scroll_top {
            self.scroll_top = next;
            self.reveal_cursor = false;
            cx.notify();
            cx.stop_propagation();
        }
    }

    fn move_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        self.set_selection(offset..offset, false, window, cx);
    }

    fn set_selection(
        &mut self,
        range: Range<usize>,
        reversed: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        self.selected_range = range;
        self.selection_reversed = reversed && !self.selected_range.is_empty();
        self.run = None;
        self.reveal_cursor = true;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify()
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn select_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset
        } else {
            self.selected_range.end = offset
        };
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        self.run = None;
        self.reveal_cursor = true;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify()
    }

    fn floor_char(&self, offset: usize) -> usize {
        let mut offset = offset.min(self.content.len());
        while !self.content.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(index, _)| (index < offset).then_some(index))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(index, _)| (index > offset).then_some(index))
            .unwrap_or(self.content.len())
    }

    /// The start of the word before `offset`, or of the one it's in, as ⌥← goes. A secret has
    /// no words to show, so it goes to the start.
    fn word_start_before(&self, offset: usize) -> usize {
        if self.obscured {
            return 0;
        }
        self.content
            .split_word_bound_indices()
            .rev()
            .find(|(start, segment)| *start < offset && is_word(segment))
            .map_or(0, |(start, _)| start)
    }

    /// The end of the word after `offset`, or of the one it's in, as ⌥→ goes.
    fn word_end_after(&self, offset: usize) -> usize {
        if self.obscured {
            return self.content.len();
        }
        self.content
            .split_word_bound_indices()
            .find(|(start, segment)| start + segment.len() > offset && is_word(segment))
            .map_or(self.content.len(), |(start, segment)| start + segment.len())
    }

    /// The word (or run of spaces, or mark) at `offset`, as a double click selects it.
    fn word_range_at(&self, offset: usize) -> Range<usize> {
        if self.obscured {
            return 0..self.content.len();
        }
        let segments: Vec<Range<usize>> = self
            .content
            .split_word_bound_indices()
            .map(|(start, segment)| start..start + segment.len())
            .collect();
        let after = segments.iter().find(|range| range.contains(&offset));
        let before = segments.iter().find(|range| range.end == offset);
        match (before, after) {
            (Some(before), Some(after))
                if is_word(&self.content[before.clone()])
                    && !is_word(&self.content[after.clone()]) =>
            {
                before.clone()
            }
            (_, Some(after)) => after.clone(),
            (Some(before), None) => before.clone(),
            (None, None) => offset..offset,
        }
    }

    /// The paragraph at `offset`, as a triple click selects it.
    fn paragraph_range_at(&self, offset: usize) -> Range<usize> {
        let offset = self.floor_char(offset);
        let start = self.content[..offset].rfind('\n').map_or(0, |at| at + 1);
        let end = self.content[offset..]
            .find('\n')
            .map_or(self.content.len(), |at| offset + at);
        start..end
    }

    /// Where the line `offset` is on starts, as ⌘← goes.
    fn line_start(&self, offset: usize) -> usize {
        if !self.multiline {
            return 0;
        }
        self.content[..self.floor_char(offset)]
            .rfind('\n')
            .map_or(0, |at| at + 1)
    }

    /// Where the line `offset` is on ends, as ⌘→ goes.
    fn line_end(&self, offset: usize) -> usize {
        if !self.multiline {
            return self.content.len();
        }
        let offset = self.floor_char(offset);
        self.content[offset..]
            .find('\n')
            .map_or(self.content.len(), |at| offset + at)
    }

    // ---- Shown text ----

    /// The text as drawn: dots for a secret.
    fn shown(&self) -> String {
        if self.obscured {
            "•".repeat(self.content.chars().count())
        } else {
            self.content.clone()
        }
    }

    /// Converts an offset in the content to one in the shown text.
    fn to_shown(&self, offset: usize) -> usize {
        if self.obscured {
            self.content[..offset.min(self.content.len())]
                .chars()
                .count()
                * '•'.len_utf8()
        } else {
            offset
        }
    }

    /// Converts an offset in the shown text to one in the content.
    fn to_content(&self, offset: usize) -> usize {
        if self.obscured {
            let chars = offset / '•'.len_utf8();
            self.content
                .char_indices()
                .nth(chars)
                .map_or(self.content.len(), |(at, _)| at)
        } else {
            offset.min(self.content.len())
        }
    }

    /// Where content `offset` is drawn, relative to the top left of the whole text (before
    /// scrolling).
    fn position_for(&self, offset: usize) -> Option<Point<Pixels>> {
        let shown = self.to_shown(offset);
        self.layout
            .iter()
            .rev()
            .find(|(_, start, _)| *start <= shown)
            .and_then(|(line, start, top)| {
                line.position_for_index(shown - start, self.line_height)
                    .map(|at| point(at.x, at.y + *top))
            })
    }

    /// The content offset nearest a point relative to the top left of the whole text.
    fn index_at(&self, at: Point<Pixels>) -> Option<usize> {
        let (line, start, top) = self
            .layout
            .iter()
            .rev()
            .find(|(_, _, top)| *top <= at.y)
            .or_else(|| self.layout.first())?;
        let local = line
            .closest_index_for_position(point(at.x, at.y - *top), self.line_height)
            .unwrap_or_else(|index| index);
        Some(self.to_content(start + local))
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let Some(bounds) = self.last_bounds else {
            return 0;
        };
        if self.content.is_empty() {
            return 0;
        }
        self.index_at(position - bounds.origin + point(px(0.), self.scroll_top))
            .unwrap_or(self.content.len())
    }

    // ---- UTF-16, for the platform's text input ----

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;
        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }
        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;
        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }
        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }
}

/// Whether a segment of text is a word rather than spaces or a mark.
fn is_word(segment: &str) -> bool {
    segment.chars().any(char::is_alphanumeric)
}

impl EntityInputHandler for Input {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = self.range_from_utf16(&range_utf16);
        self.set_selection(range, false, window, cx);
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.offset_to_utf16(self.content.len()))
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let run = if new_text.is_empty() {
            Run::Deleting
        } else {
            Run::Typing
        };
        self.edit(range, new_text, Some(run), window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.read_only {
            return;
        }
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let new_text = self.accept(new_text);
        self.remember(Some(Run::Typing));
        self.content =
            self.content[0..range.start].to_owned() + &new_text + &self.content[range.end..];
        self.marked_range =
            (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        let insertion_start_utf16 = self.offset_to_utf16(range.start);
        let inserted_length_utf16 = new_text.encode_utf16().count();
        self.selected_range = new_selected_range_utf16
            .map(|selected| {
                self.range_from_utf16(
                    &(insertion_start_utf16 + selected.start.min(inserted_length_utf16)
                        ..insertion_start_utf16 + selected.end.min(inserted_length_utf16)),
                )
            })
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        self.selection_reversed = false;
        self.reveal_cursor = true;
        window.notify_text_input_changed(&self.focus_handle);
        self.changed(cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        let scroll = point(px(0.), self.scroll_top);
        let start = self.position_for(range.start)? - scroll;
        let end = self.position_for(range.end)? - scroll;
        Some(Bounds::from_corners(
            bounds.origin + start,
            bounds.origin + point(end.x, end.y + self.line_height),
        ))
    }

    fn character_index_for_point(
        &mut self,
        at: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let bounds = self.last_bounds?;
        let index = self.index_at(at - bounds.origin + point(px(0.), self.scroll_top))?;
        Some(self.offset_to_utf16(index))
    }
}

/// Lays out, wraps and paints the text, selection and cursor, and connects the input to the
/// platform's text input.
struct InputElement {
    input: Entity<Input>,
}

struct Prepaint {
    lines: Vec<(WrappedLine, usize, Pixels)>,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
    scroll_top: Pixels,
    content_height: Pixels,
    line_height: Pixels,
}

impl IntoElement for InputElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// Shapes the shown text (or the placeholder), one wrapped line per paragraph, with the top of
/// each paragraph.
fn shape(
    input: &Input,
    width: Option<Pixels>,
    window: &mut Window,
    cx: &App,
) -> Vec<(WrappedLine, usize, Pixels)> {
    let style = window.text_style();
    let theme = cx.theme();
    let (content, color) = if input.content.is_empty() {
        (input.placeholder.to_string(), theme.text_faint)
    } else {
        (input.shown(), style.color)
    };
    let font_size = style.font_size.to_pixels(window.rem_size());
    let line_height = window.line_height();
    let wrap = if input.multiline { width } else { None };
    let mut top = px(0.);
    let mut start = 0;
    let mut lines = Vec::new();
    for paragraph in content.split('\n') {
        let run = TextRun {
            len: paragraph.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match input
            .marked_range
            .as_ref()
            .filter(|_| !input.content.is_empty())
        {
            Some(marked) if marked.start >= start && marked.end <= start + paragraph.len() => {
                let (from, to) = (marked.start - start, marked.end - start);
                [
                    TextRun {
                        len: from,
                        ..run.clone()
                    },
                    TextRun {
                        len: to - from,
                        underline: Some(UnderlineStyle {
                            color: Some(run.color),
                            thickness: px(1.),
                            wavy: false,
                        }),
                        ..run.clone()
                    },
                    TextRun {
                        len: paragraph.len() - to,
                        ..run
                    },
                ]
                .into_iter()
                .filter(|run| run.len > 0)
                .collect::<Vec<_>>()
            }
            _ => vec![run],
        };
        let shaped = window
            .text_system()
            .shape_text(paragraph.to_string().into(), font_size, &runs, wrap, None)
            .ok()
            .and_then(|mut shaped| (!shaped.is_empty()).then(|| shaped.remove(0)));
        if let Some(line) = shaped {
            let height = line.size(line_height).height.max(line_height);
            lines.push((line, start, top));
            top += height;
        }
        start += paragraph.len() + 1;
    }
    lines
}

/// How tall shaped lines are together.
fn height_of(lines: &[(WrappedLine, usize, Pixels)], line_height: Pixels) -> Pixels {
    lines.last().map_or(line_height, |(line, _, top)| {
        *top + line.size(line_height).height.max(line_height)
    })
}

impl Element for InputElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let input = self.input.clone();
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let multiline = input.read(cx).multiline;
        if !multiline {
            style.size.height = window.line_height().into();
            return (window.request_layout(style, [], cx), ());
        }
        let line_height = window.line_height();
        let (min, max) = input.read(cx).rows;
        let id = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.or(match available.width {
                gpui::AvailableSpace::Definite(width) => Some(width),
                _ => None,
            });
            let lines = shape(input.read(cx), width, window, cx);
            let mut height = height_of(&lines, line_height).max(line_height * min as f32);
            if let Some(max) = max {
                height = height.min(line_height * max as f32);
            }
            size(width.unwrap_or(px(0.)), height)
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let input = self.input.read(cx);
        let lines = shape(input, Some(bounds.size.width), window, cx);
        let style = window.text_style();
        let line_height = window.line_height();
        let theme = cx.theme();
        let empty = input.content.is_empty();
        let position = |offset: usize| -> Point<Pixels> {
            if empty {
                return point(px(0.), px(0.));
            }
            let shown = input.to_shown(offset);
            lines
                .iter()
                .rev()
                .find(|(_, start, _)| *start <= shown)
                .and_then(|(line, start, top)| {
                    line.position_for_index(shown - start, line_height)
                        .map(|at| point(at.x, at.y + *top))
                })
                .unwrap_or_default()
        };
        // Scrolled so the cursor stays in sight when the text is taller than the input.
        let content_height = if empty {
            line_height
        } else {
            height_of(&lines, line_height)
        };
        let overflow = (content_height - bounds.size.height).max(px(0.));
        let mut scroll_top = input.scroll_top.clamp(px(0.), overflow);
        if input.reveal_cursor {
            let cursor = position(input.cursor_offset()).y;
            if cursor < scroll_top {
                scroll_top = cursor;
            } else if cursor + line_height > scroll_top + bounds.size.height {
                scroll_top = (cursor + line_height - bounds.size.height).min(overflow);
            }
        }
        let origin = bounds.origin - point(px(0.), scroll_top);
        let (cursor, selections) = if input.selected_range.is_empty() {
            let at = position(input.cursor_offset());
            (
                Some(fill(
                    Bounds::new(origin + at, size(px(1.), line_height)),
                    style.color,
                )),
                Vec::new(),
            )
        } else {
            let (start, end) = (
                position(input.selected_range.start),
                position(input.selected_range.end),
            );
            let mut quads = Vec::new();
            let mut y = start.y;
            while y <= end.y {
                let from = if y == start.y { start.x } else { px(0.) };
                let to = if y == end.y { end.x } else { bounds.size.width };
                quads.push(fill(
                    Bounds::from_corners(
                        origin + point(from, y),
                        origin + point(to, y + line_height),
                    ),
                    theme.selection,
                ));
                y += line_height;
            }
            (None, quads)
        };
        Prepaint {
            lines,
            cursor,
            selections,
            scroll_top,
            content_height,
            line_height,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (focus_handle, read_only) = {
            let input = self.input.read(cx);
            (input.focus_handle.clone(), input.read_only)
        };
        if !read_only {
            window.handle_input(
                &focus_handle,
                ElementInputHandler::new(bounds, self.input.clone()),
                cx,
            );
        }
        let line_height = prepaint.line_height;
        let origin = bounds.origin - point(px(0.), prepaint.scroll_top);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for selection in prepaint.selections.drain(..) {
                window.paint_quad(selection)
            }
            for (line, _, top) in &prepaint.lines {
                line.paint(
                    origin + point(px(0.), *top),
                    line_height,
                    gpui::TextAlign::Left,
                    None,
                    window,
                    cx,
                )
                .ok();
            }
            if focus_handle.is_focused(window)
                && !read_only
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        let lines = std::mem::take(&mut prepaint.lines);
        let (scroll_top, content_height) = (prepaint.scroll_top, prepaint.content_height);
        self.input.update(cx, |input, _| {
            let empty = input.content.is_empty();
            input.layout = if empty { Vec::new() } else { lines };
            input.last_bounds = Some(bounds);
            input.line_height = line_height;
            input.scroll_top = scroll_top;
            input.content_height = content_height;
            input.reveal_cursor = false;
        });
    }
}

impl Render for Input {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let focused = self.focus_handle.is_focused(window);
        // Recessed into the surface: the opposite of a raised button.
        div()
            .key_context(TEXT_FIELD_CONTEXT)
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_home))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::text_start))
            .on_action(cx.listener(Self::text_end))
            .on_action(cx.listener(Self::select_text_start))
            .on_action(cx.listener(Self::select_text_end))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::confirm))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::cancel))
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .when(self.multiline, |this| {
                this.on_scroll_wheel(cx.listener(Self::on_scroll))
            })
            .w_full()
            .flex()
            .items_start()
            .overflow_hidden()
            .when(!self.bare, |this| {
                this.min_h(px(28.))
                    .py(px(5.))
                    .px(px(8.))
                    .rounded(px(5.))
                    .border_1()
                    .border_color(if focused {
                        theme.text_muted
                    } else {
                        theme.field_border
                    })
                    .bg(theme.background)
                    .shadow(vec![
                        BoxShadow::new(px(0.), px(1.), black().opacity(0.25))
                            .blur_radius(px(2.))
                            .inset(),
                    ])
                    .text_color(theme.text)
                    .text_size(text::BODY)
            })
            .line_height(relative(1.4))
            .child(InputElement { input: cx.entity() })
    }
}

impl Focusable for Input {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
