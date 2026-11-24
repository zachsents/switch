//! Updates from the deploy's feed, as the desktop's `bun/update.ts` (T3 Code's way): checked at
//! launch, whenever the window comes forward or goes back, and every ten minutes, downloaded in the
//! background. One is applied (a relaunch) when it won't interrupt: the window out of focus or
//! hidden, no input for two minutes, or just after launch; and never while the user is typing (a key
//! in a field in the last minute) or dictating, as old Switchboard's hold.rs held it. Or at once
//! when the user asks from the system page (`UpdateNow`). Settings reads what's running and what
//! waits (`settings::Updates`).
//!
//! It can't loop: each version is put in by itself once (an apply that fails relaunches the old app,
//! which mustn't try it again), never one that's already running, and after one that didn't take it
//! waits, longer each time, before trying any.
//!
//! The feed is the one `scripts/ship.sh` publishes for this app: `<feed>/update.json` names the
//! version, its commit, its zip (the app, as `ditto` packs it) and the zip's SHA-256. The feed's
//! address, the version and the commit are the build's (`SWITCH_GPUI_UPDATES`, `SWITCH_APP_VERSION`,
//! `SWITCH_BUILD_HASH`); a build without a feed is the dev channel, which never updates.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gpui::{App, AppContext, AsyncApp, Entity, Global};

use crate::settings::{UpdateNow, Updates as Told};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::helpers::{bundle, now_ms, support, write_atomic};
use crate::local::local;
use crate::net::Net;

const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// No input for this long is away.
const IDLE_MS: f64 = 2. * 60_000.;
/// An update that lands this soon after launch is applied then: the user has only just opened it.
const LAUNCH: Duration = Duration::from_secs(30);
const IDLE_EVERY: Duration = Duration::from_secs(30);
/// How long after their last keystroke they still count as typing (old hold.rs).
const TYPING_MS: f64 = 60_000.;
const BACKOFF_MS: f64 = 10. * 60_000.;
const BACKOFF_MAX_MS: f64 = 6. * 60. * 60_000.;

pub const FEED: Option<&str> = option_env!("SWITCH_GPUI_UPDATES");
/// The build's version; a build that names none is "0.0.1", as the desktop's.
pub const VERSION: &str = match option_env!("SWITCH_APP_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => "0.0.1",
};
pub const HASH: &str = match option_env!("SWITCH_BUILD_HASH") {
    Some(h) => h,
    None => "",
};

/// The version running, and one downloaded that waits to be applied ("" for none).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Update {
    pub current: String,
    pub waiting: String,
}

/// What the feed names.
#[derive(Clone, Debug, Default, Deserialize)]
struct Info {
    version: String,
    hash: String,
    url: String,
    sha256: String,
}

/// The last version put in, when, how many in a row haven't taken, and whether this one's outcome is
/// still to be seen (`open`, until the next launch).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Tried {
    hash: String,
    at: f64,
    failed: u32,
    open: bool,
}

static TYPED_AT: AtomicU64 = AtomicU64::new(0);
static FOCUSED: AtomicBool = AtomicBool::new(true);

/// They typed into a field.
pub fn typed() {
    TYPED_AT.store(now_ms() as u64, Ordering::Relaxed);
}

/// In the middle of something an update would cut off.
fn held(cx: &App) -> bool {
    super::dictation::dictating(cx) || now_ms() - (TYPED_AT.load(Ordering::Relaxed) as f64) < TYPING_MS
}

fn label(version: &str, hash: &str) -> String {
    if version.is_empty() { hash.chars().take(7).collect() } else { version.to_string() }
}

/// This app's own record (the Electrobun app keeps `update-tried.json` beside it, in the same
/// folder once this takes its id).
fn tried_file() -> PathBuf {
    support().join("gpui-update-tried.json")
}

fn tried() -> Option<Tried> {
    std::fs::read_to_string(tried_file()).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn keep_tried(t: &Tried) {
    let _ = write_atomic(&tried_file(), serde_json::to_string(t).unwrap_or_default().as_bytes(), None);
}

/// At launch: the last one tried is running now, or it didn't take.
fn settle() {
    let Some(t) = tried() else { return };
    if !t.open {
        return;
    }
    let failed = if t.hash == HASH { 0 } else { t.failed + 1 };
    keep_tried(&Tried { open: false, failed, ..t });
}

/// What's downloaded and waiting: its info and the app unpacked from it.
struct Ready {
    info: Info,
    app: PathBuf,
}

pub struct Updates {
    pub state: Update,
    ready: Option<Ready>,
    checking: bool,
    launched: Instant,
}

struct UpdatesHandle(Entity<Updates>);
impl Global for UpdatesHandle {}

/// The entity Settings reads (`state`) and observes.
pub fn entity(cx: &App) -> Entity<Updates> {
    cx.global::<UpdatesHandle>().0.clone()
}

fn state(ready: &Option<Ready>) -> Update {
    Update { current: label(VERSION, HASH), waiting: ready.as_ref().map(|r| label(&r.info.version, &r.info.hash)).unwrap_or_default() }
}

/// Settings hears what's running and what waits.
fn tell(state: &Update, cx: &mut App) {
    cx.set_global(Told { current: state.current.clone(), waiting: state.waiting.clone() });
    cx.refresh_windows();
}

fn report(error: &str) {
    log::warn!("Update check failed: {error}");
}

pub fn start(cx: &mut App) {
    // A quiet copy never updates (or settles what the live app tried).
    if !crate::outbox::quiet() {
        settle();
    }
    let e = cx.new(|_| Updates { state: state(&None), ready: None, checking: false, launched: Instant::now() });
    cx.observe(&e, |e, cx| {
        let s = e.read(cx).state.clone();
        tell(&s, cx);
    })
    .detach();
    tell(&state(&None), cx);
    cx.set_global(UpdatesHandle(e));
    cx.on_action(|_: &UpdateNow, cx| apply_now(cx));
    // Typing in a field holds a waiting update off.
    cx.observe_keystrokes(|_, window, _| {
        if window.context_stack().iter().any(|c| c.contains(ui_sdk::native::text_field::KEY_CONTEXT)) {
            typed();
        }
    })
    .detach();
    if FEED.is_none() || crate::outbox::quiet() {
        return;
    }
    cx.spawn(async move |cx| {
        loop {
            check_quietly(cx);
            cx.background_executor().timer(CHECK_EVERY).await;
        }
    })
    .detach();
    // A waiting update goes in once the Mac has been left alone.
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor().timer(IDLE_EVERY).await;
            let _ = cx.update(|cx| {
                if entity(cx).read(cx).ready.is_some() {
                    apply(cx);
                }
            });
        }
    })
    .detach();
}

/// The window came forward (`true`) or went back: a check, and maybe the waiting one goes in.
pub fn focus(on: bool, cx: &mut App) {
    FOCUSED.store(on, Ordering::Relaxed);
    if FEED.is_some() && !crate::outbox::quiet() {
        cx.spawn(async move |cx| check_quietly(cx)).detach();
    }
}

fn check_quietly(cx: &mut AsyncApp) {
    let _ = cx.update(check);
}

fn check(cx: &mut App) {
    let e = entity(cx);
    if e.read(cx).ready.is_some() {
        apply(cx);
        return;
    }
    let Some(feed) = FEED else { return };
    if e.read(cx).checking {
        return;
    }
    e.update(cx, |u, _| u.checking = true);
    let net = cx.global::<Net>().clone();
    let feed = feed.trim_end_matches('/').to_string();
    let job = net.rt.spawn(async move { fetch(&feed).await });
    cx.spawn(async move |cx| {
        let got = job.await.unwrap_or_else(|e| Err(e.to_string()));
        let _ = cx.update(|cx| {
            let e = entity(cx);
            e.update(cx, |u, cx| {
                u.checking = false;
                match got {
                    Ok(Some(r)) => {
                        u.ready = Some(r);
                        u.state = state(&u.ready);
                        cx.notify();
                    }
                    Ok(None) => {}
                    Err(error) => report(&error),
                }
            });
            if e.read(cx).ready.is_some() {
                apply(cx);
            }
        });
    })
    .detach();
}

/// The feed's newest, downloaded, checked and unpacked; None when there's none to have.
async fn fetch(feed: &str) -> Result<Option<Ready>, String> {
    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let info: Info = http.get(format!("{feed}/update.json")).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    if info.hash.is_empty() || info.hash == HASH || info.version == VERSION {
        return Ok(None);
    }
    // One tried already isn't fetched again.
    if tried().is_some_and(|t| t.hash == info.hash) {
        return Ok(None);
    }
    let dir = support().join("updates");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let url = if info.url.contains("://") { info.url.clone() } else { format!("{feed}/{}", info.url) };
    let mut res = http.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let zip = dir.join("update.zip");
    let mut file = std::fs::File::create(&zip).map_err(|e| e.to_string())?;
    let mut sum = Sha256::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        sum.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
    }
    drop(file);
    let got = sum.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !got.eq_ignore_ascii_case(&info.sha256) {
        return Err("the update's checksum doesn't match".into());
    }
    let unpacked = dir.join("app");
    let ok = Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&zip).arg(&unpacked).status().is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&zip);
    if !ok {
        return Err("the update didn't unpack".into());
    }
    let app = std::fs::read_dir(&unpacked).map_err(|e| e.to_string())?.flatten().map(|d| d.path()).find(|p| p.extension().is_some_and(|x| x == "app")).ok_or("the update holds no app")?;
    Ok(Some(Ready { info, app }))
}

fn apply(cx: &mut App) {
    let e = entity(cx);
    if e.read(cx).ready.is_none() || held(cx) || !local().auto_update {
        return;
    }
    let launched = e.read(cx).launched;
    if !FOCUSED.load(Ordering::Relaxed) || launched.elapsed() < LAUNCH || super::idle::idle_ms() > IDLE_MS {
        put_in(false, cx);
    }
}

/// Puts the waiting version in (a relaunch), unless it's running already, was tried already, or the
/// last one didn't take and the wait after it isn't over. `asked`: from the system page.
fn put_in(asked: bool, cx: &mut App) {
    let e = entity(cx);
    let Some((want, app)) = e.read(cx).ready.as_ref().map(|r| (r.info.clone(), r.app.clone())) else { return };
    let drop_ready = |cx: &mut App| {
        e.update(cx, |u, cx| {
            u.ready = None;
            u.state = state(&None);
            cx.notify();
        })
    };
    if want.hash.is_empty() || want.hash == HASH || want.version == VERSION {
        drop_ready(cx);
        return;
    }
    let t = tried();
    let wait = match &t {
        Some(t) if t.failed > 0 => (BACKOFF_MS * 2f64.powi(t.failed as i32 - 1)).min(BACKOFF_MAX_MS),
        _ => 0.,
    };
    if !asked && t.as_ref().is_some_and(|t| t.hash == want.hash) {
        // Tried and it didn't take: what's checked next may be newer.
        drop_ready(cx);
        return;
    }
    if !asked && t.as_ref().is_some_and(|t| now_ms() < t.at + wait) {
        return;
    }
    let Some(live) = bundle() else { return };
    keep_tried(&Tried { hash: want.hash.clone(), at: now_ms(), failed: t.map(|t| t.failed).unwrap_or(0), open: true });
    // Once this app has quit: the new one moved in where it was, the old one put back if that
    // fails, and whichever is there opened.
    let script = r#"pid=$1; live=$2; new=$3
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
aside="$live.old-$$"
if mv "$live" "$aside" && mv "$new" "$live"; then rm -rf "$aside"; elif [ -d "$aside" ] && [ ! -e "$live" ]; then mv "$aside" "$live"; fi
xattr -dr com.apple.quarantine "$live" 2>/dev/null
open "$live""#;
    use std::os::unix::process::CommandExt;
    let spawned = Command::new("/bin/sh")
        .args(["-c", script, "switch-update", &std::process::id().to_string()])
        .arg(&live)
        .arg(&app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own group: it outlives the app.
        .process_group(0)
        .spawn();
    if spawned.is_ok() {
        cx.quit();
    }
}

/// What Settings asks: the waiting update applied now.
pub fn apply_now(cx: &mut App) {
    if entity(cx).read(cx).ready.is_some() && !crate::outbox::quiet() {
        put_in(true, cx);
    }
}
