//! Video and sound played in place (the desktop's `ui/video-tile.tsx`, `widgets/basic/use-media.ts`
//! and `transport.tsx`, and `attached.tsx`'s sound). AVFoundation plays each; a video's frames come
//! out of it as pixel buffers in the format gpui's Metal renderer draws, and gpui's own surface
//! element draws them. Each player is kept by its address in one registry, so a list drawing its
//! rows afresh every frame finds the same one, and one plays at a time across the app: one
//! starting pauses the one playing.

use std::collections::HashMap;
use std::ptr::NonNull;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext, Bounds, Context, Entity, FocusHandle, Focusable, FontFeatures,
    InteractiveElement, IntoElement, MouseButton, ObjectFit, ParentElement, PathBuilder, Pixels, Render, Rems,
    StatefulInteractiveElement, Styled, Task, TitlebarOptions, WeakEntity, Window, WindowBounds, WindowOptions,
    canvas, div, point, prelude::*, px, relative, size, surface, svg,
};
use objc2::{AnyThread, MainThreadMarker};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{AVPlayer, AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_media::{CMTime, kCMTimeZero};
use objc2_core_video::{
    CVPixelBuffer, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
use ui_sdk::components::button::{Button, ButtonOptions};
use ui_sdk::components::slider::{Slider, SliderOptions};
use ui_sdk::kernel::ActionOutcome;

use crate::chat::key_look;
use crate::look::{Look, u};
use crate::net::Net;

/// Phosphor's play and pause, bold (the desktop's `widgets/basic/icons.ts`), and arrows-out-simple
/// for Full screen (`video-tile.tsx`), on a 256 grid.
const PLAY: &str = "M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z";
const PAUSE: &str = "M200,28H160a20,20,0,0,0-20,20V208a20,20,0,0,0,20,20h40a20,20,0,0,0,20-20V48A20,20,0,0,0,200,28Zm-4,176H164V52h32ZM96,28H56A20,20,0,0,0,36,48V208a20,20,0,0,0,20,20H96a20,20,0,0,0,20-20V48A20,20,0,0,0,96,28ZM92,204H60V52H92Z";
const SPEAKER: &str = "M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z";
const MUTED: &str = "M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm101.66-61.3a8,8,0,0,1-11.32,11.32L216,139.31l-18.34,18.35a8,8,0,0,1-11.32-11.32L204.69,128l-18.35-18.34a8,8,0,0,1,11.32-11.32L216,116.69l18.34-18.35a8,8,0,0,1,11.32,11.32L227.31,128Z";
const FULL: &str = "M220,48V96a12,12,0,0,1-24,0V77l-39.51,39.52a12,12,0,0,1-17-17L179,60H160a12,12,0,0,1,0-24h48A12,12,0,0,1,220,48ZM99.51,139.51,60,179V160a12,12,0,0,0-24,0v48a12,12,0,0,0,12,12H96a12,12,0,0,0,0-24H77l39.52-39.51a12,12,0,0,0-17-17Z";

/// How often a player reads where it's at while it plays or loads: the media element's
/// `timeupdate`. Frames come on the window's own frames instead.
const TICK: Duration = Duration::from_millis(100);

/// A glyph's path by name (`media/<name>.svg` among the app's drawings).
pub fn glyph(name: &str) -> Option<&'static str> {
    Some(match name {
        "play" => PLAY,
        "pause" => PAUSE,
        "full" => FULL,
        "speaker" => SPEAKER,
        "muted" => MUTED,
        _ => return None,
    })
}

/// Every player, by what it plays, and the one playing now.
#[derive(Default)]
struct Media {
    players: HashMap<String, Entity<Player>>,
    now: Option<WeakEntity<Player>>,
}

impl gpui::Global for Media {}

/// A key over a video, or a sound's line: Play or Pause, and Full screen.
struct Keys {
    play: Entity<Button>,
    full: Option<Entity<Button>>,
}

/// A video's or a sound's state, as use-media.ts keeps it: where it's at, how long it is, whether
/// it plays; and the video's latest frame.
pub struct Player {
    av: Retained<AVPlayer>,
    item: Retained<AVPlayerItem>,
    /// A video's frames; a sound has none.
    output: Option<Retained<AVPlayerItemVideoOutput>>,
    frame: Option<CFRetained<CVPixelBuffer>>,
    /// The picture's own size, once it's known.
    natural: Option<(f32, f32)>,
    pub at: f64,
    pub length: f64,
    pub playing: bool,
    /// Moved to its first frame, for the picture before it plays (the TS's `#t=0.001`).
    primed: bool,
    /// Moved while paused: the frame there is still to come.
    stale: bool,
    ticking: bool,
    ticker: Option<Task<()>>,
    keys: Option<Keys>,
    track: Option<Entity<Slider<f64>>>,
    /// The length the track was last told.
    track_length: f64,
    full: Option<AnyWindowHandle>,
    /// A sound's loudness, as a media element's controls set it: silenced, and how loud (0 to 1).
    muted: bool,
    volume: f64,
    mute_key: Option<Entity<Button>>,
    loudness: Option<Entity<Slider<f64>>>,
}

/// Where a player fetches from: a route on the core (`/blobs/<hash>`) under its type and name with
/// the credential, as `blobUrl` makes one; an http address or a file as it is.
fn address_of(route: &str, kind: &str, name: &str, cx: &App) -> Option<Retained<NSURL>> {
    if route.starts_with("http://") || route.starts_with("https://") {
        return NSURL::URLWithString(&NSString::from_str(route));
    }
    if !route.starts_with("/blobs/") {
        return Some(NSURL::fileURLWithPath(&NSString::from_str(route)));
    }
    let address = cx.global::<Net>().address(route, &[("type", kind), ("name", name)])?;
    NSURL::URLWithString(&NSString::from_str(&address))
}

/// A CoreFoundation key as the Foundation string it's bridged to.
fn ns(key: &CFString) -> &NSString {
    // SAFETY: CFString and NSString are toll-free bridged.
    unsafe { &*(key as *const CFString as *const NSString) }
}

fn seconds(t: CMTime) -> f64 {
    // SAFETY: a plain conversion of a time value.
    unsafe { t.seconds() }
}

unsafe extern "C" {
    fn mach_absolute_time() -> u64;
}

/// The player for `route`, made the first time it's asked for. None while the credential's not in.
fn player_of(route: &str, kind: &str, name: &str, video: bool, cx: &mut App) -> Option<Entity<Player>> {
    let key = format!("{}{route}", if video { "video " } else { "sound " });
    if !cx.has_global::<Media>() {
        cx.set_global(Media::default());
    }
    if let Some(p) = cx.global::<Media>().players.get(&key) {
        return Some(p.clone());
    }
    let url = address_of(route, kind, name, cx)?;
    let player = cx.new(|cx| Player::new(&url, video, cx));
    cx.global_mut::<Media>().players.insert(key, player.clone());
    Some(player)
}

impl Player {
    fn new(url: &NSURL, video: bool, cx: &mut Context<Self>) -> Self {
        let mtm = MainThreadMarker::new().expect("main thread");
        // SAFETY: AVFoundation's constructors, on the main thread, with valid arguments.
        let (av, item, output) = unsafe {
            let item = AVPlayerItem::playerItemWithURL(url, mtm);
            let output = video.then(|| {
                // Biplanar 4:2:0 YCbCr, full range, Metal-compatible on an IOSurface: what gpui's
                // surface draws.
                let format = NSNumber::new_u32(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
                let yes = NSNumber::new_bool(true);
                let none = NSDictionary::<NSString, AnyObject>::new();
                let keys = [
                    ns(kCVPixelBufferPixelFormatTypeKey),
                    ns(kCVPixelBufferMetalCompatibilityKey),
                    ns(kCVPixelBufferIOSurfacePropertiesKey),
                ];
                let values: [&AnyObject; 3] = [&format, &yes, &none];
                let attributes = NSDictionary::from_slices(&keys, &values);
                let output = AVPlayerItemVideoOutput::initWithPixelBufferAttributes(AVPlayerItemVideoOutput::alloc(), Some(&attributes));
                item.addOutput(&output);
                output
            });
            (AVPlayer::playerWithPlayerItem(Some(&item), mtm), item, output)
        };
        let mut p = Player {
            av,
            item,
            output,
            frame: None,
            natural: None,
            at: 0.,
            length: f64::NAN,
            playing: false,
            primed: false,
            stale: false,
            ticking: false,
            ticker: None,
            keys: None,
            track: None,
            track_length: f64::NAN,
            full: None,
            muted: false,
            volume: 1.,
            mute_key: None,
            loudness: None,
        };
        p.keep_ticking(cx);
        p
    }

    fn known(&self) -> bool {
        self.length.is_finite() && self.length > 0.
    }

    /// Reads it on a timer while it plays, loads, or waits for a frame.
    fn keep_ticking(&mut self, cx: &mut Context<Self>) {
        if self.ticking {
            return;
        }
        self.ticking = true;
        self.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let more = this.update(cx, |p, cx| p.tick(cx)).unwrap_or(false);
                if !more {
                    break;
                }
            }
        }));
    }

    /// Where it's at and how long it is, read again; a video's first frame once it can be had.
    /// Says whether to keep reading.
    fn tick(&mut self, cx: &mut Context<Self>) -> bool {
        // SAFETY: reading the player and its item on the main thread.
        let (status, length, at, rate, natural) = unsafe {
            let s = self.item.presentationSize();
            (self.item.status(), seconds(self.item.duration()), seconds(self.av.currentTime()), self.av.rate(), s)
        };
        let before = (self.at, self.length, self.playing, self.frame.is_some());
        if length.is_finite() && length > 0. {
            self.length = length;
        }
        if at.is_finite() {
            self.at = at;
        }
        if natural.width > 0. && natural.height > 0. {
            self.natural = Some((natural.width as f32, natural.height as f32));
        }
        let ready = status == AVPlayerItemStatus::ReadyToPlay;
        if ready && self.output.is_some() && !self.primed {
            self.primed = true;
            // SAFETY: a seek on the main thread.
            unsafe {
                self.av.seekToTime_toleranceBefore_toleranceAfter(CMTime::with_seconds(0.001, 600), kCMTimeZero, kCMTimeZero);
            }
        }
        if self.primed && (self.frame.is_none() || self.stale) && self.pull() {
            self.stale = false;
        }
        // It ended or something else stopped it.
        if self.playing && rate == 0. {
            self.playing = false;
        }
        if before != (self.at, self.length, self.playing, self.frame.is_some()) {
            cx.notify();
        }
        let waiting = self.output.is_some() && (self.frame.is_none() || self.stale);
        let more = status != AVPlayerItemStatus::Failed && (self.playing || !ready || waiting);
        if !more {
            self.ticking = false;
        }
        more
    }

    /// Takes the video's frame for now, when there's a new one. Says whether it did.
    fn pull(&mut self) -> bool {
        let Some(output) = &self.output else { return false };
        // SAFETY: the output is the item's, read on the main thread; the copy is ours to keep.
        unsafe {
            let t = output.itemTimeForMachAbsoluteTime(mach_absolute_time() as i64);
            if !output.hasNewPixelBufferForItemTime(t) {
                return false;
            }
            let Some(buffer) = output.copyPixelBufferForItemTime_itemTimeForDisplay(t, std::ptr::null_mut()) else {
                return false;
            };
            let raw = Retained::into_raw(buffer);
            self.frame = Some(CFRetained::from_raw(NonNull::new_unchecked(raw)));
        }
        true
    }

    /// Plays it or pauses it.
    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        if self.playing { self.pause(cx) } else { self.play(cx) }
    }

    fn play(&mut self, cx: &mut Context<Self>) {
        let me = cx.entity();
        let was = cx.global_mut::<Media>().now.replace(me.downgrade());
        if let Some(other) = was.and_then(|w| w.upgrade()).filter(|o| *o != me) {
            other.update(cx, |p, cx| p.pause(cx));
        }
        // A widget's video or sound too: one plays at a time.
        crate::widgets::basic::playback::pause_all();
        // SAFETY: the player, on the main thread.
        unsafe {
            // Played at its end, it starts again, as a media element does.
            if self.known() && self.at >= self.length - 0.05 {
                self.av.seekToTime(kCMTimeZero);
                self.at = 0.;
            }
            self.av.play();
        }
        self.playing = true;
        self.keep_ticking(cx);
        cx.notify();
    }

    fn pause(&mut self, cx: &mut Context<Self>) {
        // SAFETY: the player, on the main thread.
        unsafe { self.av.pause() };
        self.playing = false;
        cx.notify();
    }

    /// Silenced, or not.
    fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        self.muted = !self.muted;
        // SAFETY: the player, on the main thread.
        unsafe { self.av.setMuted(self.muted) };
        cx.notify();
    }

    /// How loud, 0 to 1; a sound turned up from nothing is heard again.
    fn set_volume(&mut self, to: f64, cx: &mut Context<Self>) {
        self.volume = to.clamp(0., 1.);
        // SAFETY: the player, on the main thread.
        unsafe { self.av.setVolume(self.volume as f32) };
        if self.muted && self.volume > 0. {
            self.muted = false;
            unsafe { self.av.setMuted(false) };
        }
        cx.notify();
    }

    /// Moves it to `to` seconds.
    pub fn seek(&mut self, to: f64, cx: &mut Context<Self>) {
        // SAFETY: a seek on the main thread.
        unsafe {
            self.av.seekToTime_toleranceBefore_toleranceAfter(CMTime::with_seconds(to, 600), kCMTimeZero, kCMTimeZero);
        }
        self.at = to;
        if !self.playing && self.output.is_some() {
            self.stale = true;
            self.keep_ticking(cx);
        }
        cx.notify();
    }

    /// A video's keys, made with the window that first draws it.
    fn keys(&mut self, full: bool, window: &mut Window, cx: &mut Context<Self>) -> &Keys {
        if self.keys.is_none() {
            self.keys = Some(make_keys(cx.entity().downgrade(), full, window, cx));
        }
        self.keys.as_ref().expect("keys")
    }
}

fn make_keys(player: WeakEntity<Player>, full: bool, window: &mut Window, cx: &mut App) -> Keys {
    let toggled = player.clone();
    let play = cx.new(|cx| {
        Button::new(
            // After the key's own update, as every key's and field's word here is heard.
            ButtonOptions::default().action(move |_, _, _, cx| {
                let toggled = toggled.clone();
                cx.defer(move |cx| drop(toggled.update(cx, |p, cx| p.toggle(cx))));
                ActionOutcome::Done
            }),
            window,
            cx,
        )
    });
    let full = full.then(|| {
        cx.new(|cx| {
            Button::new(
                ButtonOptions::default().action(move |_, _, window, cx| {
                    if let Some(p) = player.upgrade() {
                        window.defer(cx, move |window, cx| full_screen(p, window, cx));
                    }
                    ActionOutcome::Done
                }),
                window,
                cx,
            )
        })
    });
    Keys { play, full }
}

/// A glyph, 14 px, in the ink around it (`glyph.tsx`).
fn glyph_of(name: &str) -> gpui::Svg {
    svg().path(format!("media/{name}.svg")).flex_none().size(u(14.))
}

/// The keys over a video's bottom edge: Play or Pause on the left, Full screen on the right; shown
/// while it's paused or under the pointer.
fn key_row(keys: &Keys, playing: bool, group: &'static str, l: &Look, cx: &App) -> gpui::Stateful<gpui::Div> {
    let play = key_look(Button::root(&keys.play, cx), l)
        .px(u(6.))
        .aria_label(if playing { "Pause" } else { "Play" })
        .child(glyph_of(if playing { "pause" } else { "play" }).text_color(l.ink));
    div()
        .id("keys")
        .absolute()
        .left(u(6.))
        .right(u(6.))
        .bottom(u(6.))
        .flex()
        .items_center()
        .justify_between()
        .occlude()
        .when(playing, |d| d.invisible().group_hover(group, |s| s.visible()))
        .child(play)
        .children(keys.full.as_ref().map(|full| {
            key_look(Button::root(full, cx), l).px(u(6.)).aria_label("Full screen").child(glyph_of("full").text_color(l.ink))
        }))
}

/// The four corners outside a rounded frame, in the background: gpui's surface has no rounding of
/// its own, so the frame's corners are painted over it.
fn corners(radius: Pixels, color: gpui::Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |b: Bounds<Pixels>, _, window, _| {
            let r = radius.min(b.size.width / 2.).min(b.size.height / 2.);
            // How far a quarter circle's control points sit along its tangents.
            let k = r * 0.447_715;
            let (x0, y0, x1, y1) = (b.left(), b.top(), b.right(), b.bottom());
            let shapes = [
                // Each: the corner, its two ends on the edges, and the two control points between.
                (point(x0, y0), point(x0, y0 + r), point(x0 + r, y0), point(x0, y0 + k), point(x0 + k, y0)),
                (point(x1, y0), point(x1 - r, y0), point(x1, y0 + r), point(x1 - k, y0), point(x1, y0 + k)),
                (point(x1, y1), point(x1, y1 - r), point(x1 - r, y1), point(x1, y1 - k), point(x1 - k, y1)),
                (point(x0, y1), point(x0 + r, y1), point(x0, y1 - r), point(x0 + k, y1), point(x0, y1 - k)),
            ];
            for (corner, from, to, c1, c2) in shapes {
                let mut path = PathBuilder::fill();
                path.move_to(corner);
                path.line_to(from);
                path.cubic_bezier_to(to, c1, c2);
                path.close();
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .absolute()
    .inset_0()
}

/// A video tile: `route` is the blob route ("/blobs/<hash>"), `kind` its MIME type, `frame_h` its
/// height. Black behind the picture, contained in it; as wide as the picture at that height, at most
/// 420. A click on the picture plays or pauses it; a right-click is the file's menu.
pub fn video_tile(
    route: &str,
    kind: &str,
    name: &str,
    frame_h: Rems,
    on_menu: Rc<dyn Fn(&mut Window, &mut App)>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let l = Look::get(cx);
    let rem = window.rem_size();
    let h = frame_h.to_pixels(rem);
    let widest = u(420.).to_pixels(rem);
    let Some(player) = player_of(route, kind, name, true, cx) else {
        // Before the credential's in, the frame as a video element is before it loads: 300 × 150.
        return div().flex_none().h(h).w((h * 2.).min(widest)).rounded(u(18.)).bg(l.black).into_any_element();
    };
    let playing = player.read(cx).playing;
    if playing {
        player.update(cx, |p, _| p.pull());
        window.request_animation_frame();
    }
    player.update(cx, |p, cx| {
        p.keys(true, window, cx);
    });
    let p = player.read(cx);
    let (nw, nh) = p.natural.unwrap_or((300., 150.));
    let w = (h * (nw / nh)).min(widest);
    let frame = p.frame.clone();
    let keys = key_row(p.keys.as_ref().expect("keys"), playing, "video", &l, cx);
    let toggled = player.clone();
    let radius = u(18.).to_pixels(rem);
    div()
        .id(gpui::ElementId::Name(format!("video {route}").into()))
        .group("video")
        .relative()
        .flex_none()
        .h(h)
        .w(w)
        .bg(l.black)
        .on_mouse_down(MouseButton::Right, move |_, window, cx| on_menu(window, cx))
        .child(
            div()
                .id("picture")
                .size_full()
                .on_click(move |_, _, cx| toggled.update(cx, |p, cx| p.toggle(cx)))
                .children(frame.map(|f| surface(f).object_fit(ObjectFit::Contain).size_full())),
        )
        .child(corners(radius, l.bg))
        .child(div().absolute().inset_0().rounded(radius).border_1().border_color(l.line1))
        .child(keys)
        .into_any_element()
}

/// "1:05", or "1:02:05" past an hour, cut to the second (`spanOf`).
fn span_of(s: f64) -> String {
    let t = if s.is_finite() { s.max(0.) as u64 } else { 0 };
    let (h, m, s) = (t / 3600, t / 60 % 60, t % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

fn track_options(p: &Player, player: WeakEntity<Player>) -> SliderOptions<f64> {
    let known = p.known();
    SliderOptions::default()
        .value(p.at)
        .min(0.)
        .max(if known { p.length } else { 1. })
        .step(1.)
        .disabled(!known)
        // After the track's own update, as every field's change here is heard.
        .on_value_change(move |to, _, _, cx| {
            let (to, player) = (*to, player.clone());
            cx.defer(move |cx| drop(player.update(cx, |p, cx| p.seek(to, cx))));
        })
}

/// A sound to play in place, its controls in the house look: Play or Pause on a key, where it's at
/// on a track to press or drag, and its time and length as figures at the line's end
/// (`transport.tsx`), in the frame a chat's sound has (`attached.tsx`).
pub fn audio_player(
    route: &str,
    kind: &str,
    name: &str,
    on_menu: Rc<dyn Fn(&mut Window, &mut App)>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let l = Look::get(cx);
    let frame = div()
        .id(gpui::ElementId::Name(format!("sound {route}").into()))
        .flex()
        .flex_none()
        .items_center()
        .gap(u(10.))
        .h(u(40.))
        .w(u(320.))
        .max_w(relative(0.8))
        .px(u(12.))
        .rounded(u(18.))
        .border_1()
        .border_color(l.line1)
        .on_mouse_down(MouseButton::Right, move |_, window, cx| on_menu(window, cx));
    let Some(player) = player_of(route, kind, name, false, cx) else {
        return frame.into_any_element();
    };
    player.update(cx, |p, cx| {
        p.keys(false, window, cx);
    });
    let (scrubber, figures) = transport(&player, &l, window, cx);
    // Mute and how loud, as an `audio` element's controls have them.
    player.update(cx, |p, cx| {
        if p.mute_key.is_none() {
            let weak = cx.entity().downgrade();
            p.mute_key = Some(cx.new(|cx| {
                Button::new(
                    ButtonOptions::default().action(move |_, _, _, cx| {
                        let weak = weak.clone();
                        cx.defer(move |cx| drop(weak.update(cx, |p, cx| p.toggle_mute(cx))));
                        ActionOutcome::Done
                    }),
                    window,
                    cx,
                )
            }));
        }
        if p.loudness.is_none() {
            let weak = cx.entity().downgrade();
            let options = SliderOptions::default().value(p.volume).min(0.).max(1.).step(0.05).on_value_change(move |to, _, _, cx| {
                let (to, weak) = (*to, weak.clone());
                cx.defer(move |cx| drop(weak.update(cx, |p, cx| p.set_volume(to, cx))));
            });
            p.loudness = Some(cx.new(|cx| Slider::new(options, window, cx)));
        }
    });
    let p = player.read(cx);
    let keys = p.keys.as_ref().expect("keys");
    let play = key_look(Button::root(&keys.play, cx), &l)
        .flex_none()
        .px(u(6.))
        .aria_label(if p.playing { "Pause" } else { "Play" })
        .child(glyph_of(if p.playing { "pause" } else { "play" }).text_color(l.ink));
    let silent = p.muted || p.volume <= 0.;
    let mute = p.mute_key.as_ref().map(|k| key_look(Button::root(k, cx), &l).flex_none().px(u(6.)).aria_label(if p.muted { "Unmute" } else { "Mute" }).child(glyph_of(if silent { "muted" } else { "speaker" }).text_color(l.ink)));
    // Drawn as the track is: a line, its filled part and a round thumb.
    let loud = p.loudness.as_ref().map(|s| {
        let thumb = Slider::thumb(s, 0, cx).aria_label("Volume").size(u(12.)).rounded_full().border_1().border_color(l.key_border).bg(l.bg).hover(|st| st.bg(l.hover));
        let line = Slider::track(s, cx).h(px(3.)).w_full().rounded_full().bg(l.line1).child(Slider::indicator(s, cx).rounded_full().bg(l.ink)).child(thumb);
        Slider::root(s, cx).flex_none().w(u(56.)).child(Slider::control(s, cx).flex().items_center().h(u(24.)).child(line))
    });
    frame.child(play).child(scrubber).child(figures).children(mute).children(loud).into_any_element()
}

/// Where a player is, on a track to press or drag, and its time and length as figures.
fn transport(player: &Entity<Player>, l: &Look, window: &mut Window, cx: &mut App) -> (gpui::AnyElement, gpui::AnyElement) {
    let l = *l;
    player.update(cx, |p, cx| {
        if p.track.is_none() {
            let options = track_options(p, cx.entity().downgrade());
            p.track = Some(cx.new(|cx| Slider::new(options, window, cx)));
            p.track_length = p.length;
        }
    });
    // The track's bounds follow the length once it's known; its value follows where it's at.
    let (track, at, length, stale) = {
        let p = player.read(cx);
        let track = p.track.clone().expect("track");
        let stale = p.track_length.to_bits() != p.length.to_bits();
        (track, p.at, p.length, stale)
    };
    if stale {
        let options = track_options(player.read(cx), player.downgrade());
        track.update(cx, |t, cx| t.set_options(options, window, cx));
        player.update(cx, |p, _| p.track_length = length);
    } else if track.read(cx).state().value.round() != at.round() {
        track.update(cx, |t, cx| t.set_controlled_value(Some(at), cx));
    }
    let p = player.read(cx);
    let known = p.known();
    let thumb = Slider::thumb(&track, 0, cx)
        .aria_label("Position")
        .size(u(14.))
        .rounded_full()
        .border_1()
        .border_color(l.key_border)
        .bg(l.bg)
        .hover(|s| s.bg(l.hover));
    let line = Slider::track(&track, cx)
        .h(px(3.))
        .w_full()
        .rounded_full()
        .bg(l.line1)
        .child(Slider::indicator(&track, cx).rounded_full().bg(l.ink))
        .child(thumb);
    let scrubber = Slider::root(&track, cx)
        .flex_1()
        .min_w_0()
        .when(!known, |d| d.opacity(0.4))
        .child(Slider::control(&track, cx).flex().items_center().h(u(24.)).child(line));
    let figures = div()
        .flex_none()
        .pl(u(12.))
        .text_size(u(11.))
        .text_color(l.ink2)
        .font_features(FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)])))
        .child(format!("{} / {}", span_of(p.at), if known { span_of(p.length) } else { "–:––".into() }));
    (scrubber.into_any_element(), figures.into_any_element())
}



/// Puts a video in a window of its own, filling the screen; asked again, takes it out.
fn full_screen(player: Entity<Player>, window: &mut Window, cx: &mut App) {
    if let Some(open) = player.read(cx).full {
        player.update(cx, |p, _| p.full = None);
        open.update(cx, |_, window, _| window.remove_window()).ok();
        return;
    }
    let display = window.display(cx);
    let bounds = display.as_ref().map(|d| d.bounds()).unwrap_or_else(|| Bounds::centered(None, size(px(1280.), px(800.)), cx));
    let shown = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Fullscreen(bounds)),
            titlebar: Some(TitlebarOptions { title: None, appears_transparent: true, traffic_light_position: None }),
            display_id: display.map(|d| d.id()),
            focus: true,
            show: true,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| FullScreen::new(player.clone(), window, cx)),
    );
    if let Ok(handle) = shown {
        player.update(cx, |p, _| p.full = Some(handle.into()));
    }
}

/// A video filling the screen in a window of its own: the same player's frames on black, its keys
/// over the bottom edge. Esc or Full screen leaves.
struct FullScreen {
    player: Entity<Player>,
    keys: Keys,
    focus: FocusHandle,
}

impl FullScreen {
    fn new(player: Entity<Player>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let keys = make_keys(player.downgrade(), true, window, cx);
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let gone = player.downgrade();
        cx.on_release(move |_, cx| {
            gone.update(cx, |p, _| p.full = None).ok();
        })
        .detach();
        FullScreen { player, keys, focus }
    }
}

impl Focusable for FullScreen {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FullScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let playing = self.player.read(cx).playing;
        if playing {
            self.player.update(cx, |p, _| p.pull());
            window.request_animation_frame();
        }
        let frame = self.player.read(cx).frame.clone();
        let toggled = self.player.clone();
        let leaving = self.player.clone();
        div()
            .id("full screen")
            .track_focus(&self.focus)
            .group("full")
            .relative()
            .size_full()
            .bg(l.black)
            .on_key_down(move |e, window, cx| {
                if e.keystroke.key == "escape" {
                    leaving.update(cx, |p, _| p.full = None);
                    window.remove_window();
                }
            })
            .child(
                div()
                    .id("picture")
                    .size_full()
                    .on_click(move |_, _, cx| toggled.update(cx, |p, cx| p.toggle(cx)))
                    .children(frame.map(|f| surface(f).object_fit(ObjectFit::Contain).size_full())),
            )
            .child(key_row(&self.keys, playing, "full", &l, cx))
            // As WebKit's own full-screen video: where it's at and how long, to drag through.
            .child({
                let (scrubber, figures) = transport(&self.player, &l, window, cx);
                div()
                    .absolute()
                    .bottom(u(6.))
                    .left(u(48.))
                    .right(u(48.))
                    .h(u(24.))
                    .flex()
                    .items_center()
                    .px(u(10.))
                    .rounded(u(4.))
                    .bg(l.bg.opacity(0.8))
                    .child(scrubber)
                    .child(figures)
            })
    }
}

/// A window to look at video tiles and a sound ($SWITCH_GPUI_MEDIA: files or addresses, by commas):
/// a tile for each, in a row, and the first as a sound.
pub struct LookAt {
    srcs: Vec<String>,
}

impl LookAt {
    pub fn open(srcs: String, cx: &mut App) {
        let srcs = srcs.split(',').map(str::to_string).collect();
        let bounds = Bounds::new(point(px(40.), px(560.)), size(px(900.), px(420.)));
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(|_| LookAt { srcs }),
        )
        .ok();
    }
}

impl Render for LookAt {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let name_of = |src: &str| src.rsplit('/').next().unwrap_or_default().to_string();
        let menu: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(|_, _| eprintln!("menu"));
        let tiles: Vec<AnyElement> =
            self.srcs.iter().map(|src| video_tile(src, "video/mp4", &name_of(src), u(240.), menu.clone(), window, cx)).collect();
        let first = self.srcs[0].clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap(u(12.))
            .p(u(24.))
            .bg(l.bg)
            .child(div().flex().gap(u(6.)).children(tiles))
            .child(audio_player(&first, "audio/mp4", &name_of(&first), menu, window, cx))
    }
}

/// Pauses the chat's video or sound that's playing (a widget's starting: one plays at a time).
pub fn pause_playing(cx: &mut App) {
    let now = cx.try_global::<Media>().and_then(|m| m.now.clone()).and_then(|w| w.upgrade());
    if let Some(p) = now {
        p.update(cx, |p, cx| {
            if p.playing {
                p.pause(cx);
            }
        });
    }
}
