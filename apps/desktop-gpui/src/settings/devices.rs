//! Devices (the desktop's `ui/settings/devices.tsx`, `devices-section.tsx`, `devices.ts`): pairings
//! waiting (Approve, Deny), then the devices, hosts and extensions that may reach the core (Revoke),
//! and a QR that pairs an iPhone at once. Each act is a post to the core's `/auth` routes; the list
//! comes by sync.

use gpui::{AnyElement, App, ElementId, IntoElement, ParentElement, Styled, Window, div, prelude::*};

use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::model::model;
use crate::brain::{Credential, CredentialStatus};
use crate::mutations::Offer;
use crate::settings::calls::{act as run, mounted};
use crate::settings::parts::{data, line, notice, section};
use crate::settings::qr::qr;
use crate::time::now_ms;

const KINDS: [(&str, &str); 5] = [("device", "Devices"), ("host", "Hosts"), ("extension", "Extensions"), ("peer", "Agents"), ("tailnet", "Tailnet")];

#[derive(Default)]
struct Page {
    approve_error: Option<String>,
    deny_error: Option<String>,
    revoke_error: Option<String>,
    offer_error: Option<String>,
    offered: Option<Offer>,
}

#[derive(Clone, Copy)]
enum Act {
    Approve,
    Deny,
    Revoke,
}

fn slot(p: &mut Page, which: Act) -> &mut Option<String> {
    match which {
        Act::Approve => &mut p.approve_error,
        Act::Deny => &mut p.deny_error,
        Act::Revoke => &mut p.revoke_error,
    }
}

fn act(page: &gpui::Entity<Page>, which: Act, id: String, cx: &mut App) {
    page.update(cx, |p, cx| {
        *slot(p, which) = None;
        cx.notify();
    });
    run(page, move |m, cx| match which {
        Act::Approve => m.approve(&id, cx),
        Act::Deny => m.deny(&id, cx),
        Act::Revoke => m.revoke(&id, cx),
    }, move |p, got, _| *slot(p, which) = got.err(), cx);
}

fn offer(page: &gpui::Entity<Page>, cx: &mut App) {
    page.update(cx, |p, cx| {
        p.offer_error = None;
        cx.notify();
    });
    run(page, |m, cx| m.offer(cx), |p, got, _| match got {
        Ok(o) => p.offered = Some(o),
        Err(e) => p.offer_error = Some(e),
    }, cx);
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (page, _) = mounted("devices-page", window, cx, |_| Page::default());
    let now = now_ms();
    let m = model(cx);
    let b = &m.read(cx).brain;
    let all: Vec<Credential> = b.credentials.values().cloned().collect();
    let extensions = b.extensions.clone();
    let p = page.read(cx);
    let error = p.approve_error.clone().or_else(|| p.deny_error.clone()).or_else(|| p.revoke_error.clone()).or_else(|| p.offer_error.clone());
    let offered = p.offered.clone();
    let waiting: Vec<&Credential> = all.iter().filter(|c| c.status == CredentialStatus::Pending).collect();
    let live = |c: &Credential| c.status == CredentialStatus::Active && c.until.is_none_or(|u| u > now);
    // An extension's credential has no row until it's revoked: every installed one is live otherwise.
    let revoked: Vec<&str> = all.iter().filter(|c| c.kind == "extension").map(|c| c.name.as_str()).collect();
    let extension_rows: Vec<Credential> = extensions
        .iter()
        .filter(|name| !revoked.contains(&name.as_str()))
        .map(|name| Credential {
            id: format!("extension:{name}"),
            name: name.clone(),
            kind: "extension".into(),
            scopes: vec![format!("extension:{name}")],
            status: CredentialStatus::Active,
            code: None,
            at: 0.,
            until: None,
        })
        .collect();
    let by_kind = |kind: &str| -> Vec<Credential> { all.iter().filter(|c| live(c)).chain(extension_rows.iter()).filter(|c| c.kind == kind).cloned().collect() };

    let mut body = div().flex().flex_col();
    if let Some(e) = error {
        body = body.child(notice(e, &l));
    }
    if !waiting.is_empty() {
        let rows: Vec<AnyElement> = waiting
            .iter()
            .map(|c| {
                let (pd, idd) = (page.clone(), c.id.clone());
                let (pa, ida) = (page.clone(), c.id.clone());
                line(&l)
                    .child(div().min_w_0().truncate().child(c.name.clone()))
                    .child(data(c.code.clone().unwrap_or_default(), None, &l))
                    .child(kit::button(ElementId::Name(format!("deny-{}", c.id).into()), Btn::Danger, true, &l).aria_label("Deny").child("Deny").on_click(move |_, _, cx| act(&pd, Act::Deny, idd.clone(), cx)))
                    .child(kit::button(ElementId::Name(format!("approve-{}", c.id).into()), Btn::Go, true, &l).aria_label("Approve").child("Approve").on_click(move |_, _, cx| act(&pa, Act::Approve, ida.clone(), cx)))
                    .into_any_element()
            })
            .collect();
        body = body.child(section("Pairing", Some(waiting.len()), rows, &l));
    }
    for (kind, label) in KINDS {
        let rows = by_kind(kind);
        if rows.is_empty() && kind != "device" {
            continue;
        }
        let mut out: Vec<AnyElement> = rows
            .iter()
            .map(|c| {
                let (pr, id) = (page.clone(), c.id.clone());
                line(&l)
                    .child(div().min_w_0().flex_1().truncate().child(c.name.clone()))
                    .child(kit::button(ElementId::Name(format!("revoke-{}", c.id).into()), Btn::Danger, true, &l).aria_label("Revoke").child("Revoke").on_click(move |_, _, cx| act(&pr, Act::Revoke, id.clone(), cx)))
                    .into_any_element()
            })
            .collect();
        if kind == "device" {
            match offered.as_ref().filter(|o| o.until > now && !rows.iter().any(|c| c.at > o.made)) {
                Some(o) => out.push(div().flex().justify_center().py(u(8.)).child(qr(&o.link, 220., &l)).into_any_element()),
                None => {
                    let po = page.clone();
                    out.push(line(&l).child(div().min_w_0().flex_1()).child(kit::button("pair-iphone", Btn::Go, true, &l).aria_label("Pair iPhone").child("Pair iPhone").on_click(move |_, _, cx| offer(&po, cx))).into_any_element());
                }
            }
        }
        body = body.child(section(label, Some(rows.len()), out, &l));
    }
    kit::pane_scroll("devices", None, body, window, cx)
}
