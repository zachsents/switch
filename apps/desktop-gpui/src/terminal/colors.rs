//! The terminal's colours from the app's Look: its background and ink for the screen's own, and
//! the sixteen ANSI colours as Tomorrow's hues (Tomorrow Night on a dark background, Tomorrow on a
//! light one), each moved toward the ink until it reads on this background; the 256-colour cube
//! and grey ramp as xterm has them. A program's own colours (OSC 4, 10, 11) win.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{Hsla, Rgba};

use crate::look::{Look, contrast, mix};

/// What every cell's colour is read from.
pub struct Palette {
    ansi: [u32; 16],
    pub fg: u32,
    pub bg: u32,
    pub dim_fg: u32,
}

fn hex_of(c: Hsla) -> u32 {
    let r = Rgba::from(c);
    let b = |v: f32| (v * 255.).round().clamp(0., 255.) as u32;
    (b(r.r) << 16) | (b(r.g) << 8) | b(r.b)
}

/// `c` moved toward `ink` until it has `least` contrast on `bg`.
fn reading(c: u32, ink: u32, bg: u32, least: f32) -> u32 {
    let mut t = 0.;
    while t < 1. {
        let m = mix(c, ink, t);
        if contrast(m, bg) >= least {
            return m;
        }
        t += 0.05;
    }
    ink
}

impl Palette {
    pub fn of(l: &Look) -> Self {
        let bg = hex_of(l.bg);
        let fg = hex_of(l.ink);
        let fg2 = hex_of(l.ink2);
        let fg3 = hex_of(l.ink3);
        // Red, green, yellow, blue, magenta, cyan; then their bright forms.
        let (hues, bright): ([u32; 6], [u32; 6]) = if l.dark {
            ([0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7], [0xff7b7b, 0xc8d27a, 0xffd88a, 0x97b8d6, 0xc8a9d2, 0x9fd4cd])
        } else {
            ([0xc82829, 0x718c00, 0xb08800, 0x4271ae, 0x8959a8, 0x3e999f], [0xe0393a, 0x84a000, 0xc99c00, 0x5584c4, 0x9d6dbd, 0x4fb0b6])
        };
        let mut ansi = [0; 16];
        // Black and white: the background's side and the ink's, so neither vanishes on it.
        ansi[0] = if l.dark { mix(bg, fg, 0.28) } else { fg };
        ansi[7] = if l.dark { fg2 } else { mix(bg, fg, 0.55) };
        ansi[8] = fg3;
        ansi[15] = if l.dark { fg } else { mix(bg, fg, 0.4) };
        for i in 0..6 {
            ansi[1 + i] = reading(hues[i], fg, bg, 4.5);
            ansi[9 + i] = reading(bright[i], fg, bg, 4.5);
        }
        Palette { ansi, fg, bg, dim_fg: fg3 }
    }

    /// A 256-colour index: the sixteen, xterm's 6×6×6 cube, then its greys.
    fn indexed(&self, i: u8) -> u32 {
        match i {
            0..=15 => self.ansi[i as usize],
            16..=231 => {
                let n = i - 16;
                let step = |v: u8| if v == 0 { 0 } else { 55 + 40 * v as u32 };
                (step(n / 36) << 16) | (step((n / 6) % 6) << 8) | step(n % 6)
            }
            _ => {
                let g = 8 + 10 * (i as u32 - 232);
                (g << 16) | (g << 8) | g
            }
        }
    }

    fn named(&self, n: NamedColor) -> u32 {
        use NamedColor as N;
        match n {
            N::Foreground | N::BrightForeground => self.fg,
            N::Background => self.bg,
            N::Cursor => self.fg,
            N::DimForeground => self.dim_fg,
            N::DimBlack => self.ansi[0],
            N::DimRed => self.ansi[1],
            N::DimGreen => self.ansi[2],
            N::DimYellow => self.ansi[3],
            N::DimBlue => self.ansi[4],
            N::DimMagenta => self.ansi[5],
            N::DimCyan => self.ansi[6],
            N::DimWhite => self.ansi[7],
            other => {
                let i = other as usize;
                if i < 16 { self.ansi[i] } else { self.fg }
            }
        }
    }

    /// A cell's colour as an RGB triple, the program's own first.
    pub fn rgb(&self, c: Color, own: &Colors) -> u32 {
        let of = |r: Rgb| ((r.r as u32) << 16) | ((r.g as u32) << 8) | r.b as u32;
        match c {
            Color::Spec(r) => of(r),
            Color::Indexed(i) => own[i as usize].map(of).unwrap_or_else(|| self.indexed(i)),
            Color::Named(n) => own[n].map(of).unwrap_or_else(|| self.named(n)),
        }
    }

    /// A bold cell's colour: a named dark one as its bright form, as terminals draw bold.
    pub fn bold(&self, c: Color) -> Color {
        match c {
            Color::Named(n) if (n as usize) < 8 => Color::Named(n.to_bright()),
            Color::Indexed(i) if i < 8 => Color::Indexed(i + 8),
            other => other,
        }
    }

    /// An index's colour for a program that asks (OSC 4 ?, 10 ?, 11 ?).
    pub fn answer(&self, index: usize, own: &Colors) -> Rgb {
        let v = own[index].map(|r| ((r.r as u32) << 16) | ((r.g as u32) << 8) | r.b as u32).unwrap_or_else(|| match index {
            0..=255 => self.indexed(index as u8),
            257 => self.bg,
            _ => self.fg,
        });
        Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 }
    }
}

pub fn hsla(v: u32) -> Hsla {
    gpui::rgb(v).into()
}
