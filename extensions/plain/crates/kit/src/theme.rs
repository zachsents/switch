use gpui::{App, Global, Hsla, Pixels, WindowAppearance, black, px, rgb, white};

/// The suite's only color palette. Apps never pick their own colors. Backgrounds are pure
/// black or white and every gray is a true neutral (equal RGB), so nothing reads as tinted.
#[derive(Clone, Copy)]
pub struct Theme {
    pub background: Hsla,
    pub surface: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub text_muted: Hsla,
    pub text_faint: Hsla,
    /// The edge of a text field, which is recessed into the surface.
    pub field_border: Hsla,
    /// Behind selected text.
    pub selection: Hsla,
    pub button: ButtonColors,
    pub button_primary: ButtonColors,
}

/// A physical-looking button: a nearly flat face with a bevel around its edges, standing on a
/// short ledge of shadow.
#[derive(Clone, Copy)]
pub struct ButtonColors {
    /// The face shades only faintly from `top` to `bottom`; the bevel does the modelling.
    pub top: Hsla,
    pub bottom: Hsla,
    pub border: Hsla,
    /// The bevel's lit edges, along the top and left, where light catches a raised surface.
    pub light: Hsla,
    /// The bevel's shaded edges, along the bottom and right. Pressed, the shade moves to the top.
    pub shade: Hsla,
    /// What the button casts on the surface below it.
    pub shadow: Hsla,
    pub text: Hsla,
}

impl Global for Theme {}

impl Theme {
    pub fn light() -> Self {
        Self {
            background: rgb(0xffffff).into(),
            surface: rgb(0xf2f2f2).into(),
            border: rgb(0xe5e5e5).into(),
            text: black(),
            text_muted: rgb(0x737373).into(),
            text_faint: rgb(0xa3a3a3).into(),
            field_border: rgb(0xa3a3a3).into(),
            selection: black().opacity(0.15),
            button: ButtonColors {
                top: rgb(0xf0f0f0).into(),
                bottom: rgb(0xe6e6e6).into(),
                border: rgb(0xa3a3a3).into(),
                light: white(),
                shade: black().opacity(0.24),
                shadow: black().opacity(0.25),
                text: black(),
            },
            button_primary: ButtonColors {
                top: rgb(0x3d3d3d).into(),
                bottom: rgb(0x2b2b2b).into(),
                border: black(),
                light: white().opacity(0.35),
                shade: black().opacity(0.6),
                shadow: black().opacity(0.35),
                text: white(),
            },
        }
    }

    pub fn dark() -> Self {
        Self {
            background: black(),
            surface: rgb(0x1a1a1a).into(),
            border: rgb(0x262626).into(),
            text: white(),
            text_muted: rgb(0xa3a3a3).into(),
            text_faint: rgb(0x666666).into(),
            field_border: rgb(0x4d4d4d).into(),
            selection: white().opacity(0.25),
            button: ButtonColors {
                top: rgb(0x3d3d3d).into(),
                bottom: rgb(0x333333).into(),
                border: rgb(0x050505).into(),
                light: white().opacity(0.25),
                shade: black().opacity(0.6),
                shadow: black(),
                text: white(),
            },
            button_primary: ButtonColors {
                top: rgb(0xf0f0f0).into(),
                bottom: rgb(0xdcdcdc).into(),
                border: rgb(0x050505).into(),
                light: white(),
                shade: black().opacity(0.28),
                shadow: black(),
                text: black(),
            },
        }
    }

    pub fn for_appearance(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::light(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::dark(),
        }
    }

    /// Installs the theme matching the system appearance as a global.
    pub fn init(cx: &mut App) {
        cx.set_global(Self::for_appearance(cx.window_appearance()));
    }
}

/// Typography. One family, the platform UI font (SF Pro on macOS), and a compact scale:
/// 13px body matches native macOS controls.
pub mod text {
    use super::*;

    pub const FONT: &str = ".SystemUIFont";
    pub const SMALL: Pixels = px(11.);
    pub const BODY: Pixels = px(13.);
    pub const TITLE: Pixels = px(24.);
    pub const DISPLAY: Pixels = px(44.);
}

/// Gives any context access to the active theme.
pub trait ActiveTheme {
    fn theme(&self) -> &Theme;
}

impl ActiveTheme for App {
    fn theme(&self) -> &Theme {
        self.global::<Theme>()
    }
}
