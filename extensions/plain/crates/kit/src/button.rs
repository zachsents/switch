use std::time::{Duration, Instant};

use gpui::{
    Action, App, BoxShadow, ElementId, Global, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled, Window, div, linear_color_stop, linear_gradient, prelude::*, px,
};

use crate::{
    ActiveTheme, ButtonColors, Icon, icon,
    keys::{keycaps, shortcut_keys},
    text,
};

/// How long a button stays pressed after its shortcut is used.
pub(crate) const KEY_PRESS_DURATION: Duration = Duration::from_millis(120);

/// The action most recently triggered from the keyboard. Buttons for it render pressed briefly,
/// so a shortcut gives the same feedback as a click.
pub(crate) struct KeyPress {
    pub action: &'static str,
    pub at: Instant,
}

impl Global for KeyPress {}

#[derive(Clone, Copy, Default)]
pub enum ButtonVariant {
    Primary,
    #[default]
    Secondary,
}

/// A button that dispatches an action instead of running a closure, so every click has a
/// keyboard, menu and agent equivalent. It shows the action's shortcut automatically.
#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: SharedString,
    action: Box<dyn Action>,
    icon: Option<Icon>,
    variant: ButtonVariant,
    disabled: bool,
    pressed: bool,
    grow: bool,
}

impl Button {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        action: impl Action,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            action: action.boxed_clone(),
            icon: None,
            variant: ButtonVariant::default(),
            disabled: false,
            pressed: false,
            grow: false,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Shows the button held down, like a toggle that is on.
    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    /// Takes an equal share of a flex row, whatever its content, so siblings never reflow.
    pub fn grow(mut self) -> Self {
        self.grow = true;
        self
    }
}

/// The face of a raised button, or of a sunken one while pressed. Raised: the face is nearly
/// flat, a bevel lights its top and left edges and shades its bottom and right, and a short
/// ledge of shadow stands it off the surface. Pressed: the bevel turns over, shading the top
/// inside edge, and a lip of light below makes it look set into the surface.
fn surface<T: Styled>(this: T, colors: ButtonColors, pressed: bool) -> T {
    let (top, bottom, shadows) = if pressed {
        (
            colors.bottom,
            colors.bottom,
            vec![
                BoxShadow::new(px(0.), px(3.), colors.shade)
                    .blur_radius(px(4.))
                    .inset(),
                BoxShadow::new(px(0.), px(1.), colors.shade).inset(),
                BoxShadow::new(px(0.), px(-1.), colors.light.opacity(0.3)).inset(),
                BoxShadow::new(px(0.), px(1.), colors.light.opacity(0.5)),
            ],
        )
    } else {
        (
            colors.top,
            colors.bottom,
            vec![
                // The bevel: a crisp lit edge and a softer band inside it at the top, the same
                // in shade at the bottom, and fainter edges at the sides.
                BoxShadow::new(px(0.), px(1.), colors.light).inset(),
                BoxShadow::new(px(0.), px(3.), colors.light.opacity(0.35))
                    .blur_radius(px(2.))
                    .inset(),
                BoxShadow::new(px(1.), px(0.), colors.light.opacity(0.6)).inset(),
                BoxShadow::new(px(-1.), px(0.), colors.shade.opacity(0.7)).inset(),
                BoxShadow::new(px(0.), px(-1.), colors.shade).inset(),
                BoxShadow::new(px(0.), px(-3.), colors.shade.opacity(0.5))
                    .blur_radius(px(2.))
                    .inset(),
                // The ledge it stands on.
                BoxShadow::new(px(0.), px(1.), colors.shadow),
                BoxShadow::new(px(0.), px(3.), colors.shadow.opacity(0.4)).blur_radius(px(4.)),
            ],
        )
    };
    this.bg(linear_gradient(
        180.,
        linear_color_stop(top, 0.),
        linear_color_stop(bottom, 1.),
    ))
    .border_color(colors.border)
    .shadow(shadows)
}

/// Every control that triggers an action must have a keyboard shortcut for it.
pub(crate) fn assert_has_shortcut(action: &dyn Action, cx: &App) {
    debug_assert!(
        cx.key_bindings()
            .borrow()
            .bindings_for_action(action)
            .next()
            .is_some(),
        "every button needs a keyboard shortcut, but `{}` has none",
        action.name()
    );
}

/// Whether the action's shortcut was just used, so its control should show pressed.
pub(crate) fn pressed_by_key(action: &dyn Action, cx: &App) -> bool {
    cx.try_global::<KeyPress>().is_some_and(|press| {
        press.action == action.name() && press.at.elapsed() < KEY_PRESS_DURATION
    })
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        assert_has_shortcut(self.action.as_ref(), cx);
        let colors = match self.variant {
            ButtonVariant::Primary => cx.theme().button_primary,
            ButtonVariant::Secondary => cx.theme().button,
        };
        let shortcut = shortcut_keys(window, self.action.as_ref());
        let pressed = !self.disabled && (self.pressed || pressed_by_key(self.action.as_ref(), cx));
        let action = self.action;

        div()
            .id(self.id)
            .h(px(28.))
            .px(px(10.))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded(px(6.))
            .border_1()
            .map(|this| surface(this, colors, pressed))
            .when(pressed, |this| this.pt(px(1.)))
            .text_color(colors.text)
            .text_size(text::BODY)
            .when(self.grow, |this| {
                this.flex_1().min_w(px(0.)).overflow_hidden()
            })
            .when_some(self.icon, |this, name| {
                this.child(icon(name).text_color(colors.text))
            })
            .child(self.label)
            .when_some(shortcut, |this, keys| this.child(keycaps(keys, colors)))
            .map(|this| {
                if self.disabled {
                    this.opacity(0.4)
                } else {
                    this.cursor_pointer()
                        .active(|style| surface(style, colors, true).pt(px(1.)))
                        .on_click(move |_, window, cx| {
                            window.dispatch_action(action.boxed_clone(), cx)
                        })
                }
            })
    }
}

/// A row of joined buttons that chooses one of several options, like a file format. Each option
/// is its own action with its own shortcut, and the chosen one stays pressed in.
#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    options: Vec<(SharedString, Box<dyn Action>)>,
    chosen: Option<usize>,
}

impl Segmented {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            options: Vec::new(),
            chosen: None,
        }
    }

    pub fn option(mut self, label: impl Into<SharedString>, action: impl Action) -> Self {
        self.options.push((label.into(), action.boxed_clone()));
        self
    }

    /// Which option is chosen, if any. None of them is when the current value is one the
    /// options don't cover.
    pub fn chosen(mut self, index: Option<usize>) -> Self {
        self.chosen = index;
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let last = self.options.len().saturating_sub(1);
        let chosen = self.chosen;
        let segments = self
            .options
            .into_iter()
            .enumerate()
            .map(|(index, (label, action))| {
                assert_has_shortcut(action.as_ref(), cx);
                let pressed = chosen == Some(index) || pressed_by_key(action.as_ref(), cx);
                // The chosen option is in the primary material as well as pressed in, so which
                // one is chosen reads at a glance.
                let colors = if chosen == Some(index) {
                    theme.button_primary
                } else {
                    theme.button
                };
                let (left, right) = (index == 0, index == last);
                let shortcut = shortcut_keys(window, action.as_ref());
                div()
                    .id(index)
                    .flex_1()
                    .min_w(px(0.))
                    .h(px(28.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(6.))
                    .border_1()
                    .when(!left, |this| this.border_l_0())
                    .when(left, |this| this.rounded_l(px(6.)))
                    .when(right, |this| this.rounded_r(px(6.)))
                    .map(|this| surface(this, colors, pressed))
                    .when(pressed, |this| this.pt(px(1.)))
                    .text_color(colors.text)
                    .text_size(text::BODY)
                    .child(div().truncate().child(label))
                    .when_some(shortcut, |this, keys| this.child(keycaps(keys, colors)))
                    .cursor_pointer()
                    .active(|style| surface(style, colors, true).pt(px(1.)))
                    .on_click(move |_, window, cx| window.dispatch_action(action.boxed_clone(), cx))
            })
            .collect::<Vec<_>>();
        div().id(self.id).flex().w_full().children(segments)
    }
}
