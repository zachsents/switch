//! A2UI's Text in the house look (the desktop's `widgets/basic/text.tsx`). Its words are simple
//! Markdown: a heading, of any level, draws as a widget's heading did (a line, the UI size,
//! semibold), the rest as a line's words do (the UI size in ink, inset from the cell's edges),
//! wrapping. A caption draws as an empty state did (a line in ink3), its words plain. Words that are
//! nothing once their headings' marks are gone draw nothing; inside a key, only the words.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, Window, div};
use serde_json::Value;

use crate::look::u;
use crate::widgets::basic::{nothing, share};
use crate::widgets::render::Ctx;

/// What's said once headings' marks are gone.
pub fn said(text: &str) -> String {
    text.lines()
        .map(|l| {
            let t = l.trim_start_matches(' ');
            let hashes = t.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes) && (l.len() - t.len()) <= 3 && t[hashes..].chars().next().is_none_or(|c| c == ' ' || c == '\t') {
                t[hashes..].to_string()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub fn text(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let text = ctx.scope.words(c, "text");
    if said(&text).is_empty() {
        return nothing();
    }
    if ctx.in_key {
        return div().child(text).into_any_element();
    }
    if ctx.scope.text(c, "variant") == "caption" {
        // A caption never paints in a space's column (widget-cell.tsx): it's an empty state's words.
        if ctx.in_column {
            return nothing();
        }
        return share(div().flex().h(u(24.)).items_center().px(u(8.)).text_size(u(13.)).line_height(u(16.)).text_color(l.ink3).child(text), c, ctx).into_any_element();
    }
    let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
    let key = format!("text:{}:{id}@{}", ctx.key, ctx.scope.base);
    // The chat's Markdown in the cell's layout: its links (cites, `switchboard:`), its code copied on a
    // click, its task lists and tables, its pictures.
    let doc = window.use_keyed_state(gpui::ElementId::Name(format!("{key}-doc").into()), cx, |_, _| (String::new(), std::rc::Rc::new(crate::markdown::Doc::default())));
    if doc.read(cx).0 != text {
        let parsed = std::rc::Rc::new(crate::markdown::Doc::of(&text));
        doc.update(cx, |d, _| *d = (text.clone(), parsed));
    }
    let doc = doc.read(cx).1.clone();
    let drawn = crate::kit::selecting(key.clone(), window, cx, move |sel, window, cx| {
        let m = crate::markdown::Ctx { id: key, order: 0, sel: sel.clone(), on_link: crate::chat::on_link(), on_picture: crate::chat::on_picture(), ink: None, cell: true, pictures: Default::default() };
        crate::markdown::render(&doc, &m, &l, window, cx).into_any_element()
    });
    share(div().flex().flex_col().min_w_0().text_size(u(13.)).line_height(u(16.)).text_color(l.ink).child(drawn), c, ctx).into_any_element()
}
