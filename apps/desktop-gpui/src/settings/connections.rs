//! Connections (the desktop's `ui/connections-page.tsx`): the accounts extensions use, a line each,
//! by provider: its account and scopes, Disconnect under the pointer; a provider with none (or that
//! takes more) has Connect. What extensions need is the data layer's query (`queries::needs`), asked
//! again whenever a connection changes and every 30 s while shown.

use gpui::{AnyElement, App, ElementId, FontWeight, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*};

use crate::band::tip;
use crate::kit::{self, Btn, W48};
use crate::look::{Look, u};
use crate::model::model;
use crate::queries;
use crate::settings::calls::{act, land, mounted};
use crate::settings::connection_actions::{cancel_connection, connect};
use crate::settings::parts::{action_error, line, section, warn};

#[derive(Default)]
struct Page {
    /// The provider being connected, while it is.
    connecting: Option<String>,
    connect_error: Option<String>,
    disconnect_error: Option<String>,
    /// The connection under the pointer: its Disconnect shows, and takes Tab.
    hovered: Option<String>,
}

/// A scope as a word: Google's `…/auth/calendar` is "calendar".
fn word(scope: &str) -> &str {
    scope.rsplit("/auth/").next().unwrap_or(scope)
}

fn words(scopes: &[String]) -> String {
    scopes.iter().map(|s| word(s)).collect::<Vec<_>>().join(" ")
}

/// The provider's name, in a column of its own.
fn provider(label: &str) -> impl IntoElement {
    div().w(u(W48)).flex_none().truncate().font_weight(FontWeight::MEDIUM).child(label.to_string())
}

fn start_connect(page: &gpui::Entity<Page>, provider: String, account: Option<String>, cx: &mut App) {
    page.update(cx, |p, cx| {
        p.connecting = Some(provider.clone());
        p.connect_error = None;
        cx.notify();
    });
    let got = connect(&provider, account.as_deref(), cx);
    land(page, got, |p, got, _| {
        p.connecting = None;
        p.connect_error = got.err();
    }, cx);
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (page, _) = mounted("connections-page", window, cx, |_| Page::default());
    let need_list: Vec<queries::ProviderNeed> = queries::needs(cx).data.map(|d| (*d).clone()).unwrap_or_default();
    let all: Vec<crate::brain::Connection> = model(cx).read(cx).brain.connections.values().cloned().collect();
    let p = page.read(cx);
    let connecting = p.connecting.clone();
    let error = p.connect_error.clone().or_else(|| p.disconnect_error.clone());
    let busy = connecting.is_some();
    let mut providers: Vec<String> = vec![];
    for x in need_list.iter().map(|n| &n.provider).chain(all.iter().map(|c| &c.provider)) {
        if !providers.contains(x) {
            providers.push(x.clone());
        }
    }
    let row = |id: String| line(&l).id(ElementId::Name(id.into())).group("line").hover(|s| s.bg(l.hover));
    let mut rows: Vec<AnyElement> = vec![];
    for pv in &providers {
        let need = need_list.iter().find(|n| &n.provider == pv);
        let label = need.map(|n| n.label.clone()).unwrap_or_else(|| pv.clone());
        let mine: Vec<_> = all.iter().filter(|c| &c.provider == pv).collect();
        for c in &mine {
            let missing: Vec<String> = match need {
                Some(n) if n.kind == "oauth" => n.scopes.iter().filter(|x| !c.scopes.contains(x)).cloned().collect(),
                _ => vec![],
            };
            let account = div().id(ElementId::Name(format!("account-{}", c.id).into())).min_w_0().truncate().text_color(l.ink2).when(c.account != "default", |d| d.child(c.account.clone()));
            let account = if c.scopes.is_empty() { account } else { account.tooltip(tip(words(&c.scopes))) };
            let (pa, pp, pid) = (page.clone(), pv.clone(), c.account.clone());
            let (pd, cid) = (page.clone(), c.id.clone());
            rows.push(
                row(format!("connection-{}", c.id))
                    .on_hover({
                        let (page, id) = (page.clone(), c.id.clone());
                        move |over: &bool, _, cx| {
                            page.update(cx, |p, cx| {
                                if *over {
                                    p.hovered = Some(id.clone());
                                } else if p.hovered.as_deref() == Some(id.as_str()) {
                                    p.hovered = None;
                                }
                                cx.notify();
                            })
                        }
                    })
                    .child(provider(&label))
                    .child(account)
                    .when(!missing.is_empty(), |d| {
                        d.child(div().id(ElementId::Name(format!("missing-{}", c.id).into())).flex().flex_none().tooltip(tip(format!("Missing {}", words(&missing)))).child(warn(&l)))
                            .child(kit::press(kit::button(ElementId::Name(format!("reconnect-{}", c.id).into()), Btn::Go, !busy, &l), !busy, move |_, _, cx| start_connect(&pa, pp.clone(), Some(pid.clone()), cx)).aria_label("Connect").child("Connect"))
                    })
                    .child(
                        div().ml_auto().flex().flex_none().child(
                            kit::button(ElementId::Name(format!("disconnect-{}", c.id).into()), Btn::Danger, true, &l)
                                .opacity(0.)
                                .group_hover("line", |s| s.opacity(1.))
                                // Unseen (`invisible`) until the line's under the pointer: no Tab stop till then.
                                .tab_stop(page.read(cx).hovered.as_deref() == Some(c.id.as_str())).aria_label("Disconnect").child("Disconnect").on_click(move |_, _, cx| {
                                pd.update(cx, |p, cx| {
                                    p.disconnect_error = None;
                                    cx.notify();
                                });
                                let cid = cid.clone();
                                act(&pd, move |m, cx| m.disconnect(&cid, cx), |p, got, _| p.disconnect_error = got.err(), cx);
                            }),
                        ),
                    )
                    .into_any_element(),
            );
        }
        let (pc, ppc) = (page.clone(), pv.clone());
        let go = move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| start_connect(&pc, ppc.clone(), None, cx);
        match need {
            Some(n) if n.kind == "session" && mine.is_empty() => {
                // Its extension holds the sign-in.
                rows.push(
                    row(format!("connect-{pv}"))
                        .child(provider(&label))
                        .child(kit::caption(div()).ml_auto().min_w_0().truncate().pl(u(12.)).flex().justify_end().text_color(l.ink2).child(n.apps.join(" ")))
                        .child(kit::press(kit::button(ElementId::Name(format!("sign-in-{pv}").into()), Btn::Go, !busy, &l), !busy, go).aria_label("Sign in").child("Sign in"))
                        .into_any_element(),
                );
            }
            _ if need.map(|n| n.kind.as_str()) != Some("session") && (mine.is_empty() || need.is_some_and(|n| n.multiple)) => {
                rows.push(
                    row(format!("connect-{pv}"))
                        .child(provider(&label))
                        .child(div().flex_1())
                        .child(kit::press(kit::button(ElementId::Name(format!("connect-key-{pv}").into()), if mine.is_empty() { Btn::Go } else { Btn::Key }, !busy, &l), !busy, go).aria_label("Connect").child("Connect"))
                        .into_any_element(),
                );
            }
            _ => {}
        }
    }
    let mut body = div().flex().flex_col();
    if let Some(e) = &error {
        body = body.child(kit::small(div()).flex().min_h(u(24.)).items_center().px(u(8.)).py(u(8.)).text_color(l.ink).border_b(gpui::px(l.w2)).border_color(l.line2).child(action_error(e, &l)));
    }
    if let Some(pv) = connecting {
        body = body.child(div().flex().h(u(24.)).items_center().px(u(8.)).child(kit::button("connect-cancel", Btn::Flat, true, &l).aria_label("Cancel").child("Cancel").on_click(move |_, _, cx| cancel_connection(&pv, cx))));
    }
    body = body.child(section("Accounts", Some(all.len()), rows, &l));
    kit::pane_scroll("connections", None, body, window, cx)
}
