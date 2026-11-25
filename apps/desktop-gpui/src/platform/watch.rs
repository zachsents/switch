//! What the window shows, and when it stops answering (the desktop's `bun/watch.ts` and the view's
//! `reports.ts`). The main thread beats twice a second; a focused, visible window whose beat stops
//! past HANG has hung. Hangs, errors and the app's own crash become reports, kept on disk (this
//! app's own file; a quiet copy's apart, and never sent) until they're in the brain (`client.crashed`), so one survives a crash or a quit. What was on screen
//! goes with each: the page and its space, and the last steps.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use gpui::App;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::helpers::{now_ms, quiet, write_atomic};
use crate::model::model;
use crate::nav::{Nav, Page};
use crate::net::Net;

const HANG_MS: u64 = 10_000;
const CLIP: usize = 20_000;
const TRAIL: usize = 30;
const BEAT: Duration = Duration::from_millis(500);
/// How long before a report not yet in is sent again.
const AGAIN_MS: f64 = 30_000.;

/// A crash, hang or error, for the brain as `client.crashed`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub device: String,
    pub kind: String,
    pub build: String,
    pub at: f64,
    pub summary: String,
    pub screen: String,
    pub trail: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
}

#[derive(Default)]
struct Shown {
    space: Option<String>,
    screen: String,
    trail: Vec<String>,
}

base::kept! {
    static SHOWN: Mutex<Shown> = Mutex::default();
    static PENDING: Mutex<Vec<Report>> = Mutex::new(load());
    static SENT_AT: Mutex<std::collections::HashMap<String, f64>> = Mutex::default();
    static LAST_BEAT: AtomicU64 = AtomicU64::new(0);
    static HUNG_SINCE: AtomicU64 = AtomicU64::new(0);
    static FOCUSED: AtomicBool = AtomicBool::new(true);
    static VISIBLE: AtomicBool = AtomicBool::new(true);
}
static DEVICE: LazyLock<String> = LazyLock::new(crate::auth::machine_name);

/// Where reports wait: this app's own (the Electrobun app's `~/.switch/desktop-reports.json` is
/// its own), and a quiet copy's apart from it, never sent.
fn file() -> std::path::PathBuf {
    if quiet() { crate::outbox::dir().join("reports.json") } else { super::helpers::support().join("reports.json") }
}

fn load() -> Vec<Report> {
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn keep(all: &[Report]) {
    let _ = write_atomic(&file(), serde_json::to_string(all).unwrap_or_default().as_bytes(), None);
}

fn build() -> String {
    super::update::VERSION.to_string()
}

fn add(kind: &str, at: f64, summary: String, screen: String, trail: Vec<String>, report: Option<String>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let r = Report { id: id.clone(), device: DEVICE.clone(), kind: kind.into(), build: build(), at, summary, screen, trail, report };
    if let Ok(mut p) = PENDING.lock() {
        p.push(r);
        keep(&p);
    }
    id
}

base::kept! {
    /// A section's panic (boundary.rs) not yet known to have left gpui whole: its report's id.
    static UNSURE: Mutex<Option<String>> = Mutex::new(None);
}

/// The section's panic left gpui whole: it stays an error.
pub fn section_whole() {
    if let Ok(mut u) = UNSURE.lock() {
        *u = None;
    }
}

/// The section's panic left gpui mid-update, which nothing can mend: it's the app's crash, and the
/// app ends now, before anything meets what it left.
pub fn section_fatal() -> ! {
    crash_from_section(None);
    std::process::abort()
}

/// Makes the unsure section's report the crash, with what followed it (`then`) below its own.
fn crash_from_section(then: Option<&str>) -> bool {
    let Some(id) = UNSURE.lock().ok().and_then(|mut u| u.take()) else { return false };
    let Ok(mut p) = PENDING.lock() else { return false };
    let Some(r) = p.iter_mut().find(|r| r.id == id) else { return false };
    r.kind = "crash".into();
    if let Some(then) = then {
        r.report = Some(clip(&format!("{}\n\nThen: {then}", r.report.clone().unwrap_or_default()), CLIP));
    }
    keep(&p);
    true
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A step worth knowing after a crash: a page opened, a command run.
pub fn step(what: &str) {
    if let Ok(mut s) = SHOWN.lock() {
        s.trail.push(format!("{} {what}", chrono::Local::now().format("%H:%M:%S")));
        let over = s.trail.len().saturating_sub(TRAIL);
        s.trail.drain(..over);
    }
}

/// An error the app hit, for a report.
pub fn error(summary: &str, report: &str) {
    let (screen, trail) = SHOWN.lock().map(|s| (s.screen.clone(), s.trail.clone())).unwrap_or_default();
    add("error", now_ms(), clip(summary, 200), screen, trail, Some(clip(report, CLIP)));
}

/// The space on screen in a focused window, else None.
pub fn in_front() -> Option<String> {
    if !FOCUSED.load(Ordering::Relaxed) {
        return None;
    }
    SHOWN.lock().ok().and_then(|s| s.space.clone())
}

pub fn focused() -> bool {
    FOCUSED.load(Ordering::Relaxed)
}

/// The main window came forward or went back.
pub fn focus(on: bool) {
    FOCUSED.store(on, Ordering::Relaxed);
    LAST_BEAT.store(now_ms() as u64, Ordering::Relaxed);
}

/// What's on screen, as a line for a report: `space Home`, `thread … in …`.
fn screen_of(cx: &App) -> (Option<String>, String) {
    let page = Nav::entity(cx).read(cx).page.clone();
    let b = &model(cx).read(cx).brain;
    let name = |id: &str| b.spaces.get(id).map(|s| s.name.clone()).unwrap_or_else(|| "Home".into());
    match &page {
        Page::Space(s) => (Some(s.clone()), format!("space {}", name(s))),
        Page::Thread(t, s) => (None, format!("thread {} in {}", b.threads.get(t).map(|t| t.title.clone()).unwrap_or_default(), name(s))),
    }
}

fn shown(cx: &App) {
    let (space, screen) = screen_of(cx);
    let changed = SHOWN.lock().map(|s| s.screen != screen || s.space != space).unwrap_or(false);
    if changed {
        if let Ok(mut s) = SHOWN.lock() {
            s.space = space;
            s.screen = screen.clone();
        }
        step(&screen);
    }
}

base::kept! {
    /// This launch's word of which build runs here (`client.reported`), once it's in.
    static REPORTED: AtomicBool = AtomicBool::new(false);
    static LAUNCH: String = uuid::Uuid::new_v4().to_string();
}

/// Which build runs on this machine, for the brain: the published app's only (a build without a
/// feed is the dev channel, never this machine's app), again until it's in.
fn report_build(now: f64, cx: &mut App) {
    if super::update::FEED.is_none() || REPORTED.load(Ordering::Relaxed) {
        return;
    }
    let due = SENT_AT.lock().ok().and_then(|s| s.get(LAUNCH.as_str()).copied()).is_none_or(|at| now - at > AGAIN_MS);
    if !due {
        return;
    }
    if let Ok(mut s) = SENT_AT.lock() {
        s.insert(LAUNCH.clone(), now);
    }
    let payload = json!({ "client": "desktop", "device": DEVICE.clone(), "build": build(), "hash": super::update::HASH });
    let answer = cx.global::<Net>().emit("client.reported", payload, Some(LAUNCH.clone()));
    cx.spawn(async move |_| {
        if let Ok(Ok(_)) = answer.await {
            REPORTED.store(true, Ordering::Relaxed);
        }
    })
    .detach();
}

/// Sends what's kept, each again until it's in, but not on every beat.
fn flush(cx: &mut App) {
    if quiet() {
        return;
    }
    let now = now_ms();
    report_build(now, cx);
    let due: Vec<Report> = PENDING.lock().map(|p| p.clone()).unwrap_or_default().into_iter().filter(|r| SENT_AT.lock().ok().and_then(|s| s.get(&r.id).copied()).is_none_or(|at| now - at > AGAIN_MS)).collect();
    for r in due {
        if let Ok(mut s) = SENT_AT.lock() {
            s.insert(r.id.clone(), now);
        }
        let mut payload = serde_json::to_value(&r).unwrap_or_default();
        if let Some(o) = payload.as_object_mut() {
            o.remove("id");
            o.insert("client".into(), json!("desktop"));
        }
        let answer = cx.global::<Net>().emit("client.crashed", payload, Some(r.id.clone()));
        let id = r.id.clone();
        cx.spawn(async move |_| {
            if let Ok(Ok(_)) = answer.await
                && let Ok(mut p) = PENDING.lock()
            {
                p.retain(|x| x.id != id);
                keep(&p);
            }
        })
        .detach();
    }
}

/// From before the app runs: a panic is kept as a report (sent on the next launch, or once the
/// brain is reached). On the main thread it's the app's crash; inside a section (boundary.rs), or on
/// another thread while the app goes on, an error, until a section's turns out to have left gpui
/// mid-update.
pub fn hook() {
    let _ = &*PENDING;
    // The device's name now, not while panicking.
    std::thread::spawn(|| LazyLock::force(&DEVICE));
    let before = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let summary = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
        let (screen, trail) = SHOWN.lock().map(|s| (s.screen.clone(), s.trail.clone())).unwrap_or_default();
        let report = format!("{info}\n{}", std::backtrace::Backtrace::force_capture());
        let main = std::thread::current().name() == Some("main");
        // A crash while a section's panic is unsure is most likely what it left (an entity still
        // "being updated"): that panic is the cause, this one follows it.
        if crate::boundary::inside() {
            let id = add("error", now_ms(), clip(&summary, 200), screen, trail, Some(clip(&report, CLIP)));
            if let Ok(mut u) = UNSURE.lock() {
                u.get_or_insert(id);
            }
        } else if !(main && crash_from_section(Some(&report))) {
            add(if main { "crash" } else { "error" }, now_ms(), clip(&summary, 200), screen, trail, Some(clip(&report, CLIP)));
        }
        before(info);
    }));
}

/// The Electrobun app's reports still waiting in its own file, carried into this one (once it's
/// the desktop): sent from here, gone from there. A quiet copy leaves them.
fn carry_over() {
    if quiet() {
        return;
    }
    let theirs = super::helpers::home().join(".switch/desktop-reports.json");
    let Some(waiting) = std::fs::read_to_string(&theirs).ok().and_then(|t| serde_json::from_str::<Vec<Report>>(&t).ok()) else { return };
    if waiting.is_empty() {
        return;
    }
    if let Ok(mut p) = PENDING.lock() {
        for r in waiting {
            if !p.iter().any(|x| x.id == r.id) {
                p.push(r);
            }
        }
        keep(&p);
    }
    let _ = write_atomic(&theirs, b"[]", None);
}

pub fn start(cx: &mut App) {
    carry_over();
    LAST_BEAT.store(now_ms() as u64, Ordering::Relaxed);
    // Only a window on screen can hang: a hidden or occluded one has nothing to answer. And when
    // this check itself runs late, the whole Mac stalled (asleep, busy), so the silence says nothing.
    std::thread::spawn(|| {
        let mut ticked = now_ms() as u64;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = now_ms() as u64;
            let late = now - ticked > HANG_MS;
            ticked = now;
            if late || !VISIBLE.load(Ordering::Relaxed) {
                LAST_BEAT.store(now, Ordering::Relaxed);
                continue;
            }
            let beat = LAST_BEAT.load(Ordering::Relaxed);
            if FOCUSED.load(Ordering::Relaxed) && HUNG_SINCE.load(Ordering::Relaxed) == 0 && now.saturating_sub(beat) > HANG_MS {
                HUNG_SINCE.store(beat, Ordering::Relaxed);
            }
        }
    });
    cx.spawn(async move |cx| {
        let mut n = 0u64;
        loop {
            cx.background_executor().timer(BEAT).await;
            n += 1;
            let _ = cx.update(|cx| {
                let now = now_ms() as u64;
                LAST_BEAT.store(now, Ordering::Relaxed);
                VISIBLE.store(super::lifecycle::main_visible(cx), Ordering::Relaxed);
                let hung = HUNG_SINCE.swap(0, Ordering::Relaxed);
                if hung > 0 {
                    let (screen, trail) = SHOWN.lock().map(|s| (s.screen.clone(), s.trail.clone())).unwrap_or_default();
                    add("hang", hung as f64, format!("Unresponsive for {} s", (now - hung + 500) / 1000), screen, trail, None);
                }
                shown(cx);
                super::lifecycle::still_all(cx);
                super::lifecycle::follow_full_screen(cx);
                if n % 4 == 0 || hung > 0 {
                    flush(cx);
                }
            });
        }
    })
    .detach();
}
