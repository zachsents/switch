//! Pictures, videos and 3D files full screen: the app's own Quick Look. A click on one where it shows
//! (a message's, an ask's, a picture in an agent's words, a widget's gallery) opens this over the
//! whole screen the app is on, at once, with gpui's simple full screen (no space of its own, no
//! animation). On black, a picture fits the screen; a pinch, or the wheel with ⌘ held, zooms it about
//! the pointer, a double click goes between fitting and its own size (a pixel of it to a pixel of the
//! screen), and once it's bigger than the screen a drag or the wheel moves it. A video plays from
//! where it is, its keys along the bottom, a click on it playing or pausing it. A 3D file turns as it
//! does in a chat, and the wheel zooms it too. ← and → go through what it was opened with (a
//! message's pictures and videos), Space plays or pauses a video, and Esc or a click on the black
//! closes it. One is open at a time: opening another shows that one in it.

use std::sync::Arc;

use gpui::{
    App, AppContext, Bounds, Context, Entity, FocusHandle, Global, ImageSource, InteractiveElement, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ObjectFit, ParentElement, PinchEvent, Pixels, Point, Render,
    RenderImage, ScrollEvent, Size, Styled, StyledImage, Subscription, Window, WindowBounds,
    WindowHandle, WindowOptions, div, img, point, prelude::*, px, size, surface,
};

use crate::attached::{FileKind, kind_of};
use crate::look::{Look, SANS, u};
use crate::media::{self, Player};
use crate::model3d::{self, ModelView};
use crate::pictures::{DISPLAY, Pictures, format_of};
use crate::widgets::media::WebPictures;

/// A file to show: where it's served (a core route, or an address), its name and type, and its blob
/// when it's the core's.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub route: String,
    pub name: String,
    pub kind: String,
    pub blob: Option<String>,
}

/// A picture is decoded at most this on its longest side: its own size, for all but the biggest.
const FULL: u32 = 4096;
/// The black kept round a picture or a video fitting the screen.
const MARGIN: f32 = 40.;
/// How far a picture zooms in, at most, past its own size.
const DEEPEST: f32 = 8.;
/// How far a press moves before it's a drag rather than a click.
const SLOP: f32 = 4.;

struct Showing(WindowHandle<Viewer>);
impl Global for Showing {}

/// Opens `items` full screen at the one numbered `at`, on the screen `window` is on.
pub fn open(items: Vec<Item>, at: usize, window: &mut Window, cx: &mut App) {
    if let Some(Showing(open)) = cx.try_global::<Showing>() {
        let (open, again) = (*open, items.clone());
        if open.update(cx, move |v, window, cx| {
            v.show(again, at, cx);
            window.activate_window();
        })
        .is_ok()
        {
            return;
        }
    }
    let display = window.display(cx);
    let bounds = display.as_ref().map(|d| d.bounds()).unwrap_or_else(|| window.bounds());
    let made = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            display_id: display.map(|d| d.id()),
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            ..Default::default()
        },
        move |window, cx| {
            crate::platform::appkit::still(window);
            window.toggle_simple_fullscreen();
            cx.new(|cx| Viewer::new(items, at, window, cx))
        },
    );
    if let Ok(h) = made {
        cx.set_global(Showing(h));
    }
}

/// The viewer's window, while it's open.
#[cfg(feature = "shot")]
pub fn handle(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<Showing>().map(|s| s.0.into())
}

/// Where the picture was last drawn: the room it fits in, its own size in pixels, and its box.
#[derive(Clone, Copy)]
struct Laid {
    area: Bounds<Pixels>,
    natural: Size<f32>,
    rect: Bounds<Pixels>,
}

/// A press on the screen: where, where the picture was then, whether it's moved enough to be a
/// drag, and whether it was on the picture.
struct Press {
    from: Point<Pixels>,
    pan: Point<Pixels>,
    moved: bool,
    on_it: bool,
}

pub struct Viewer {
    items: Vec<Item>,
    at: usize,
    /// How far it's zoomed from fitting the screen (1 fits), and how far its centre is moved.
    zoom: f32,
    pan: Point<Pixels>,
    laid: Option<Laid>,
    press: Option<Press>,
    focus: FocusHandle,
    model: Option<Entity<ModelView>>,
    video: Option<(Entity<Player>, Subscription)>,
    _pictures: [Subscription; 2],
}

impl Viewer {
    fn new(items: Vec<Item>, at: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let (core, web) = (Pictures::entity(cx), WebPictures::entity(cx));
        let pictures = [cx.observe(&core, |_, _, cx| cx.notify()), cx.observe(&web, |_, _, cx| cx.notify())];
        let mut v = Viewer { items, at, zoom: 1., pan: Point::default(), laid: None, press: None, focus, model: None, video: None, _pictures: pictures };
        v.enter(cx);
        v
    }

    fn kind(&self) -> FileKind {
        let i = &self.items[self.at];
        kind_of(&i.kind, &i.name)
    }

    /// Shows what's at `at`: a video plays, a 3D file is made live.
    fn enter(&mut self, cx: &mut Context<Self>) {
        let i = self.items[self.at].clone();
        match self.kind() {
            FileKind::Video => {
                self.video = media::video(&i.route, &i.kind, &i.name, cx).map(|p| {
                    p.update(cx, |p, cx| p.play(cx));
                    let watch = cx.observe(&p, |_, _, cx| cx.notify());
                    (p, watch)
                });
            }
            FileKind::Model => self.model = Some(model3d::full_view(i.route.split('?').next().unwrap_or(&i.route), &i.name, cx)),
            _ => {}
        }
        cx.notify();
    }

    /// Leaves what's shown: a video stops where it is.
    fn leave(&mut self, cx: &mut Context<Self>) {
        if let Some((p, _)) = self.video.take() {
            p.update(cx, |p, cx| p.pause(cx));
        }
        self.model = None;
        self.zoom = 1.;
        self.pan = Point::default();
        self.laid = None;
        self.press = None;
    }

    fn show(&mut self, items: Vec<Item>, at: usize, cx: &mut Context<Self>) {
        self.leave(cx);
        self.items = items;
        self.at = at;
        self.enter(cx);
    }

    fn go(&mut self, by: isize, cx: &mut Context<Self>) {
        let to = self.at as isize + by;
        if to < 0 || to as usize >= self.items.len() {
            return;
        }
        self.leave(cx);
        self.at = to as usize;
        self.enter(cx);
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.leave(cx);
        window.remove_window();
    }

    /// Its own size, as a zoom: a pixel of it to a pixel of the screen.
    fn actual(laid: &Laid, window: &Window) -> f32 {
        let fit = (f32::from(laid.area.size.width) / laid.natural.width).min(f32::from(laid.area.size.height) / laid.natural.height);
        1. / (window.scale_factor() * fit)
    }

    /// Moves the picture no further than to bring its edge to the screen's.
    fn clamp(&mut self) {
        let Some(laid) = self.laid else { return };
        let fit = (f32::from(laid.area.size.width) / laid.natural.width).min(f32::from(laid.area.size.height) / laid.natural.height);
        let (w, h) = (laid.natural.width * fit * self.zoom, laid.natural.height * fit * self.zoom);
        let ox = ((w - f32::from(laid.area.size.width)) / 2.).max(0.);
        let oy = ((h - f32::from(laid.area.size.height)) / 2.).max(0.);
        self.pan = point(px(f32::from(self.pan.x).clamp(-ox, ox)), px(f32::from(self.pan.y).clamp(-oy, oy)));
    }

    /// Zooms a picture to `to`, the point under `at` staying under it.
    fn zoom_to(&mut self, to: f32, at: Point<Pixels>, window: &Window, cx: &mut Context<Self>) {
        let Some(laid) = self.laid.filter(|_| self.kind() == FileKind::Image) else { return };
        let actual = Self::actual(&laid, window);
        let to = to.clamp(actual.min(1.), DEEPEST * actual.max(1.));
        let centre = laid.area.center() + self.pan;
        let k = to / self.zoom;
        self.pan = at - (at - centre) * k - laid.area.center();
        self.zoom = to;
        self.clamp();
        cx.notify();
    }

    fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match e.keystroke.key.as_str() {
            "escape" => self.close(window, cx),
            "left" => self.go(-1, cx),
            "right" => self.go(1, cx),
            "space" => {
                if let Some((p, _)) = &self.video {
                    p.update(cx, |p, cx| p.toggle(cx));
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let on_it = self.kind() == FileKind::Model || self.laid.is_some_and(|l| l.rect.contains(&e.position));
        if e.click_count == 2 && on_it && self.kind() == FileKind::Image {
            if let Some(laid) = self.laid {
                let to = if (self.zoom - 1.).abs() < 0.01 { Self::actual(&laid, window) } else { 1. };
                self.zoom_to(to, e.position, window, cx);
            }
            return;
        }
        self.press = Some(Press { from: e.position, pan: self.pan, moved: false, on_it });
    }

    fn moved(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) {
        if e.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some(press) = &mut self.press else { return };
        let by = e.position - press.from;
        if !press.moved && f32::from(by.x).hypot(f32::from(by.y)) < SLOP {
            return;
        }
        press.moved = true;
        self.pan = press.pan + by;
        self.clamp();
        cx.notify();
    }

    fn up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(press) = self.press.take() else { return };
        if press.moved {
            return;
        }
        if !press.on_it {
            self.close(window, cx);
        } else if let Some((p, _)) = &self.video {
            p.update(cx, |p, cx| p.toggle(cx));
        }
    }

    fn wheel(&mut self, e: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        let d = e.delta.pixel_delta(window.line_height());
        if e.modifiers.platform {
            self.zoom_to(self.zoom * (f32::from(d.y) * 0.01).exp(), e.position, window, cx);
        } else if self.zoom > 1. {
            self.pan = self.pan + d;
            self.clamp();
            cx.notify();
        }
    }

    /// The picture at `item`: full size once it's decoded, the chat's size until then.
    fn picture(item: &Item, window: &mut Window, cx: &mut App) -> Option<Arc<RenderImage>> {
        let source = match &item.blob {
            Some(b) => {
                let format = format_of(&item.kind, &item.name);
                Pictures::sized(b, format, FULL, cx).or_else(|| Pictures::sized(b, format, DISPLAY, cx))?
            }
            None => ImageSource::Image(WebPictures::get(&item.route, cx)?),
        };
        match source {
            ImageSource::Render(r) => Some(r),
            ImageSource::Image(i) => i.use_render_image(window, cx),
            _ => None,
        }
    }

    /// Lays out a picture or a video of `natural` size in the room there is, as zoomed and moved.
    fn lay(&mut self, natural: Size<f32>, area: Bounds<Pixels>) -> Bounds<Pixels> {
        let fit = (f32::from(area.size.width) / natural.width).min(f32::from(area.size.height) / natural.height) * self.zoom;
        let rect = Bounds::centered_at(area.center() + self.pan, size(px(natural.width * fit), px(natural.height * fit)));
        self.laid = Some(Laid { area, natural, rect });
        rect
    }
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let screen = window.viewport_size();
        let margin = px(MARGIN);
        let item = self.items[self.at].clone();
        let kind = self.kind();
        let zoomed = kind == FileKind::Image && self.zoom > 1.;
        let base = div()
            .id("viewer")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(l.black)
            .font_family(SANS)
            .text_color(l.white)
            .when(zoomed, |d| if self.press.as_ref().is_some_and(|p| p.moved) { d.cursor_grabbing() } else { d.cursor_grab() })
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::down))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| this.moved(e, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, window, cx| this.up(window, cx)))
            .on_pinch(cx.listener(|this, e: &PinchEvent, window, cx| this.zoom_to(this.zoom * (1. + e.delta), e.position, window, cx)))
            .on_scroll(cx.listener(Self::wheel));
        match kind {
            FileKind::Image => {
                let area = Bounds::new(point(margin, margin), size(screen.width - margin * 2., screen.height - margin * 2.));
                match Self::picture(&item, window, cx) {
                    Some(r) => {
                        let s = r.size(0);
                        let rect = self.lay(size(s.width.0 as f32, s.height.0 as f32), area);
                        base.child(img(ImageSource::Render(r)).absolute().left(rect.origin.x).top(rect.origin.y).w(rect.size.width).h(rect.size.height).object_fit(ObjectFit::Fill))
                    }
                    None => {
                        self.laid = None;
                        let failed = match &item.blob {
                            Some(b) => Pictures::failed(b, cx),
                            None => WebPictures::failed(&item.route, cx),
                        };
                        base.when(failed, |d| d.flex().items_center().justify_center().child(item.name.clone()))
                    }
                }
            }
            FileKind::Video => {
                let bar = u(40.).to_pixels(window.rem_size());
                let area = Bounds::new(point(margin, margin), size(screen.width - margin * 2., screen.height - margin * 3. - bar));
                let Some(player) = self.video.as_ref().map(|(p, _)| p.clone()) else { return base };
                Player::draw(&player, window, cx);
                let (frame, natural) = player.read(cx).frame();
                let (w, h) = natural.unwrap_or((16., 9.));
                let rect = self.lay(size(w, h), area);
                let keys = media::controls(&player, &l, window, cx);
                base.children(frame.map(|f| surface(f).absolute().left(rect.origin.x).top(rect.origin.y).w(rect.size.width).h(rect.size.height).object_fit(ObjectFit::Fill)))
                    .child(
                        div()
                            .id("keys")
                            .absolute()
                            .bottom(margin)
                            .left((screen.width - px(640.).min(screen.width - margin * 2.)) / 2.)
                            .w(px(640.).min(screen.width - margin * 2.))
                            .h(bar)
                            .flex()
                            .items_center()
                            .gap(u(10.))
                            .px(u(12.))
                            .rounded(u(18.))
                            .border_1()
                            .border_color(l.line1)
                            .bg(l.bg)
                            .text_color(l.ink)
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .children(keys),
                    )
            }
            FileKind::Model => {
                self.laid = None;
                base.children(self.model.clone())
            }
            _ => base,
        }
    }
}
