//! A terminal drawn: its screen cell by cell in the house's mono face and the Look's colours, the
//! cursor, the selection, and its keys, pointer and wheel.
//!
//! Keys: while it has the keyboard every key is the program's, Esc and Tab too; ⌘ keys are the
//! app's (⌘K, ⌘[, ⌘W…) but ⌘C, ⌘V and ⌘A, which copy, paste and select here; ⌘Esc leaves it for
//! the message box. Words come through the Mac's input handler, so ⌥'s letters, dead keys and input
//! methods compose as in any field. A program that asks for the pointer (vim, htop, tmux) gets
//! presses, drags and the wheel; ⇧ keeps them for selecting. Otherwise a drag selects (twice, words;
//! three times, lines) and the wheel scrolls the history, or the column once there's no more.

use std::cell::Cell;
use std::rc::Rc;

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor};
use gpui::{
    App, Bounds, Context, ElementInputHandler, Entity, EntityInputHandler, FocusHandle, Focusable, Font, FontStyle, FontWeight, Hsla, InteractiveElement, IntoElement,
    KeyDownEvent, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render, ScrollDelta, ScrollEvent, SharedString, StrikethroughStyle,
    Styled, TextRun, UTF16Selection, UnderlineStyle, Window, canvas, div, fill, point, px, size,
};

use super::colors::{Palette, hsla};
use super::keys;
use super::session::{Ended, Session, Size};
use super::{Op, TerminalDo};
use crate::look::{Look, MONO};

/// A key the terminal takes before the app's bindings would (Esc, Tab), by its name.
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct Key(pub String);

/// ⌘Esc: out of the terminal, to the message box.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct Leave;

/// The text size and its line, at the Look's zoom.
const SIZE: f32 = 11.;
const LINE: f32 = 1.3;
/// Room around the cells.
pub const PAD_X: f32 = 8.;
pub const PAD_Y: f32 = 4.;

/// A cell's size in this window, and where the grid's corner was last drawn.
#[derive(Clone, Copy, Default)]
struct Metrics {
    cell_w: Pixels,
    cell_h: Pixels,
    font_size: Pixels,
    origin: Point<Pixels>,
    bounds: Bounds<Pixels>,
}

pub struct TerminalView {
    pub session: Entity<Session>,
    pub focus: FocusHandle,
    drawn: Rc<Cell<Metrics>>,
    /// A drag selecting, from a press in the cells.
    selecting: bool,
    /// The wheel's part of a line not yet scrolled.
    wheel: f32,
    /// The pointer button a program was told is down.
    reported: Option<u8>,
}

fn font(weight: FontWeight, style: FontStyle) -> Font {
    Font { family: MONO.into(), features: Default::default(), fallbacks: None, weight, style }
}

/// A cell's size for the mono face at the Look's text size.
pub fn cell(l: &Look, window: &Window) -> (Pixels, Pixels, Pixels) {
    let font_size = px((SIZE * l.zoom).round());
    let ts = window.text_system();
    let id = ts.resolve_font(&font(FontWeight::NORMAL, FontStyle::Normal));
    let w = ts.advance(id, font_size, 'm').map(|s| s.width).unwrap_or(font_size * 0.6);
    (w, px((f32::from(font_size) * LINE).round()), font_size)
}

/// How tall a pinned terminal of `rows` rows is.
pub fn height(rows: usize, l: &Look, window: &Window) -> Pixels {
    let (_, h, _) = cell(l, window);
    h * rows as f32 + px(PAD_Y * 2.)
}

impl TerminalView {
    pub fn new(session: Entity<Session>, cx: &mut Context<Self>) -> Self {
        cx.observe(&session, |_, _, cx| cx.notify()).detach();
        cx.subscribe(&session, |this: &mut Self, _, _: &Ended, cx| {
            this.reported = None;
            cx.notify();
        })
        .detach();
        TerminalView { session, focus: cx.focus_handle(), drawn: Rc::new(Cell::new(Metrics::default())), selecting: false, wheel: 0., reported: None }
    }

    fn id(&self, cx: &App) -> String {
        self.session.read(cx).id.clone()
    }

    fn typed(&self, bytes: Vec<u8>, cx: &mut App) {
        self.session.update(cx, |s, _| s.typed(bytes));
    }

    fn key(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let s = self.session.read(cx);
        if s.exited.is_some() {
            if e.keystroke.key == "enter" && !e.keystroke.modifiers.platform {
                self.session.update(cx, |s, cx| s.restart(cx));
                cx.stop_propagation();
            }
            return;
        }
        if let Some(b) = keys::bytes(&e.keystroke, s.mode()) {
            self.session.update(cx, |s, _| s.typed(b));
            cx.stop_propagation();
        }
    }

    /// The cell under a point in the window, and which half of it.
    fn grid_at(&self, at: Point<Pixels>, cx: &App) -> (GridPoint, Side) {
        let m = self.drawn.get();
        let s = self.session.read(cx);
        let size = s.size;
        let x = f32::from(at.x - m.origin.x).max(0.);
        let y = f32::from(at.y - m.origin.y).max(0.);
        let cw = f32::from(m.cell_w).max(1.);
        let ch = f32::from(m.cell_h).max(1.);
        let col = ((x / cw) as usize).min(size.cols.saturating_sub(1));
        let row = ((y / ch) as usize).min(size.rows.saturating_sub(1));
        let side = if x - col as f32 * cw < cw / 2. { Side::Left } else { Side::Right };
        let offset = s.term.lock().grid().display_offset() as i32;
        (GridPoint::new(Line(row as i32 - offset), Column(col)), side)
    }

    /// The cell under a point as a program's mouse report counts it: from 1.
    fn report_cell(&self, at: Point<Pixels>, cx: &App) -> (usize, usize) {
        let m = self.drawn.get();
        let s = self.session.read(cx).size;
        let x = (f32::from(at.x - m.origin.x).max(0.) / f32::from(m.cell_w).max(1.)) as usize;
        let y = (f32::from(at.y - m.origin.y).max(0.) / f32::from(m.cell_h).max(1.)) as usize;
        (x.min(s.cols.saturating_sub(1)) + 1, y.min(s.rows.saturating_sub(1)) + 1)
    }

    /// A pointer report for the program, as it asked for them (SGR, else xterm's bytes).
    fn report(&self, button: u8, down: bool, at: Point<Pixels>, mods: &Modifiers, cx: &App) {
        let (x, y) = self.report_cell(at, cx);
        let mut b = button;
        if mods.shift {
            b += 4;
        }
        if mods.alt {
            b += 8;
        }
        if mods.control {
            b += 16;
        }
        let mode = self.session.read(cx).mode();
        let bytes = if mode.contains(TermMode::SGR_MOUSE) {
            format!("\x1b[<{b};{x};{y}{}", if down { 'M' } else { 'm' }).into_bytes()
        } else {
            // xterm's own: a release is button 3; past 223 it can't say where.
            if x > 223 || y > 223 {
                return;
            }
            let b = if down { b } else { 3 + (b & !3) };
            vec![0x1b, b'[', b'M', 32 + b, 32 + x as u8, 32 + y as u8]
        };
        self.session.read(cx).write(bytes);
    }

    fn mouse_mode(&self, mods: &Modifiers, cx: &App) -> bool {
        !mods.shift && self.session.read(cx).mode().intersects(TermMode::MOUSE_MODE)
    }

    fn down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let button = match e.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            _ => return,
        };
        if self.mouse_mode(&e.modifiers, cx) {
            self.report(button, true, e.position, &e.modifiers, cx);
            self.reported = Some(button);
            cx.stop_propagation();
            return;
        }
        if e.button == MouseButton::Right {
            self.menu(window, cx);
            cx.stop_propagation();
            return;
        }
        if e.button != MouseButton::Left {
            return;
        }
        let (at, side) = self.grid_at(e.position, cx);
        let kind = match e.click_count {
            2 => SelectionType::Semantic,
            n if n >= 3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        let s = self.session.read(cx);
        let mut t = s.term.lock();
        if e.modifiers.shift && t.selection.is_some() {
            if let Some(sel) = t.selection.as_mut() {
                sel.update(at, side);
            }
        } else {
            t.selection = Some(Selection::new(kind, at, side));
        }
        drop(t);
        self.selecting = true;
        cx.stop_propagation();
        cx.notify();
    }

    fn moved(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(b) = self.reported {
            let mode = self.session.read(cx).mode();
            if e.pressed_button.is_some() && mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) {
                self.report(b + 32, true, e.position, &e.modifiers, cx);
            }
            return;
        }
        if !self.selecting || e.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let (at, side) = self.grid_at(e.position, cx);
        // Past the top or bottom, the history scrolls under the drag.
        let m = self.drawn.get();
        let s = self.session.read(cx);
        let mut t = s.term.lock();
        if e.position.y < m.bounds.top() {
            t.scroll_display(Scroll::Delta(1));
        } else if e.position.y > m.bounds.bottom() {
            t.scroll_display(Scroll::Delta(-1));
        }
        if let Some(sel) = t.selection.as_mut() {
            sel.update(at, side);
        }
        drop(t);
        cx.notify();
    }

    fn up(&mut self, e: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(b) = self.reported.take() {
            self.report(b, false, e.position, &e.modifiers, cx);
            return;
        }
        if self.selecting {
            self.selecting = false;
            let s = self.session.read(cx);
            let mut t = s.term.lock();
            // A click that selected nothing leaves nothing selected.
            if t.selection.as_ref().is_some_and(|s| s.is_empty()) {
                t.selection = None;
            }
            drop(t);
            cx.notify();
        }
    }

    fn wheel(&mut self, e: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let m = self.drawn.get();
        let lines = match e.delta {
            ScrollDelta::Lines(p) => p.y,
            ScrollDelta::Pixels(p) => f32::from(p.y) / f32::from(m.cell_h).max(1.),
        };
        self.wheel += lines;
        let whole = self.wheel.trunc() as i32;
        let mode = self.session.read(cx).mode();
        let mouse = self.mouse_mode(&e.modifiers, cx);
        let alt_scroll = mode.contains(TermMode::ALT_SCREEN) && mode.contains(TermMode::ALTERNATE_SCROLL);
        if !mouse && !alt_scroll {
            // The history while there's more of it that way; past its ends, the column's.
            let t = self.session.read(cx).term.lock();
            let offset = t.grid().display_offset();
            let history = t.history_size();
            drop(t);
            let more = if lines > 0. { offset < history } else { offset > 0 };
            if !more {
                self.wheel = 0.;
                return;
            }
        }
        cx.stop_propagation();
        if whole == 0 {
            return;
        }
        self.wheel -= whole as f32;
        let s = self.session.read(cx);
        if mouse {
            let button = if whole > 0 { 64 } else { 65 };
            for _ in 0..whole.unsigned_abs() {
                self.report(button, true, e.position, &e.modifiers, cx);
            }
        } else if alt_scroll {
            let app = mode.contains(TermMode::APP_CURSOR);
            let key: &[u8] = match (whole > 0, app) {
                (true, true) => b"\x1bOA",
                (true, false) => b"\x1b[A",
                (false, true) => b"\x1bOB",
                (false, false) => b"\x1b[B",
            };
            s.write(key.repeat(whole.unsigned_abs() as usize));
        } else {
            s.term.lock().scroll_display(Scroll::Delta(whole));
            self.session.update(cx, |_, cx| cx.notify());
        }
    }

    fn menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use gpui::MenuItem;
        let id = self.id(cx);
        let pinned = self.session.read(cx).start.space.is_some();
        let has_selection = self.session.read(cx).term.lock().selection.as_ref().is_some_and(|s| !s.is_empty());
        let a = |name: &str, op: Op| MenuItem::action(name.to_string(), TerminalDo(id.clone(), op));
        let mut items = vec![];
        if has_selection {
            items.push(a("Copy", Op::Copy));
        }
        items.extend([a("Paste", Op::Paste), a("Clear", Op::Clear)]);
        if pinned {
            items.extend([MenuItem::separator(), a("Open in Window", Op::Window), a("Remove", Op::Remove)]);
        }
        base::native_menu::popup(items, window, cx);
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Lays the screen out for the room it has, and says its size to the shell.
fn fit(session: &Entity<Session>, drawn: &Rc<Cell<Metrics>>, bounds: Bounds<Pixels>, l: &Look, window: &mut Window, cx: &mut App) -> Metrics {
    let (cw, ch, font_size) = cell(l, window);
    let cols = (f32::from(bounds.size.width - px(PAD_X * 2.)) / f32::from(cw)).floor().max(2.) as usize;
    let rows = (f32::from(bounds.size.height - px(PAD_Y * 2.)) / f32::from(ch)).floor().max(1.) as usize;
    let size = Size { cols, rows, cell_w: f32::from(cw) as u16, cell_h: f32::from(ch) as u16 };
    session.update(cx, |s, _| {
        s.resize(size);
        s.palette = Some(Palette::of(l));
    });
    let m = Metrics { cell_w: cw, cell_h: ch, font_size, origin: bounds.origin + point(px(PAD_X), px(PAD_Y)), bounds };
    drawn.set(m);
    m
}

/// A run of cells drawn in one style.
struct Style {
    fg: u32,
    bg: Option<u32>,
    weight: FontWeight,
    italic: bool,
    underline: bool,
    strike: bool,
}

/// One row's words, a run at a time, starting at a column.
struct Piece {
    col: usize,
    text: String,
    runs: Vec<TextRun>,
}

fn run_of(style: &Style, len: usize) -> TextRun {
    TextRun {
        len,
        font: font(style.weight, if style.italic { FontStyle::Italic } else { FontStyle::Normal }),
        color: hsla(style.fg),
        background_color: None,
        underline: style.underline.then(|| UnderlineStyle { thickness: px(1.), color: Some(hsla(style.fg)), wavy: false }),
        strikethrough: style.strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(hsla(style.fg)) }),
    }
}

/// Everything painted: backgrounds, the selection, words, the cursor.
struct Frame {
    rects: Vec<(usize, usize, usize, Hsla)>,
    rows: Vec<Vec<Piece>>,
    cursor: Option<(usize, usize, CursorShape, bool)>,
    metrics: Metrics,
    marked: Option<String>,
    cursor_color: Hsla,
    bg: Hsla,
}

fn frame(s: &Session, focused: bool, l: &Look, m: Metrics) -> Frame {
    let palette = Palette::of(l);
    let t = s.term.lock();
    let content = t.renderable_content();
    let own = *content.colors;
    let offset = content.display_offset as i32;
    let sel = content.selection;
    let cursor = content.cursor;
    let cols = t.columns();
    let screen = t.screen_lines();
    let mut rows: Vec<Vec<Piece>> = (0..screen).map(|_| vec![]).collect();
    let mut rects = vec![];
    let sel_color = l.ink.opacity(0.2);
    let cursor_row = cursor.point.line.0 + offset;
    let block_here = |row: usize, col: usize| focused && cursor.shape == CursorShape::Block && cursor_row == row as i32 && cursor.point.column.0 == col;
    let mut current: Option<(usize, Piece, Style)> = None;
    let flush = |current: &mut Option<(usize, Piece, Style)>, rows: &mut Vec<Vec<Piece>>| {
        if let Some((row, p, _)) = current.take()
            && !p.text.trim().is_empty()
        {
            rows[row].push(p);
        }
    };
    for indexed in content.display_iter {
        let row = (indexed.point.line.0 + offset) as usize;
        let col = indexed.point.column.0;
        if row >= screen {
            continue;
        }
        let c = &indexed.cell;
        let flags = c.flags;
        if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            flush(&mut current, &mut rows);
            continue;
        }
        let mut fg_c = c.fg;
        if flags.contains(Flags::BOLD) {
            fg_c = palette.bold(fg_c);
        }
        let mut fg = palette.rgb(fg_c, &own);
        let mut bg = match c.bg {
            Color::Named(NamedColor::Background) if own[NamedColor::Background].is_none() => None,
            other => Some(palette.rgb(other, &own)),
        };
        if flags.contains(Flags::INVERSE) {
            let b = bg.unwrap_or(palette.bg);
            bg = Some(fg);
            fg = b;
        }
        if flags.contains(Flags::DIM) {
            fg = crate::look::mix(fg, bg.unwrap_or(palette.bg), 0.4);
        }
        if flags.contains(Flags::HIDDEN) {
            fg = bg.unwrap_or(palette.bg);
        }
        if block_here(row, col) {
            fg = bg.unwrap_or(palette.bg);
        }
        let width = if flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
        if let Some(b) = bg {
            rects.push((row, col, width, hsla(b)));
        }
        if sel.is_some_and(|r| r.contains(indexed.point)) {
            rects.push((row, col, width, sel_color));
        }
        let style = Style {
            fg,
            bg,
            weight: if flags.contains(Flags::BOLD) { FontWeight::BOLD } else { FontWeight::NORMAL },
            italic: flags.contains(Flags::ITALIC),
            underline: flags.intersects(Flags::ALL_UNDERLINES),
            strike: flags.contains(Flags::STRIKEOUT),
        };
        let mut ch = c.c.to_string();
        if let Some(z) = c.zerowidth() {
            ch.extend(z.iter());
        }
        if ch == "\t" {
            ch = " ".into();
        }
        let same = current.as_ref().is_some_and(|(r, p, st)| {
            *r == row && p.col + p.text.chars().count() == col && st.fg == style.fg && st.weight == style.weight && st.italic == style.italic && st.underline == style.underline && st.strike == style.strike && width == 1
        });
        if !same {
            flush(&mut current, &mut rows);
            current = Some((row, Piece { col, text: String::new(), runs: vec![] }, style));
        } else if let Some((_, _, st)) = current.as_mut() {
            st.bg = style.bg;
        }
        if let Some((_, p, st)) = current.as_mut() {
            p.text.push_str(&ch);
            match p.runs.last_mut() {
                Some(r) => r.len += ch.len(),
                None => p.runs.push(run_of(st, ch.len())),
            }
        }
        // A wide letter stands alone: what follows starts two cells on.
        if width == 2 {
            flush(&mut current, &mut rows);
        }
        let _ = cols;
    }
    flush(&mut current, &mut rows);
    let shown = cursor.shape != CursorShape::Hidden && s.exited.is_none() && cursor_row >= 0 && (cursor_row as usize) < screen;
    Frame {
        rects,
        rows,
        cursor: shown.then(|| (cursor_row as usize, cursor.point.column.0, cursor.shape, focused)),
        metrics: m,
        marked: s.marked.clone(),
        cursor_color: hsla(palette.rgb(Color::Named(NamedColor::Cursor), &own)),
        bg: hsla(palette.bg),
    }
}

fn paint(f: Frame, window: &mut Window, cx: &mut App) {
    let m = f.metrics;
    let at = |row: usize, col: usize| m.origin + point(m.cell_w * col as f32, m.cell_h * row as f32);
    for (row, col, w, color) in &f.rects {
        window.paint_quad(fill(Bounds::new(at(*row, *col), size(m.cell_w * *w as f32, m.cell_h)), *color));
    }
    if let Some((row, col, shape, focused)) = f.cursor {
        let o = at(row, col);
        let b = Bounds::new(o, size(m.cell_w, m.cell_h));
        match (shape, focused) {
            (CursorShape::Block, true) => window.paint_quad(fill(b, f.cursor_color)),
            (CursorShape::Beam, _) => window.paint_quad(fill(Bounds::new(o, size(px(2.), m.cell_h)), f.cursor_color)),
            (CursorShape::Underline, _) => window.paint_quad(fill(Bounds::new(o + point(px(0.), m.cell_h - px(2.)), size(m.cell_w, px(2.))), f.cursor_color)),
            _ => window.paint_quad(gpui::outline(b, f.cursor_color, gpui::BorderStyle::Solid)),
        }
    }
    for (row, pieces) in f.rows.into_iter().enumerate() {
        for p in pieces {
            let shaped = window.text_system().shape_line(SharedString::from(p.text), m.font_size, &p.runs, Some(m.cell_w));
            let _ = shaped.paint(at(row, p.col), m.cell_h, gpui::TextAlign::Left, None, window, cx);
        }
    }
    if let (Some(marked), Some((row, col, _, _))) = (f.marked, f.cursor) {
        let run = TextRun { len: marked.len(), font: font(FontWeight::NORMAL, FontStyle::Normal), color: f.cursor_color, background_color: Some(f.bg), underline: Some(UnderlineStyle { thickness: px(1.), color: None, wavy: false }), strikethrough: None };
        let shaped = window.text_system().shape_line(SharedString::from(marked), m.font_size, &[run], Some(m.cell_w));
        let _ = shaped.paint(at(row, col), m.cell_h, gpui::TextAlign::Left, None, window, cx);
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let me = cx.entity();
        let focused = self.focus.is_focused(window);
        let focus = self.focus.clone();
        let (session, drawn) = (self.session.clone(), self.drawn.clone());
        div()
            .id("terminal")
            .key_context("Terminal")
            .track_focus(&self.focus)
            .size_full()
            .bg(l.bg)
            .cursor(gpui::CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::key))
            .on_action(cx.listener(|this, k: &Key, window, cx| {
                let ks = gpui::Keystroke::parse_with_os(&k.0, gpui::OperatingSystem::Mac).ok();
                if let Some(ks) = ks {
                    this.key(&KeyDownEvent { keystroke: ks, is_held: false, prefer_character_input: false }, window, cx);
                }
            }))
            .on_action(cx.listener(|_, _: &Leave, window, cx| window.dispatch_action(Box::new(crate::app::ToBox), cx)))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Copy, _, cx| super::act_on(&this.id(cx), &Op::Copy, cx)))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Paste, _, cx| super::act_on(&this.id(cx), &Op::Paste, cx)))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::SelectAll, _, cx| {
                let s = this.session.read(cx);
                let mut t = s.term.lock();
                let top = t.topmost_line();
                let bottom = t.bottommost_line();
                let last = t.last_column();
                let mut sel = Selection::new(SelectionType::Simple, GridPoint::new(top, Column(0)), Side::Left);
                sel.update(GridPoint::new(bottom, last), Side::Right);
                t.selection = Some(sel);
                drop(t);
                cx.notify();
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::down))
            .on_mouse_move(cx.listener(Self::moved))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::up))
            .on_scroll(cx.listener(Self::wheel))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let m = fit(&session, &drawn, bounds, &l, window, cx);
                        frame(session.read(cx), focused, &l, m)
                    },
                    move |bounds, f, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, me), cx);
                        paint(f, window, cx);
                    },
                )
                .size_full(),
            )
    }
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(&mut self, _: std::ops::Range<usize>, _: &mut Option<std::ops::Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, cx: &mut Context<Self>) -> Option<std::ops::Range<usize>> {
        self.session.read(cx).marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.session.update(cx, |s, cx| {
            s.marked = None;
            cx.notify();
        });
    }

    fn replace_text_in_range(&mut self, _: Option<std::ops::Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.session.update(cx, |s, cx| {
            s.marked = None;
            cx.notify();
        });
        if self.session.read(cx).exited.is_some() {
            return;
        }
        self.typed(text.as_bytes().to_vec(), cx);
    }

    fn replace_and_mark_text_in_range(&mut self, _: Option<std::ops::Range<usize>>, text: &str, _: Option<std::ops::Range<usize>>, _: &mut Window, cx: &mut Context<Self>) {
        self.session.update(cx, |s, cx| {
            s.marked = (!text.is_empty()).then(|| text.to_string());
            cx.notify();
        });
    }

    fn bounds_for_range(&mut self, _: std::ops::Range<usize>, _: Bounds<Pixels>, _: &mut Window, cx: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let m = self.drawn.get();
        let s = self.session.read(cx);
        let t = s.term.lock();
        let c = t.grid().cursor.point;
        let row = c.line.0 + t.grid().display_offset() as i32;
        Some(Bounds::new(m.origin + point(m.cell_w * c.column.0 as f32, m.cell_h * row as f32), size(m.cell_w, m.cell_h)))
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        true
    }
}
