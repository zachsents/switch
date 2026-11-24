//! Keyboard shortcuts as they're drawn: each key of a combination on its own small keycap, in
//! the order macOS lists them (⌃ ⌥ ⇧ ⌘, then the key).

use gpui::{
    Action, BoxShadow, Div, KeyBinding, KeybindingKeystroke, ParentElement, SharedString, Styled,
    Window, div, px,
};

use crate::{ButtonColors, text};

/// The keys of the action's shortcut, like `["⌘", "Enter"]`, read from the window's keymap.
pub(crate) fn shortcut_keys(window: &Window, action: &dyn Action) -> Option<Vec<SharedString>> {
    window
        .highest_precedence_binding_for_action(action)
        .map(|binding| binding_keys(&binding))
}

/// Every key a binding presses, in order. The keys of a sequence of keystrokes run together.
fn binding_keys(binding: &KeyBinding) -> Vec<SharedString> {
    binding
        .keystrokes()
        .iter()
        .flat_map(keystroke_keys)
        .collect()
}

/// One keystroke's modifiers, in Apple's order, then its key.
fn keystroke_keys(keystroke: &KeybindingKeystroke) -> Vec<SharedString> {
    let held = keystroke.modifiers();
    [
        (held.function, "fn"),
        (held.control, "⌃"),
        (held.alt, "⌥"),
        (held.shift, "⇧"),
        (held.platform, "⌘"),
    ]
    .into_iter()
    .filter(|(down, _)| *down)
    .map(|(_, glyph)| SharedString::from(glyph))
    .chain([key_label(keystroke.key())])
    .collect()
}

/// How a key is labeled on its keycap. GPUI names keys in lowercase ("enter", "pageup"), and
/// these are written the way macOS writes them: arrows and delete keys as symbols, other named
/// keys as words, and single characters in uppercase.
pub(crate) fn key_label(key: &str) -> SharedString {
    let label = match key {
        "enter" => "Enter",
        "space" => "Space",
        "tab" => "Tab",
        "escape" => "Esc",
        "backspace" => "⌫",
        "delete" => "⌦",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page Up",
        "pagedown" => "Page Down",
        "up" => "↑",
        "down" => "↓",
        "left" => "←",
        "right" => "→",
        "shift" => "⇧",
        "control" => "⌃",
        "alt" => "⌥",
        "platform" => "⌘",
        "function" => "fn",
        // Letters, digits, symbols and the function keys ("f5").
        key => {
            let mut chars = key.chars();
            return chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
                .into();
        }
    };
    label.into()
}

/// One key: a small cap of a button's material, with the same bevel, standing on a 2px skirt.
fn keycap(label: SharedString, colors: ButtonColors) -> Div {
    div()
        .flex_none()
        .h(px(16.))
        .min_w(px(16.))
        .px(px(4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .border_1()
        .border_color(colors.border)
        .bg(colors.top)
        .shadow(vec![
            BoxShadow::new(px(0.), px(1.), colors.light).inset(),
            BoxShadow::new(px(0.), px(-1.), colors.shade).inset(),
            BoxShadow::new(px(0.), px(2.), colors.border),
        ])
        .text_size(text::SMALL)
        .text_color(colors.text.opacity(0.65))
        .child(label)
}

/// A shortcut's keys side by side, each on its own keycap: ⌥⌘1 is three keys.
pub(crate) fn keycaps(keys: Vec<SharedString>, colors: ButtonColors) -> Div {
    div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(2.))
        .whitespace_nowrap()
        .children(keys.into_iter().map(|key| keycap(key, colors)))
}
