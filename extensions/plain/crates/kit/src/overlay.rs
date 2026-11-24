//! What the kit draws over a window's content: the tooltip of the control under the pointer,
//! centered under it, and while ⌘ is held, the shortcuts of controls that don't show their own.
//!
//! Controls ask for these with [`tip`] as they're laid out. One overlay in each window's root
//! takes the frame's requests afterwards and places them together, so revealed shortcuts never
//! cover each other.

use std::{collections::HashMap, panic::Location, time::Duration};

use gpui::{
    Action, AnyElement, App, AvailableSpace, Bounds, BoxShadow, Element, ElementId, Global,
    GlobalElementId, InspectorElementId, IntoElement, LayoutId, ModifiersChangedEvent,
    ParentElement, Pixels, Point, Position, SharedString, Size, Style, Styled, Window, WindowId,
    black, canvas, div, point, prelude::*, px,
};

use crate::{
    ActiveTheme, Theme,
    keys::{keycaps, shortcut_keys},
    text,
};

/// How long ⌘ is held alone before shortcuts show, so pressing one like ⌘Z doesn't flash them.
const HOLD: Duration = Duration::from_millis(300);
/// The space between a control and its tooltip.
const TOOLTIP_GAP: Pixels = px(6.);
/// The space between a control and its revealed shortcut, and between rows of shortcuts.
const KEYS_GAP: Pixels = px(2.);
/// The least space between a tip and the window's edge.
const MARGIN: Pixels = px(4.);

/// What a control asks to show under itself.
pub(crate) enum Tip {
    /// Its name and shortcut, while it's hovered.
    Tooltip {
        label: SharedString,
        keys: Option<Vec<SharedString>>,
    },
    /// Its shortcut, while ⌘ is held. Dimmed when the control is disabled.
    Keys {
        keys: Vec<SharedString>,
        dimmed: bool,
    },
}

/// The tips asked for in the frame being drawn, by window, with the bounds of the control each
/// is for.
#[derive(Default)]
struct Requests(HashMap<WindowId, Vec<(Bounds<Pixels>, Tip)>>);

impl Global for Requests {}

/// Shows `tip` under the element this is added to, for this frame. The element must be
/// `relative`, since this fills it to learn where it is.
pub(crate) fn tip(tip: Tip) -> impl IntoElement {
    canvas(
        move |bounds, window, cx| {
            let window = window.window_handle().window_id();
            cx.default_global::<Requests>()
                .0
                .entry(window)
                .or_default()
                .push((bounds, tip));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A control's tooltip: its name, and its action's shortcut when it has one, centered under the
/// element this is added to. Add it while the pointer is over the element (follow that with
/// `on_hover`, or use [`crate::with_tooltip`]); the element must be `relative`. Every icon-only
/// control has one, shown the moment the pointer arrives; GPUI's own `.tooltip()` isn't used.
pub fn tooltip(
    label: impl Into<SharedString>,
    action: Option<&dyn Action>,
    window: &Window,
) -> impl IntoElement {
    tip(Tip::Tooltip {
        label: label.into(),
        keys: action.and_then(|action| shortcut_keys(window, action)),
    })
}

/// Gives an element with an id a tooltip: see [`tooltip`].
pub trait WithTooltip: StatefulInteractiveElement + ParentElement + Sized {
    /// Shows `label`, and `action`'s shortcut when it has one, centered under this element the
    /// moment the pointer is over it. The element must be `relative`, and this takes its
    /// `on_hover`.
    fn tip(
        mut self,
        label: impl Into<SharedString>,
        action: Option<&dyn Action>,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let Some(id) = self.interactivity().element_id.clone() else {
            return self;
        };
        let hovered = window.use_keyed_state(id, cx, |_, _| false);
        let shown = *hovered.read(cx) && !revealing(window, cx);
        self.interactivity().on_hover(move |hover, _, cx| {
            hovered.update(cx, |state, cx| {
                if *state != *hover {
                    *state = *hover;
                    cx.notify();
                }
            })
        });
        if shown {
            self.child(tooltip(label, action, window))
        } else {
            self
        }
    }
}

impl<E: StatefulInteractiveElement + ParentElement + Sized> WithTooltip for E {}

/// `child` with a tooltip, for where no window is at hand to add one with [`WithTooltip::tip`]:
/// it lays out as a `relative` box around `child` that shows the tooltip while hovered.
pub fn tipped(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    child: impl IntoElement,
) -> Tipped {
    Tipped {
        id: id.into(),
        label: label.into(),
        action: None,
        child: child.into_any_element(),
    }
}

/// See [`tipped`].
#[derive(IntoElement)]
pub struct Tipped {
    id: ElementId,
    label: SharedString,
    action: Option<Box<dyn Action>>,
    child: AnyElement,
}

impl Tipped {
    /// The action it runs, whose shortcut the tooltip shows.
    pub fn action(mut self, action: Box<dyn Action>) -> Self {
        self.action = Some(action);
        self
    }
}

impl RenderOnce for Tipped {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        div().id(self.id).relative().child(self.child).tip(
            self.label,
            self.action.as_deref(),
            window,
            cx,
        )
    }
}

/// While ⌘ is held, shows `action`'s shortcut under the element this is added to. For controls
/// that don't show their shortcut themselves, like a value that's clicked to edit it; kit
/// controls already do this. The element must be `relative`.
pub fn reveal_shortcut(action: &dyn Action, window: &Window, cx: &App) -> Option<impl IntoElement> {
    revealing(window, cx)
        .then(|| shortcut_keys(window, action))
        .flatten()
        .map(|keys| {
            tip(Tip::Keys {
                keys,
                dimmed: false,
            })
        })
}

/// Whether ⌘ is revealing shortcuts in a window. Holding ⌘ alone for a moment reveals them; a
/// shortcut used meanwhile hides them until ⌘ is let go, so using one doesn't flash them all.
#[derive(Default)]
struct Reveal {
    window: Option<WindowId>,
    phase: Phase,
    /// Counts presses of ⌘, so a timer from an earlier press can't reveal.
    press: usize,
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Phase {
    #[default]
    Idle,
    Waiting,
    Shown,
    /// A shortcut was used while ⌘ was held.
    Used,
}

impl Global for Reveal {}

/// Follows ⌘ going down and up in a window. Every window's root listens with this.
pub(crate) fn modifiers_changed(event: &ModifiersChangedEvent, window: &mut Window, cx: &mut App) {
    let handle = window.window_handle();
    let reveal = cx.default_global::<Reveal>();
    let holding = reveal.window == Some(handle.window_id()) && reveal.phase != Phase::Idle;
    if event.modifiers.platform && !holding {
        reveal.window = Some(handle.window_id());
        reveal.phase = Phase::Waiting;
        reveal.press += 1;
        let press = reveal.press;
        cx.spawn(async move |cx| {
            cx.background_executor().timer(HOLD).await;
            handle
                .update(cx, |_, window, cx| {
                    let reveal = cx.default_global::<Reveal>();
                    if reveal.press == press && reveal.phase == Phase::Waiting {
                        reveal.phase = Phase::Shown;
                        window.refresh();
                    }
                })
                .ok();
        })
        .detach();
    } else if !event.modifiers.platform && holding {
        let shown = reveal.phase == Phase::Shown;
        reveal.phase = Phase::Idle;
        if shown {
            window.refresh();
        }
    }
}

/// A key pressed while ⌘ is held hides revealed shortcuts until ⌘ is let go.
pub(crate) fn key_pressed(window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    let reveal = cx.default_global::<Reveal>();
    if reveal.window == Some(id) && matches!(reveal.phase, Phase::Waiting | Phase::Shown) {
        let shown = reveal.phase == Phase::Shown;
        reveal.phase = Phase::Used;
        if shown {
            window.refresh();
        }
    }
}

/// Whether controls in this window should show their shortcuts now.
pub(crate) fn revealing(window: &Window, cx: &App) -> bool {
    cx.try_global::<Reveal>().is_some_and(|reveal| {
        reveal.window == Some(window.window_handle().window_id()) && reveal.phase == Phase::Shown
    }) && window.modifiers().platform
        && window.is_window_active()
}

/// Lays out and draws the frame's tips over the window. Every window's root holds one, deferred
/// so it runs after the controls that ask for tips.
pub(crate) struct Overlay;

impl IntoElement for Overlay {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Overlay {
    type RequestLayoutState = ();
    type PrepaintState = Vec<AnyElement>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = Style {
            position: Position::Absolute,
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        let id = window.window_handle().window_id();
        let reveal = cx.default_global::<Reveal>();
        // ⌘ was let go while another app was in front.
        if reveal.window == Some(id) && !window.modifiers().platform {
            reveal.phase = Phase::Idle;
        }
        let theme = *cx.theme();
        let mut requests = cx
            .default_global::<Requests>()
            .0
            .remove(&id)
            .unwrap_or_default();
        requests.sort_by(|(a, _), (b, _)| {
            (a.top(), a.left())
                .partial_cmp(&(b.top(), b.left()))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let viewport = window.viewport_size();
        let laid_out: Vec<_> = requests
            .into_iter()
            .map(|(under, tip)| {
                let shortcut = matches!(tip, Tip::Keys { .. });
                let mut element = render(tip, &theme);
                let size = element.layout_as_root(AvailableSpace::min_size(), window, cx);
                (under, size, shortcut, element)
            })
            .collect();
        let shortcuts: Vec<_> = laid_out
            .iter()
            .filter(|(_, _, shortcut, _)| *shortcut)
            .map(|(under, size, _, _)| (*under, *size))
            .collect();
        let mut shortcut_origins = place_shortcuts(&shortcuts, viewport).into_iter();
        laid_out
            .into_iter()
            .map(|(under, size, shortcut, mut element)| {
                let origin = if shortcut {
                    shortcut_origins.next().unwrap_or_default()
                } else {
                    place_tooltip(under, size, viewport)
                };
                window.with_absolute_element_offset(origin, |window| element.prepaint(window, cx));
                element
            })
            .collect()
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        elements: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for element in elements {
            element.paint(window, cx);
        }
    }
}

/// A tip's look: a tooltip is a small panel with the control's name and keys, and a revealed
/// shortcut is just its keys.
fn render(tip: Tip, theme: &Theme) -> AnyElement {
    let base = div()
        .font_family(text::FONT)
        .text_size(text::SMALL)
        .whitespace_nowrap();
    match tip {
        Tip::Tooltip { label, keys } => base
            .px(px(8.))
            .py(px(4.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(6.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface)
            .shadow(vec![
                BoxShadow::new(px(0.), px(2.), black().opacity(0.12)).blur_radius(px(6.)),
            ])
            .text_color(theme.text)
            .child(label)
            .when_some(keys, |this, keys| {
                this.child(keycaps(keys, theme.button).pb(px(2.)))
            })
            .into_any_element(),
        Tip::Keys { keys, dimmed } => base
            .pb(px(2.))
            .child(keycaps(keys, theme.button))
            .when(dimmed, |this| this.opacity(0.5))
            .into_any_element(),
    }
}

/// The left edge that centers something `width` wide on `center`, kept inside the window.
fn centered_x(center: Pixels, width: Pixels, viewport: Size<Pixels>) -> Pixels {
    (center - width / 2.)
        .min(viewport.width - MARGIN - width)
        .max(MARGIN)
}

/// Where a tooltip of `size` goes: centered below the control at `under`, or above it when
/// there's no room below.
fn place_tooltip(
    under: Bounds<Pixels>,
    size: Size<Pixels>,
    viewport: Size<Pixels>,
) -> Point<Pixels> {
    let below = under.bottom() + TOOLTIP_GAP;
    let y = if below + size.height > viewport.height - MARGIN {
        under.top() - TOOLTIP_GAP - size.height
    } else {
        below
    };
    point(centered_x(under.center().x, size.width, viewport), y)
}

/// Where revealed shortcuts go, given each control's bounds and its shortcut's size, ordered
/// top to bottom and left to right: each is centered just below its control (above it when
/// there's no room below), inside the window, and moved a row further out at a time until it's
/// clear of the ones placed before it.
fn place_shortcuts(
    shortcuts: &[(Bounds<Pixels>, Size<Pixels>)],
    viewport: Size<Pixels>,
) -> Vec<Point<Pixels>> {
    shortcuts
        .iter()
        .fold(
            Vec::<Bounds<Pixels>>::new(),
            |mut placed, &(under, size)| {
                let x = centered_x(under.center().x, size.width, viewport);
                let below = under.bottom() + KEYS_GAP;
                let fits_below = below + size.height <= viewport.height - MARGIN;
                let row_y = |row: usize| {
                    let step = (size.height + KEYS_GAP) * row as f32;
                    if fits_below {
                        below + step
                    } else {
                        under.top() - KEYS_GAP - size.height - step
                    }
                };
                let clear = |y: Pixels| {
                    let bounds = Bounds::new(point(x, y), size);
                    !placed
                        .iter()
                        .any(|other| other.dilate(KEYS_GAP).intersects(&bounds))
                };
                let y = (0..).map(row_y).find(|&y| clear(y)).unwrap_or_default();
                placed.push(Bounds::new(point(x, y), size));
                placed
            },
        )
        .into_iter()
        .map(|bounds| bounds.origin)
        .collect()
}
