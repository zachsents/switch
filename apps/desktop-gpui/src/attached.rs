//! Files wherever they show (the desktop's `ui/attached.tsx`, `picture-row.tsx`): pictures and
//! videos as a row that scrolls sideways, a lone picture in place, sound to play, 3D files to turn,
//! and any other file as its name and size. A picture's or a video's click opens it full screen
//! (`viewer.rs`; a row's, on the row's pictures and videos at that one); a video's key plays it in
//! place; a file's name, clicked, saves it to Downloads and opens it (a 3D file in Preview), turning
//! while it's fetched. Right-click gives Open, Quick Look,
//! Copy, Download, Show in Finder (once downloaded) and Share. Each is a set height before it loads, so a column keeps to its
//! latest as they come in. When a row holds more than it shows, its count shows under it.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext, Entity, Global, InteractiveElement, IntoElement, MouseButton, ParentElement,
    ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Window, div, img, prelude::*, px, relative,
};

use crate::brain::Attachment;
use crate::chat_platform::{self, Do};
use crate::files::size_of;
use crate::look::{Look, u};
use crate::marks;
use crate::model3d::{ModelSize, model_view};
use crate::nav::Beat;
use crate::pictures::{Pictures, format_of};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Model,
    Image,
    Video,
    Audio,
    File,
}

/// What a file is, as a chat draws it (the brain's `kindOf`).
pub fn kind_of(kind: &str, name: &str) -> FileKind {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    if ["stl", "3mf", "glb", "gltf", "obj"].contains(&ext.as_str()) || kind.starts_with("model/") {
        FileKind::Model
    } else if kind.starts_with("image/") {
        FileKind::Image
    } else if kind.starts_with("video/") {
        FileKind::Video
    } else if kind.starts_with("audio/") {
        FileKind::Audio
    } else {
        FileKind::File
    }
}

/// A file as it's drawn: where it's served, its name and type, and its size when known.
#[derive(Clone)]
pub struct Shown {
    pub route: String,
    pub name: String,
    pub kind: String,
    pub size: Option<f64>,
    /// Its blob, when it's the core's.
    pub blob: Option<String>,
    /// Its bytes on this Mac while it's being sent: drawn from here, not opened yet.
    pub local: Option<std::path::PathBuf>,
}

/// A message's file, served from the core's blobs under its name.
pub fn shown_of(a: &Attachment) -> Shown {
    let q = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    Shown { route: format!("/blobs/{}?type={}&name={}", a.blob, q(&a.kind), q(&a.name)), name: a.name.clone(), kind: a.kind.clone(), size: Some(a.size), blob: Some(a.blob.clone()), local: None }
}

/// A file of a message being sent, drawn from its bytes here: a video, a sound or a model from its
/// link under its name (`own.rs`), a picture from the kept bytes, so once it's up its message's
/// picture is that one, decoded already.
pub fn shown_kept(k: &crate::outbox::KeptFile) -> Shown {
    let kind = crate::files::type_of(&k.name, &k.kind);
    let linked = matches!(kind_of(&kind, &k.name), FileKind::Video | FileKind::Audio | FileKind::Model).then(|| crate::own::link(&k.id, &k.name)).flatten();
    let route = linked.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| format!("own:{}", k.id));
    Shown { route, name: k.name.clone(), kind, size: Some(k.size), blob: None, local: Some(crate::outbox::file_path(&k.id)) }
}

/// Where the chat draws a file: big in chat, small in an ask.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Size {
    Chat,
    Ask,
    Window,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Opening {
    Idle,
    Opening,
    Failed,
}

/// How each file's Open stands, by where it's served.
#[derive(Default)]
struct Opened(HashMap<String, Opening>);

struct OpenedHandle(Entity<Opened>);
impl Global for OpenedHandle {}

fn opened(cx: &mut App) -> Entity<Opened> {
    if let Some(h) = cx.try_global::<OpenedHandle>() {
        return h.0.clone();
    }
    let e = cx.new(|_| Opened::default());
    cx.set_global(OpenedHandle(e.clone()));
    e
}

/// Opened, turning while it's fetched; failed, its stop mark.
fn open(f: &Shown, window: &mut Window, cx: &mut App) {
    if f.local.is_some() {
        return;
    }
    let e = opened(cx);
    if e.read(cx).0.get(&f.route) == Some(&Opening::Opening) {
        return;
    }
    e.update(cx, |o, cx| {
        o.0.insert(f.route.clone(), Opening::Opening);
        cx.notify();
    });
    let job = chat_platform::file(&f.route, &f.name, Do::Open, window, cx);
    let route = f.route.clone();
    cx.spawn(async move |cx| {
        let ok = job.await;
        e.update(cx, |o, cx| {
            o.0.insert(route, if ok { Opening::Idle } else { Opening::Failed });
            cx.notify();
        });
    })
    .detach();
}

fn menu_of(f: &Shown) -> Rc<dyn Fn(&mut Window, &mut App)> {
    if f.local.is_some() {
        return Rc::new(|_, _| {});
    }
    let (route, name) = (f.route.clone(), f.name.clone());
    Rc::new(move |window, cx| {
        chat_platform::file(&route, &name, Do::Menu, window, cx).detach();
    })
}

/// `max-w-[min(80%,420px)]`: the fraction of the column, and within it the cap.
fn capped(inner: impl IntoElement, size: Size, l: &Look) -> gpui::Div {
    let (max, frac) = wide(size, l);
    div().flex().min_w_0().max_w(relative(frac)).child(div().flex().min_w_0().when_some(max, |d, m| d.max_w(m)).child(inner))
}

fn wide(size: Size, l: &Look) -> (Option<gpui::Pixels>, f32) {
    match size {
        Size::Chat => (Some(l.z(420.)), 0.8),
        _ => (Some(l.z(320.)), 1.),
    }
}

/// A file as its name and size; clicked, it's opened, turning while it's fetched.
fn file_line(f: &Shown, boxed: bool, size: Size, key: &str, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = opened(cx).read(cx).0.get(&f.route).copied().unwrap_or(Opening::Idle);
    let (fo, fm) = (f.clone(), menu_of(f));
    let id = SharedString::from(format!("{key}.line.{}", f.route));
    let focus = crate::said::focus_for(id.clone(), window, cx);
    crate::said::keyed(div().id(id), &focus, if boxed { l.z(18.) } else { px(0.) }, l, window)
        .flex()
        .h(u(40.))
        .max_w_full()
        .min_w_0()
        .items_center()
        .gap(u(12.))
        .px(u(12.))
        .text_size(u(12.))
        .line_height(u(16.))
        .hover(|s| s.bg(l.hover))
        .map(|d| if boxed { d.rounded(u(18.)).border_1().border_color(l.line1) } else { d.w_full().border_t(px(l.w1)).border_color(l.line1) })
        .on_click(move |_, window, cx| open(&fo, window, cx))
        .on_mouse_down(MouseButton::Right, move |_, window, cx| fm(window, cx))
        .child(div().min_w_0().flex_1().truncate().text_color(l.ink).child(f.name.clone()))
        .when(state == Opening::Opening, |d| d.child(crate::chat_marks::spin12(l, Beat::step(cx))))
        .when(state == Opening::Failed, |d| d.child(marks::stop(px(12.), l)))
        .when_some(f.size, |d, s| d.child(div().flex_none().text_size(u(11.)).font_features(crate::chat_marks::tabular()).text_color(l.ink3).child(size_of(s))))
        .map(|d| if boxed { capped(d, size, l).into_any_element() } else { d.into_any_element() })
}

/// The pictures and videos a row shows: any video, or more than one picture.
fn row_of(files: &[Shown]) -> Vec<Shown> {
    let media: Vec<Shown> = files.iter().filter(|f| matches!(kind_of(&f.kind, &f.name), FileKind::Image | FileKind::Video)).cloned().collect();
    if media.len() > 1 || media.iter().any(|f| kind_of(&f.kind, &f.name) == FileKind::Video) { media } else { vec![] }
}

fn counted(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// "3 pictures · 2 videos", each only when there are any.
fn count_of(items: &[Shown]) -> String {
    let videos = items.iter().filter(|f| kind_of(&f.kind, &f.name) == FileKind::Video).count();
    [if items.len() > videos { counted(items.len() - videos, "picture") } else { String::new() }, if videos > 0 { counted(videos, "video") } else { String::new() }]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Marks a picture drawn anew where `id` is (its state is made once while it stays drawn), so one
/// that couldn't be had is fetched again.
pub fn mount(id: &str, hash: &str, window: &mut Window, cx: &mut App) {
    let hash = hash.to_string();
    window.use_keyed_state(SharedString::from(format!("{id}.mount")), cx, move |_, cx| Pictures::mounted(&hash, cx));
}

/// The file full screen, as the viewer shows it.
fn item_of(f: &Shown) -> crate::viewer::Item {
    crate::viewer::Item { route: f.route.clone(), name: f.name.clone(), kind: f.kind.clone(), blob: f.blob.clone() }
}

/// A picture of the core's (or a link's), drawn when it's in; a set box until then. `radius` is its
/// frame's: gpui clips a frame's children to its box, not its rounded corners, so the picture takes
/// them itself.
#[allow(clippy::too_many_arguments)]
fn picture(f: &Shown, h: gpui::Pixels, max_w: gpui::Pixels, fit: gpui::ObjectFit, radius: gpui::Pixels, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    // Decoded at the most it's drawn on either side, in the screen's pixels: a wide one's width is
    // its longest side.
    let most = (f32::from(h.max(max_w)) * window.scale_factor()).ceil() as u32;
    if let Some(b) = &f.blob {
        mount(&format!("{}.{}", f.route, f32::from(h)), b, window, cx);
    }
    // One that couldn't be had is its name, as a page's `img` draws its `alt` in its place.
    if f.blob.as_ref().is_some_and(|b| Pictures::failed(b, cx)) {
        return div().h(h).max_w(max_w).flex().items_center().px(u(4.)).text_color(l.ink2).child(div().min_w_0().truncate().child(f.name.clone())).into_any_element();
    }
    let shown = match (&f.blob, &f.local) {
        (Some(b), _) => Pictures::sized(b, format_of(&f.kind, &f.name), most, cx),
        (None, Some(p)) => Pictures::local(p.clone(), most, cx),
        (None, None) => crate::widgets::media::WebPictures::get(&f.route, cx).map(gpui::ImageSource::Image),
    };
    match shown {
        Some(image) => img(image).h(h).max_w(max_w).object_fit(fit).rounded(radius).into_any_element(),
        None => div().h(h).w(h).rounded(radius).bg(l.hover).into_any_element(),
    }
}

/// Pictures and videos as one row that scrolls sideways, each at one height and its own width.
fn picture_row(pictures: &[Shown], size: Size, right: bool, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let any_video = pictures.iter().any(|p| kind_of(&p.kind, &p.name) == FileKind::Video);
    let (high, tall, max_w) = match size {
        Size::Chat => (160., 240., 420.),
        Size::Ask => (96., 240., 240.),
        Size::Window => (96., 384., 240.),
    };
    let h = l.z(if any_video { tall } else { high });
    let radius = l.z(18.);
    let all: Rc<Vec<crate::viewer::Item>> = Rc::new(pictures.iter().map(item_of).collect());
    let tiles: Vec<AnyElement> = pictures
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let all = all.clone();
            let here = p.local.is_some();
            let open: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |window, cx| {
                if !here {
                    crate::viewer::open((*all).clone(), i, window, cx);
                }
            });
            if kind_of(&p.kind, &p.name) == FileKind::Video {
                return crate::media::video_tile(&p.route, &p.kind, &p.name, u(if any_video { tall } else { high }), open, menu_of(p), window, cx);
            }
            let fm = menu_of(p);
            let id = SharedString::from(format!("{key}.pic{i}"));
            let focus = crate::said::focus_for(id.clone(), window, cx);
            // The hairline is drawn over the picture's edge, as the video's is.
            crate::said::keyed(div().id(id), &focus, radius, l, window)
                .flex_none()
                .h(h)
                .overflow_hidden()
                .on_click(move |_, window, cx| open(window, cx))
                .on_mouse_down(MouseButton::Right, move |_, window, cx| fm(window, cx))
                .child(picture(p, h, l.z(max_w), gpui::ObjectFit::Cover, radius, l, window, cx))
                .child(div().absolute().inset_0().rounded(radius).border_1().border_color(l.line1))
                .into_any_element()
        })
        .collect();
    let over = scroll.max_offset().x > px(0.);
    div()
        .flex()
        .flex_col()
        .max_w_full()
        .min_w_0()
        .gap(u(4.))
        .map(|d| if right { d.items_end().self_end() } else { d.items_start().self_start() })
        .child(crate::follow::across(div().id(SharedString::from(format!("{key}.row"))).max_w_full().min_w_0(), scroll).on_scroll(crate::app::sideways(Some(scroll.clone()))).child(div().flex().gap(u(6.)).children(tiles)))
        .when(over, |d| d.child(div().text_size(u(11.)).line_height(u(14.)).font_features(crate::chat_marks::tabular()).text_color(l.ink3).child(count_of(pictures))))
        .into_any_element()
}

/// One file, drawn as what it is.
fn attached_file(f: &Shown, size: Size, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let (max, _) = wide(size, l);
    match kind_of(&f.kind, &f.name) {
        FileKind::Image => {
            // `h-60 max-w-full` in a chat, `h-24 max-w-60` in an ask.
            let h = l.z(if size == Size::Chat { 240. } else { 96. });
            let (one, fm, here) = (item_of(f), menu_of(f), f.local.is_some());
            let id = SharedString::from(format!("{key}.img.{}", f.route));
            let focus = crate::said::focus_for(id.clone(), window, cx);
            let pic = crate::said::keyed(div().id(id), &focus, l.z(18.), l, window)
                .flex_none()
                .max_w_full()
                .overflow_hidden()
                .on_click(move |_, window, cx| {
                    if !here {
                        crate::viewer::open(vec![one.clone()], 0, window, cx);
                    }
                })
                .on_mouse_down(MouseButton::Right, move |_, window, cx| fm(window, cx))
                .child(picture(f, h, if size == Size::Chat { max.unwrap_or(l.z(420.)) } else { l.z(240.) }, gpui::ObjectFit::Contain, l.z(18.), l, window, cx));
            capped(pic, size, l).into_any_element()
        }
        FileKind::Video => picture_row(std::slice::from_ref(f), size, false, key, scroll, l, window, cx),
        FileKind::Audio => crate::media::audio_player(&f.route, &f.kind, &f.name, menu_of(f), window, cx),
        // A model being sent whose bytes aren't linked yet is its name until they are.
        FileKind::Model if f.route.starts_with("own:") => file_line(f, true, size, key, l, window, cx),
        FileKind::Model => {
            let fm = menu_of(f);
            let frame = div()
                .id(SharedString::from(format!("{key}.model.{}", f.route)))
                .max_w_full()
                .overflow_hidden()
                .rounded(u(18.))
                .border_1()
                .border_color(l.line1)
                .on_mouse_down(MouseButton::Right, move |_, window, cx| fm(window, cx))
                .child(model_view(f.route.split('?').next().unwrap_or(&f.route), &f.name, if size == Size::Chat { ModelSize::Chat } else { ModelSize::Ask }, window, cx))
                .child(file_line(f, false, size, key, l, window, cx));
            capped(frame, size, l).into_any_element()
        }
        FileKind::File => file_line(f, true, size, key, l, window, cx),
    }
}

/// A message's or an ask's files: its pictures and videos as a gallery, then the rest as they are.
pub fn files(files: &[Shown], size: Size, right: bool, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    let media = row_of(files);
    let mut out = vec![];
    if !media.is_empty() {
        out.push(picture_row(&media, size, right, key, scroll, l, window, cx));
    }
    for f in files.iter().filter(|f| !media.iter().any(|m| m.route == f.route)) {
        out.push(attached_file(f, size, key, scroll, l, window, cx));
    }
    out
}

/// A message's files: `under` a bubble, a gallery keeps the space that sets two messages apart.
pub fn attached(list: &[Attachment], right: bool, under: bool, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let shown: Vec<Shown> = list.iter().map(shown_of).collect();
    let gallery = !row_of(&shown).is_empty();
    div()
        .flex()
        .flex_col()
        .max_w_full()
        .gap(u(6.))
        .map(|d| if right { d.items_end().self_end() } else { d.items_start().self_start() })
        .when(under && gallery, |d| d.pt(u(12.)))
        .children(files(&shown, Size::Chat, right, key, scroll, l, window, cx))
        .into_any_element()
}

/// A message's files while it's being sent, drawn from their bytes here as its own will be once it's
/// in, so it takes their place as it is.
pub fn sending(list: &[crate::outbox::KeptFile], under: bool, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let shown: Vec<Shown> = list.iter().map(shown_kept).collect();
    let gallery = !row_of(&shown).is_empty();
    div()
        .flex()
        .flex_col()
        .max_w_full()
        .gap(u(6.))
        .items_end()
        .self_end()
        .when(under && gallery, |d| d.pt(u(12.)))
        .children(files(&shown, Size::Chat, true, key, scroll, l, window, cx))
        .into_any_element()
}
