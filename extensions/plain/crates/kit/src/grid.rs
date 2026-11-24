//! A flat grid of commands, for toolbars and palettes: one strip ruled into cells by hairlines,
//! where each cell is a button. A row of raised buttons would be too much where there are many
//! commands side by side.

use gpui::{
    Action, AnyElement, App, ElementId, Hsla, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, Styled, Window, div, prelude::*, px,
};

use crate::{
    ActiveTheme, Icon,
    button::{assert_has_shortcut, pressed_by_key},
    icon,
    keys::shortcut_keys,
    overlay::{Tip, revealing, tip},
    text,
};

/// Each cell's height, the same as a button's.
const HEIGHT: Pixels = px(28.);
/// A cell holding an icon or a swatch is square.
const SQUARE: Pixels = px(32.);

/// A row of cells that are each a button. Hovering a cell shows its name and shortcut right
/// away, centered under it, and holding ⌘ shows every cell's shortcut. A cell that's on, like
/// the tool in use, is filled in.
#[derive(IntoElement)]
pub struct Grid {
    id: ElementId,
    cells: Vec<GridCell>,
    grow: bool,
}

/// One cell of a [`Grid`].
pub struct GridCell {
    face: Face,
    label: SharedString,
    action: Box<dyn Action>,
    on: bool,
    disabled: bool,
}

/// What a cell shows.
enum Face {
    Icon(Icon),
    Text(SharedString),
    /// A dot of color, for palettes.
    Swatch(Hsla),
    /// A line of this thickness, for choosing stroke widths.
    Line(Pixels),
}

impl GridCell {
    fn new(face: Face, label: impl Into<SharedString>, action: impl Action) -> Self {
        Self {
            face,
            label: label.into(),
            action: action.boxed_clone(),
            on: false,
            disabled: false,
        }
    }

    /// A square cell showing `icon`. `label` names it in its tooltip.
    pub fn icon(icon: Icon, label: impl Into<SharedString>, action: impl Action) -> Self {
        Self::new(Face::Icon(icon), label, action)
    }

    /// A cell showing its label.
    pub fn text(label: impl Into<SharedString>, action: impl Action) -> Self {
        let label = label.into();
        Self::new(Face::Text(label.clone()), label, action)
    }

    /// A square cell showing a dot of `color`.
    pub fn swatch(color: Hsla, label: impl Into<SharedString>, action: impl Action) -> Self {
        Self::new(Face::Swatch(color), label, action)
    }

    /// A square cell showing a line `thickness` points thick.
    pub fn line(thickness: Pixels, label: impl Into<SharedString>, action: impl Action) -> Self {
        Self::new(Face::Line(thickness), label, action)
    }

    /// Shows the cell filled in, like the tool in use or the chosen option.
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

impl Grid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            cells: Vec::new(),
            grow: false,
        }
    }

    pub fn cell(mut self, cell: GridCell) -> Self {
        self.cells.push(cell);
        self
    }

    pub fn cells(mut self, cells: impl IntoIterator<Item = GridCell>) -> Self {
        self.cells.extend(cells);
        self
    }

    /// Fills the width it's given, sharing it equally between the cells.
    pub fn grow(mut self) -> Self {
        self.grow = true;
        self
    }
}

impl RenderOnce for Grid {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let grow = self.grow;
        let revealing = revealing(window, cx);
        // Which cell the pointer is over, for its tooltip.
        let hovered = window.use_keyed_state(self.id.clone(), cx, |_, _| None::<usize>);
        let hovered_index = *hovered.read(cx);
        let cells = self
            .cells
            .into_iter()
            .enumerate()
            .map(|(index, cell)| {
                assert_has_shortcut(cell.action.as_ref(), cx);
                let keys = shortcut_keys(window, cell.action.as_ref());
                let on = cell.on || (!cell.disabled && pressed_by_key(cell.action.as_ref(), cx));
                // A cell that's on is inverted, so on and off can't be mistaken for each other.
                let ink = if on { theme.background } else { theme.text };
                let square = !matches!(cell.face, Face::Text(_));
                let face: AnyElement = match cell.face {
                    Face::Icon(name) => icon(name).text_color(ink).into_any_element(),
                    Face::Text(label) => div().truncate().child(label).into_any_element(),
                    Face::Swatch(color) => div()
                        .size(px(14.))
                        .rounded_full()
                        .border_1()
                        .border_color(theme.text.opacity(0.25))
                        .bg(color)
                        .into_any_element(),
                    Face::Line(thickness) => div()
                        .w(px(16.))
                        .h(thickness)
                        .rounded_full()
                        .bg(ink)
                        .into_any_element(),
                };
                let shown_tip = match (revealing, keys) {
                    (true, Some(keys)) => Some(Tip::Keys {
                        keys,
                        dimmed: cell.disabled,
                    }),
                    (true, None) => None,
                    (false, keys) => (hovered_index == Some(index)).then_some(Tip::Tooltip {
                        label: cell.label,
                        keys,
                    }),
                };
                let action = cell.action;
                let hovered = hovered.clone();
                div()
                    .id(index)
                    .relative()
                    .h(HEIGHT)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(ink)
                    .text_size(text::BODY)
                    .when(index > 0, |this| {
                        this.border_l_1().border_color(theme.border)
                    })
                    .map(|this| match (grow, square) {
                        (true, _) => this.flex_1().min_w(px(0.)).px(px(8.)),
                        (false, true) => this.w(SQUARE).flex_none(),
                        (false, false) => this.px(px(10.)).flex_none(),
                    })
                    .when(on, |this| this.bg(theme.text))
                    .child(face)
                    .on_hover(move |&now, _, cx| {
                        hovered.update(cx, |hovered, cx| {
                            if now {
                                *hovered = Some(index);
                            } else if *hovered == Some(index) {
                                *hovered = None;
                            }
                            cx.notify();
                        })
                    })
                    .children(shown_tip.map(tip))
                    .map(|this| {
                        if cell.disabled {
                            this.opacity(0.35)
                        } else {
                            this.cursor_pointer()
                                .when(!on, |this| this.hover(|style| style.bg(theme.surface)))
                                .active(|style| style.bg(theme.selection))
                                .on_click(move |_, window, cx| {
                                    window.dispatch_action(action.boxed_clone(), cx)
                                })
                        }
                    })
            })
            .collect::<Vec<_>>();
        div()
            .id(self.id)
            .flex()
            .flex_none()
            .when(grow, |this| this.flex_1().min_w(px(0.)))
            .rounded(px(6.))
            .border_1()
            .border_color(theme.border)
            .overflow_hidden()
            .children(cells)
    }
}
