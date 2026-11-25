//! Devices (the desktop's `ui/settings/devices.tsx`, `devices-section.tsx`, `devices.ts`): pairings
//! waiting (Approve, Deny), then each device that may reach the core, one row however many times it
//! paired (by its own `device` id, else its name), with when it was last used, its Revoke quiet under
//! the pointer; and a QR that pairs an iPhone at once. What else holds a credential (hosts,
//! extensions, agents) is on the Extensions page (`access`). Each act is a post to the core's `/auth`
//! routes; the list comes by sync.

use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*};

use crate::band::tip;
use crate::brain::{Credential, CredentialStatus};
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::model::model;
use crate::mutations::Offer;
use crate::settings::calls::{act as run, mounted};
use crate::settings::parts::{data, line, notice, section};
use crate::settings::qr::qr;
use crate::time::{now_ms, stamp_of, when_of};

/// Used this recently, it's in use now: the core notes a use every ten minutes at most.
const NOW_MS: f64 = 15. * 60_000.;

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

/// Whether it may reach the core now.
pub fn live(c: &Credential, now: f64) -> bool {
    c.status == CredentialStatus::Active && c.until.is_none_or(|u| u > now)
}

/// When it was last used: when it was made, until a use is noted.
pub fn seen(c: &Credential) -> f64 {
    c.seen.unwrap_or(c.at).max(c.at)
}

/// When, as a row's end says it: "Now", the time today, else the day.
pub fn seen_label(at: f64, now: f64) -> String {
    if now - at < NOW_MS { "Now".into() } else { stamp_of(at) }
}

/// A device: every live credential it holds, the latest first.
struct Device {
    /// Its own id, once one of its credentials names it.
    id: Option<String>,
    held: Vec<Credential>,
}

impl Device {
    fn latest(&self) -> &Credential {
        &self.held[0]
    }

    fn seen(&self) -> f64 {
        self.held.iter().map(seen).fold(0., f64::max)
    }

    /// A Mac's app may approve and revoke; an iPhone's only reads and writes the brain.
    fn kind(&self) -> &'static str {
        if self.held.iter().any(|c| c.scopes.iter().any(|s| s == "admin")) { "Mac" } else { "iPhone" }
    }

    /// Whether `c` is this device's: by its id, or by its name where either has none (one it held
    /// before devices named themselves).
    fn holds(&self, c: &Credential) -> bool {
        match (&self.id, &c.device) {
            (Some(a), Some(b)) => a == b,
            _ => self.latest().name == c.name,
        }
    }
}

/// The devices among `all`, each once, the most recently used first.
fn devices(all: &[Credential], now: f64) -> Vec<Device> {
    let mut held: Vec<&Credential> = all.iter().filter(|c| c.kind == "device" && live(c, now)).collect();
    held.sort_by(|a, b| seen(b).total_cmp(&seen(a)));
    let mut out: Vec<Device> = vec![];
    for c in held {
        match out.iter_mut().find(|d| d.holds(c)) {
            Some(d) => {
                d.id = d.id.take().or_else(|| c.device.clone());
                d.held.push(c.clone());
            }
            None => out.push(Device { id: c.device.clone(), held: vec![c.clone()] }),
        }
    }
    out
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (page, _) = mounted("devices-page", window, cx, |_| Page::default());
    let now = now_ms();
    let m = model(cx);
    let all: Vec<Credential> = m.read(cx).brain.credentials.values().cloned().collect();
    let p = page.read(cx);
    let error = p.approve_error.clone().or_else(|| p.deny_error.clone()).or_else(|| p.revoke_error.clone()).or_else(|| p.offer_error.clone());
    let offered = p.offered.clone();
    let waiting: Vec<&Credential> = all.iter().filter(|c| c.status == CredentialStatus::Pending).collect();
    let found = devices(&all, now);

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
    let mut rows: Vec<AnyElement> = found
        .iter()
        .map(|d| {
            let c = d.latest();
            let at = d.seen();
            let ids: Vec<String> = d.held.iter().map(|c| c.id.clone()).collect();
            let pr = page.clone();
            let revoke = kit::confirm_quiet(format!("revoke-{}", c.id), "Revoke", &format!("Revoke {}?", c.name), move |_, cx| {
                for id in &ids {
                    act(&pr, Act::Revoke, id.clone(), cx);
                }
            }, window, cx);
            line(&l)
                .id(ElementId::Name(format!("device-{}", c.id).into()))
                .group("line")
                .hover(|s| s.bg(l.hover))
                .child(div().min_w_0().flex_1().truncate().child(c.name.clone()))
                .child(data(d.kind(), Some(56.), &l))
                .child(div().id(ElementId::Name(format!("seen-{}", c.id).into())).tooltip(tip(when_of(at))).child(data(seen_label(at, now), Some(72.), &l)))
                .child(div().flex_none().opacity(0.).group_hover("line", |s| s.opacity(1.)).child(revoke))
                .into_any_element()
        })
        .collect();
    match offered.as_ref().filter(|o| o.until > now && !all.iter().any(|c| c.kind == "device" && c.at > o.made)) {
        Some(o) => rows.push(div().flex().justify_center().py(u(8.)).child(qr(&o.link, 220., &l)).into_any_element()),
        None => {
            let po = page.clone();
            rows.push(line(&l).child(div().min_w_0().flex_1()).child(kit::button("pair-iphone", Btn::Go, true, &l).aria_label("Pair iPhone").child("Pair iPhone").on_click(move |_, _, cx| offer(&po, cx))).into_any_element());
        }
    }
    body = body.child(section("Devices", Some(found.len()), rows, &l));
    kit::pane_scroll("devices", None, body, window, cx)
}
