//! Extensions (the desktop's `ui/extensions-page.tsx`, `extension-add.tsx`, `extensions.ts`): what's
//! installed, each with its version, Update and Remove under the pointer; adding one by a git URL or
//! package name on top, installed on Enter or Add. Each is a call to the core's extensions tools;
//! what's installed comes by sync.

use gpui::{AnyElement, App, ElementId, Focusable, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};
use ui_sdk::components::input::Input;
use ui_sdk::kernel::ChangeOptions;

use crate::band::tip;
use crate::kit::{self, Btn};
use crate::look::{Look, MONO, u};
use crate::model::model;
use crate::nav::Beat;
use crate::settings::calls::{act, mounted};
use crate::settings::parts::{data, line, notice, section};

#[derive(Default)]
struct Page {
    installing: bool,
    install_error: Option<String>,
    /// The extension being updated or removed, while it is.
    updating: Option<String>,
    update_error: Option<String>,
    removing: Option<String>,
    remove_error: Option<String>,
    /// The add line empties once an install goes through.
    reset: bool,
    /// The words an Add was refused for (empty): Add is off until they change.
    refused: Option<String>,
}

fn install(page: &gpui::Entity<Page>, source: String, cx: &mut App) {
    page.update(cx, |p, cx| {
        p.installing = true;
        p.install_error = None;
        cx.notify();
    });
    act(page, move |m, cx| m.install_extension(&source, cx), |p, got, _| {
        p.installing = false;
        match got {
            Ok(_) => p.reset = true,
            Err(e) => p.install_error = Some(e),
        }
    }, cx);
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (page, fresh) = mounted("extensions-page", window, cx, |_| Page::default());
    let source = kit::field("extension-source", "", "Git URL", window, cx);
    if fresh {
        let h = source.read(cx).focus_handle(cx);
        window.focus(&h, cx);
    }
    if page.read(cx).reset {
        page.update(cx, |p, _| p.reset = false);
        source.update(cx, |i, cx| {
            i.clear(ChangeOptions::default(), window, cx);
        });
    }
    let mut extensions: Vec<crate::brain::Extension> = model(cx).read(cx).brain.extension_info.values().cloned().collect();
    extensions.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    let p = page.read(cx);
    let error = p.install_error.clone().or_else(|| p.update_error.clone()).or_else(|| p.remove_error.clone());
    let (installing, updating, removing) = (p.installing, p.updating.clone(), p.removing.clone());
    let can = p.refused.as_deref() != Some(source.read(cx).get_value().as_ref());

    let submit = {
        let (page, source) = (page.clone(), source.clone());
        move |cx: &mut App| {
            if page.read(cx).installing {
                return;
            }
            let value = source.read(cx).get_value().to_string();
            if value.is_empty() {
                // Refused by its check: Add is off until the words change.
                page.update(cx, |p, cx| {
                    p.refused = Some(String::new());
                    cx.notify();
                });
                return;
            }
            install(&page, value.trim().to_string(), cx);
        }
    };
    let enter = submit.clone();
    let add = div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .pr(u(8.))
        .border_b(px(l.w2))
        .border_color(l.line2)
        .on_key_down(move |e: &KeyDownEvent, _, cx| {
            if e.keystroke.key == "enter" {
                enter(cx);
                cx.stop_propagation();
            }
        })
        .child(div().flex_1().min_w_0().h_full().flex().items_center().pl(u(8.)).font_family(MONO).text_size(u(11.)).line_height(u(14.)).text_color(l.ink).child(Input::root(&source, cx).text_color(l.ink).aria_label("Git URL").w_full()))
        .child(
            kit::press(kit::button("extension-add", Btn::Go, can && !installing, &l), can && !installing, move |_, _, cx| submit(cx))
                .when(installing, |d| d.child(kit::spin(Beat::step(cx), &l)))
                .aria_label("Add").child("Add"),
        );

    let rows: Vec<AnyElement> = if extensions.is_empty() {
        vec![line(&l).text_color(l.ink3).child("None").into_any_element()]
    } else {
        extensions
            .iter()
            .map(|x| {
                let name = x.name.clone();
                let up_on = updating.as_deref() != Some(&name);
                let rm_on = removing.as_deref() != Some(&name);
                let (pu, nu) = (page.clone(), name.clone());
                let (pr, nr) = (page.clone(), name.clone());
                line(&l)
                    .id(ElementId::Name(format!("extension-{name}").into()))
                    .group("line")
                    .hover(|s| s.bg(l.hover))
                    .when(!x.from.is_empty(), |d| d.tooltip(tip(x.from.clone())))
                    .child(div().min_w_0().truncate().child(name.clone()))
                    .child(div().ml_auto())
                    .child(data(x.version.clone(), None, &l))
                    .child(
                        div().flex_none().child(kit::press(kit::button(ElementId::Name(format!("update-{name}").into()), Btn::Key, up_on, &l).opacity(0.).group_hover("line", move |s| s.opacity(if up_on { 1. } else { 0.4 })), up_on, move |_, _, cx| {
                            pu.update(cx, |p, cx| {
                                p.updating = Some(nu.clone());
                                p.update_error = None;
                                cx.notify();
                            });
                            let nu = nu.clone();
                            act(&pu, move |m, cx| m.update_extension(&nu, cx), |p, got, _| {
                                p.updating = None;
                                p.update_error = got.err();
                            }, cx);
                        })
                        .aria_label("Update").child("Update")),
                    )
                    .child(
                        div().flex_none().child(kit::press(kit::button(ElementId::Name(format!("remove-{name}").into()), Btn::Danger, rm_on, &l).opacity(0.).group_hover("line", move |s| s.opacity(if rm_on { 1. } else { 0.4 })), rm_on, move |_, _, cx| {
                            pr.update(cx, |p, cx| {
                                p.removing = Some(nr.clone());
                                p.remove_error = None;
                                cx.notify();
                            });
                            let nr = nr.clone();
                            act(&pr, move |m, cx| m.remove_extension(&nr, cx), |p, got, _| {
                                p.removing = None;
                                p.remove_error = got.err();
                            }, cx);
                        })
                        .aria_label("Remove").child("Remove")),
                    )
                    .into_any_element()
            })
            .collect()
    };
    let body = div()
        .flex()
        .flex_col()
        .child(add)
        .when_some(error, |d, e| d.child(notice(e, &l)))
        .child(section("Installed", Some(extensions.len()), rows, &l));
    kit::pane_scroll("extensions", None, body, window, cx)
}
