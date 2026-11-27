//! The house's Document: a document an extension reads (`doc`), its words, threads and notes from
//! its tools (`tools`: `content`, `define`, `ask`, `highlight`, `unhighlight`, `editNote`,
//! `deleteNote`). In its own window, the
//! reader (`reader.rs`); in a chat or a space's column, one line, its title and size, that opens
//! that window (the extension's `widget` with `{ doc }`).

use gpui::{AnyElement, App, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::*};
use serde_json::{Value, json};

use crate::look::u;
use crate::reader::{Data, Reader, Tools};
use crate::widgets::render::Ctx;
use crate::widgets::window::{self, View};

fn tools_of(c: &Value) -> Tools {
    let t = |k: &str| c.pointer(&format!("/tools/{k}")).and_then(Value::as_str).unwrap_or_default().to_string();
    Tools { content: t("content"), define: t("define"), ask: t("ask"), highlight: t("highlight"), unhighlight: t("unhighlight"), edit_note: t("editNote"), delete_note: t("deleteNote") }
}

pub fn document(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let s = &ctx.scope;
    let doc = s.text(c, "doc");
    let title = s.text(c, "title");
    if !ctx.in_window {
        let detail = s.text(c, "detail");
        let threads = s.number(c, "threadCount").unwrap_or(0.) as u64;
        let widget = c.get("widget").and_then(Value::as_str).unwrap_or("document").to_string();
        let app = ctx.app().to_string();
        let input = json!({ "doc": doc });
        return div()
            .id(ctx.id(c, "line"))
            .role(gpui::Role::Button)
            .tab_index(0)
            .focus_visible(|st| st.shadow(crate::kit::ring(&l)))
            .flex()
            .items_center()
            .gap(u(8.))
            .h(u(32.))
            .px(u(8.))
            .cursor_pointer()
            .hover(|st| st.bg(l.hover))
            .on_click(move |_, _, cx| {
                window::open(View { app: app.clone(), name: widget.clone(), input: Some(input.clone()) }, cx);
            })
            .child(div().flex_1().min_w_0().truncate().text_size(u(13.)).line_height(u(16.)).font_weight(FontWeight::MEDIUM).text_color(l.ink).child(SharedString::from(title)))
            .when(threads > 0, |d| d.child(div().flex_none().text_size(u(12.)).text_color(l.ink3).child(SharedString::from(format!("{threads} {}", if threads == 1 { "thread" } else { "threads" })))))
            .when(!detail.is_empty(), |d| d.child(div().flex_none().text_size(u(12.)).text_color(l.ink3).child(SharedString::from(detail))))
            .into_any_element();
    }
    let app = ctx.app().to_string();
    let tools = tools_of(c);
    let reader = ctx.state(c, "reader", window, cx, move |window, cx| Reader::new(app, doc, tools, window, cx));
    let data = Data {
        title,
        paged: s.text(c, "format") == "pdf",
        version: s.number(c, "version").unwrap_or(0.) as u64,
        highlights: s.prop(c, "highlights"),
        threads: s.prop(c, "threads"),
        notes: s.prop(c, "notes"),
        seen: s.prop(c, "seen"),
        open: s.text(c, "open"),
        widget: c.get("widget").and_then(Value::as_str).unwrap_or("document").to_string(),
    };
    reader.update(cx, |r, cx| r.take(data, cx));
    // The keys are the reader's from its first frame.
    let given = ctx.state(c, "focused", window, cx, |_, _| false);
    if !*given.read(cx) {
        given.update(cx, |g, _| *g = true);
        let focus = reader.read(cx).focus();
        window.focus(&focus, cx);
    }
    div().size_full().child(reader).into_any_element()
}
