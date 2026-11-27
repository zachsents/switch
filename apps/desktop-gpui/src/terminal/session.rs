//! One terminal's shell: a PTY running the user's login shell on this Mac, Alacritty's emulator
//! reading it (its event loop on a thread of its own), and what the screen holds. A command given
//! is typed into the shell once it starts, so when it ends the shell is still there, its output
//! above the prompt. When the shell itself ends, its last screen stays with its exit code, and
//! Return starts a new one in the same place. The shell lives as long as the app: quitting the app
//! ends it (the PTY closes and the shell hears SIGHUP), and a terminal placed in a space starts a
//! fresh one when it's next drawn.

use std::borrow::Cow;
use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{CursorShape, Processor};
use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{App, AppContext, ClipboardItem, Context, Entity};
use serde_json::{Value, json};

use super::colors::Palette;

/// Lines of history a terminal keeps above its screen.
pub const HISTORY: usize = 10_000;

/// What the emulator tells the app, sent on from its thread.
#[derive(Clone)]
pub struct Listener(UnboundedSender<Event>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let _ = self.0.unbounded_send(event);
    }
}

/// A screen's size in cells, and a cell's in pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Size {
    pub cols: usize,
    pub rows: usize,
    pub cell_w: u16,
    pub cell_h: u16,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

impl Size {
    fn window(&self) -> WindowSize {
        WindowSize { num_lines: self.rows as u16, num_cols: self.cols as u16, cell_width: self.cell_w, cell_height: self.cell_h }
    }
}

/// What starts a terminal: where, what it runs, and where it's shown.
#[derive(Clone, Debug, Default)]
pub struct Start {
    pub cwd: Option<PathBuf>,
    pub command: Option<String>,
    /// The space it's placed in, if it is.
    pub space: Option<String>,
}

pub struct Session {
    pub id: String,
    pub start: Start,
    pub term: Arc<FairMutex<Term<Listener>>>,
    tx: Option<EventLoopSender>,
    /// The PTY's own end, to ask which program is in front.
    pty: Option<std::fs::File>,
    pub size: Size,
    /// The title a program set (OSC 0 or 2).
    pub title: Option<String>,
    /// The shell's exit code, once it's ended.
    pub exited: Option<i32>,
    /// When the shell last wrote, for waiting until it's quiet.
    pub wrote_at: Instant,
    /// Words an input method is composing, drawn at the cursor until they're committed.
    pub marked: Option<String>,
    /// The screen's colours when it was last drawn, to answer a program that asks.
    pub palette: Option<Palette>,
    /// Which shell this is, so a late word from one that ended isn't taken for the next's.
    generation: u64,
    /// What's typed before the shell has drawn (its command, the agent's first words), held until
    /// it has and gone quiet, so the terminal doesn't echo it above the first prompt.
    pending: Option<Vec<u8>>,
    /// Each word the shell draws while one is pending starts its wait again.
    settling: u64,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// The folder a path the agent or the user gave means: `~` is home, a relative one from home.
pub fn folder(p: &str) -> PathBuf {
    let p = p.trim();
    if p.is_empty() || p == "~" {
        return home();
    }
    let path = match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(p),
    };
    if path.is_absolute() { path } else { home().join(path) }
}

impl Session {
    pub fn new(id: String, start: Start, cx: &mut Context<Self>) -> Self {
        let size = Size { cols: 80, rows: 24, cell_w: 8, cell_h: 16 };
        let (tx, rx) = unbounded();
        let term = Arc::new(FairMutex::new(Term::new(config(), &size, Listener(tx.clone()))));
        let mut s = Session { id, start, term, tx: None, pty: None, size, title: None, exited: None, wrote_at: Instant::now(), marked: None, palette: None, generation: 0, pending: None, settling: 0 };
        s.listen(rx, 0, cx);
        s.spawn(Listener(tx), cx);
        s
    }

    fn listen(&self, mut rx: futures::channel::mpsc::UnboundedReceiver<Event>, generation: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            while let Some(e) = rx.next().await {
                let alive = this.update(cx, |s, cx| {
                    if s.generation == generation {
                        s.heard(e, cx);
                    }
                    s.generation == generation
                });
                if !matches!(alive, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    /// Starts the shell: the user's own, as a login shell, in the terminal's folder.
    fn spawn(&mut self, listener: Listener, cx: &mut Context<Self>) {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        let cwd = self.start.cwd.clone().filter(|p| p.is_dir()).unwrap_or_else(home);
        let mut env = HashMap::new();
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert("TERM_PROGRAM".into(), "Switch".into());
        let options = tty::Options { shell: Some(tty::Shell::new(shell, vec!["-l".into()])), working_directory: Some(cwd), drain_on_exit: true, env };
        let pty = match tty::new(&options, self.size.window(), 0) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("terminal {}: {e}", self.id);
                self.exited = Some(-1);
                return;
            }
        };
        self.pty = pty.file().try_clone().ok();
        let event_loop = match EventLoop::new(self.term.clone(), listener, pty, true, false) {
            Ok(l) => l,
            Err(e) => {
                log::warn!("terminal {}: {e}", self.id);
                self.exited = Some(-1);
                return;
            }
        };
        self.tx = Some(event_loop.channel());
        event_loop.spawn();
        self.exited = None;
        self.pending = Some(self.start.command.clone().filter(|c| !c.trim().is_empty()).map(|c| format!("{c}\r").into_bytes()).unwrap_or_default());
        cx.notify();
    }

    /// A new shell where the last one ended, on a fresh screen.
    pub fn restart(&mut self, cx: &mut Context<Self>) {
        if self.exited.is_none() {
            return;
        }
        let (tx, rx) = unbounded();
        self.term = Arc::new(FairMutex::new(Term::new(config(), &self.size, Listener(tx.clone()))));
        self.title = None;
        self.generation += 1;
        self.listen(rx, self.generation, cx);
        self.spawn(Listener(tx), cx);
        super::emit_opened(self, cx);
    }

    fn heard(&mut self, e: Event, cx: &mut Context<Self>) {
        match e {
            Event::Wakeup => {
                self.wrote_at = Instant::now();
                if self.pending.is_some() {
                    self.settling += 1;
                    let at = self.settling;
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(std::time::Duration::from_millis(150)).await;
                        let _ = this.update(cx, |s, _| {
                            if s.settling == at
                                && let Some(held) = s.pending.take()
                            {
                                s.write(held);
                            }
                        });
                    })
                    .detach();
                }
                cx.notify();
            }
            Event::Title(t) => {
                self.title = Some(t);
                cx.notify();
            }
            Event::ResetTitle => {
                self.title = None;
                cx.notify();
            }
            Event::ClipboardStore(_, text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            Event::ClipboardLoad(_, format) => {
                let text = cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
                self.write(format(&text).into_bytes());
            }
            Event::ColorRequest(i, format) => {
                let colors = *self.term.lock().colors();
                let rgb = self.palette.as_ref().map(|p| p.answer(i, &colors));
                if let Some(rgb) = rgb {
                    self.write(format(rgb).into_bytes());
                }
            }
            Event::PtyWrite(text) => self.write(text.into_bytes()),
            Event::TextAreaSizeRequest(format) => self.write(format(self.size.window()).into_bytes()),
            Event::ChildExit(status) => self.ended(status.code().unwrap_or(-1), cx),
            Event::Exit => {
                if self.exited.is_none() {
                    self.ended(0, cx);
                }
            }
            Event::Bell | Event::MouseCursorDirty | Event::CursorBlinkingChange => {}
        }
    }

    fn ended(&mut self, code: i32, cx: &mut Context<Self>) {
        if self.exited.is_some() {
            return;
        }
        self.exited = Some(code);
        self.tx = None;
        self.pty = None;
        // Its code on the screen, under what it left, dimmed.
        let mut term = self.term.lock();
        let mut p: Processor = Processor::new();
        let line = format!("\r\n\x1b[2m[exited {code}]\x1b[0m\x1b[?25l");
        p.advance(&mut *term, line.as_bytes());
        drop(term);
        super::emit_exited(self, cx);
        cx.emit(Ended);
        cx.notify();
    }

    /// Bytes to the shell, as typed.
    pub fn write(&self, bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Input(Cow::Owned(bytes)));
        }
    }

    /// What's typed: the screen back at its bottom and the selection gone, as terminals do.
    pub fn typed(&mut self, bytes: Vec<u8>) {
        if let Some(held) = self.pending.as_mut() {
            held.extend(bytes);
            return;
        }
        {
            let mut t = self.term.lock();
            t.scroll_display(Scroll::Bottom);
            t.selection = None;
        }
        self.write(bytes);
    }

    /// Whether what's typed is still held for the shell to draw first.
    pub fn holding(&self) -> bool {
        self.pending.is_some() && self.exited.is_none()
    }

    pub fn mode(&self) -> TermMode {
        *self.term.lock().mode()
    }

    pub fn resize(&mut self, size: Size) {
        if size == self.size || size.cols < 2 || size.rows < 1 {
            return;
        }
        self.size = size;
        self.term.lock().resize(size);
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Resize(size.window()));
        }
    }

    /// The program in front in the shell (`vim`, `htop`, the shell itself), by its process group.
    pub fn program(&self) -> Option<String> {
        let fd = self.pty.as_ref()?.as_raw_fd();
        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        if pgrp <= 0 {
            return None;
        }
        let mut buf = [0u8; 256];
        let n = unsafe { libc::proc_name(pgrp, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    /// The folder the program in front is in.
    pub fn cwd(&self) -> Option<PathBuf> {
        let fd = self.pty.as_ref()?.as_raw_fd();
        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        if pgrp <= 0 {
            return None;
        }
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let n = unsafe { libc::proc_pidinfo(pgrp, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
        if n != size {
            return None;
        }
        let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
        Some(PathBuf::from(path.to_string_lossy().into_owned()))
    }

    /// Its name as a window or the list shows it: the program's title, else the program in front
    /// and the folder it's in.
    pub fn name(&self) -> String {
        if let Some(t) = self.title.clone().filter(|t| !t.trim().is_empty()) {
            return t;
        }
        let folder = self.cwd().or_else(|| self.start.cwd.clone()).map(|p| {
            let home = home();
            match p.strip_prefix(&home) {
                Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
                Ok(rest) => format!("~/{}", rest.display()),
                Err(_) => p.display().to_string(),
            }
        });
        match (self.program(), folder) {
            (Some(p), Some(f)) => format!("{p} {f}"),
            (Some(p), None) => p,
            (None, Some(f)) => f,
            (None, None) => "Terminal".into(),
        }
    }

    /// The screen as words, and up to `history` lines above it: what the agent reads.
    pub fn read(&self, history: usize) -> Value {
        let t = self.term.lock();
        let rows = t.screen_lines() as i32;
        let last = t.last_column();
        let above = history.min(t.history_size()) as i32;
        let text = |from: i32, to: i32| if from > to { String::new() } else { trim_lines(&t.bounds_to_string(Point::new(Line(from), Column(0)), Point::new(Line(to), last))) };
        let cursor = t.grid().cursor.point;
        let shown = t.mode().contains(TermMode::SHOW_CURSOR) && t.cursor_style().shape != CursorShape::Hidden;
        json!({
            "id": self.id,
            "screen": text(0, rows - 1),
            "history": text(-above, -1),
            "cursor": if shown { json!({ "row": cursor.line.0, "col": cursor.column.0 }) } else { Value::Null },
            "size": { "cols": t.columns(), "rows": rows },
            "alternate": t.mode().contains(TermMode::ALT_SCREEN),
            "exited": self.exited,
        })
    }

    /// What the list says of it.
    pub fn about(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name(),
            "program": self.program(),
            "cwd": self.cwd().or_else(|| self.start.cwd.clone()).map(|p| p.display().to_string()),
            "command": self.start.command,
            "space": self.start.space,
            "exited": self.exited,
        })
    }

    /// Ends the shell.
    pub fn close(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Msg::Shutdown);
        }
        self.pty = None;
    }
}

/// Its shell ended.
pub struct Ended;
impl gpui::EventEmitter<Ended> for Session {}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

fn config() -> Config {
    Config { scrolling_history: HISTORY, osc52: Osc52::OnlyCopy, ..Config::default() }
}

/// Lines with what trails them gone, and the empty ones at the end.
fn trim_lines(s: &str) -> String {
    let lines: Vec<&str> = s.lines().map(str::trim_end).collect();
    let end = lines.iter().rposition(|l| !l.is_empty()).map_or(0, |i| i + 1);
    lines[..end].join("\n")
}

/// Starts one, kept in the app's list of terminals.
pub fn start(id: String, start: Start, cx: &mut App) -> Entity<Session> {
    cx.new(|cx| Session::new(id, start, cx))
}
