//! A QR code (the desktop's `ui/qr.tsx`), its modules drawn as quads with a border of two, dark on
//! light whatever the theme so cameras read it.

use gpui::{Bounds, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, canvas, fill, point, prelude::FluentBuilder, size};
use qrcode::{Color, EcLevel, QrCode};

use crate::look::Look;

pub fn qr(text: &str, px: f32, l: &Look) -> impl IntoElement {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).ok();
    let (white, black) = (l.white, l.black);
    let side = l.z(px);
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            window.paint_quad(fill(bounds, white));
            let Some(code) = &code else { return };
            let w = code.width();
            let n = (w + 4) as f32;
            let cell = bounds.size.width / n;
            let at = |i: usize| (cell * i as f32).round();
            for (i, c) in code.to_colors().iter().enumerate() {
                if *c == Color::Dark {
                    let (x, y) = (i % w + 2, i / w + 2);
                    let origin = point(bounds.origin.x + at(x), bounds.origin.y + at(y));
                    window.paint_quad(fill(Bounds { origin, size: size(at(x + 1) - at(x), at(y + 1) - at(y)) }, black));
                }
            }
        },
    )
    .size(side)
    .flex_none()
    .map(|c| gpui::div().id("qr").role(gpui::Role::Image).aria_label("QR").flex_none().child(c))
}
