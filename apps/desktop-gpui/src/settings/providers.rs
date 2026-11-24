//! Providers (the desktop's `settings/providers.tsx`, T3 Code's provider settings, with
//! `provider-section.tsx`, `provider-cli.tsx`, `account-row.tsx`, `standing-mark.tsx`,
//! `provider-sign-in.tsx`, `account-completion.tsx`, `provider-models.tsx` and
//! `provider-add.tsx`): each provider with its CLI, its accounts, each once whichever machines it's
//! signed in on, and its models. Refresh asks every provider (and the ACP Registry) again; Add
//! provider, last, adds one not set up yet at the core.

use gpui::{AnyElement, App, Entity, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};
use serde_json::json;
use ui_sdk::components::input::{Input, InputOptions, TextFieldKind, TextFieldStyle};
use ui_sdk::kernel::ChangeOptions;

use super::accounts::{Mark, Row, SUBSCRIPTIONS, Section, Standing, is_login_provider, launch_label, sections};
use super::act::{self, eid, error_row};
use super::parts::action_error;
use super::role_choices::provider_label;
use crate::kit::{self, Btn, Opt, W48};
use crate::look::{Look, u};
use crate::marks;
use crate::model::model;
use crate::mutations::{Adding, urlencode};
use crate::nav::Beat;
use crate::net::Net;
use crate::queries::{self, AccountFlow, AccountView, CliView, QueryState, RegistryAgent};

/// Whether Add provider is open.
struct AddOpen(bool);

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let step = Beat::step(cx);
    let ready = cx.global::<Net>().core().is_some();
    let models = if ready { queries::models(cx) } else { QueryState { data: None, error: None, fetching: false } };
    let accounts = if ready { queries::accounts(cx) } else { QueryState { data: None, error: None, fetching: false } };
    let open = window.use_keyed_state(eid("providers-adding"), cx, |_, _| AddOpen(false));
    let (all, clis) = accounts.data.as_ref().map(|a| (a.accounts.clone(), a.clis.clone())).unwrap_or_default();
    let capabilities = models.data.as_ref().map(|m| m.accounts.clone()).unwrap_or_default();
    let error = accounts.error.clone().or_else(|| models.error.clone());
    // Nothing read yet, and no error (`isPending`).
    let loading = ready && accounts.data.is_none() && accounts.error.is_none();
    let refreshing = models.fetching;
    let on = !refreshing && ready;
    let refresh = kit::press(kit::button("providers-refresh", Btn::Flat, on, &l), on, |_, _, cx| {
        queries::invalidate(queries::ACCOUNTS, cx);
        queries::invalidate(queries::MODELS, cx);
        queries::invalidate(queries::REGISTRY, cx);
    })
    .when(refreshing, |d| d.child(kit::spin(step, &l)))
    .aria_label("Refresh").child("Refresh");
    let mut col: Vec<AnyElement> = vec![div().flex().h(u(24.)).items_center().gap(u(8.)).px(u(8.)).border_b(px(l.w2)).border_color(l.line2).child(div().flex_1()).child(refresh).into_any_element()];
    if let Some(e) = error {
        col.push(error_row(&e, &l));
    }
    if loading {
        col.push(kit::ui(div()).flex().h(u(24.)).items_center().px(u(8.)).text_color(l.ink2).border_b(px(l.w2)).border_color(l.line2).child("Loading").into_any_element());
    }
    for s in sections(&all, &clis, &capabilities) {
        col.push(provider_section(&s, window, cx));
    }
    if ready {
        if open.read(cx).0 {
            let machine = clis.first().map(|c| c.machine.clone());
            let own: Vec<AccountView> = all.iter().filter(|a| machine.as_ref() == Some(&a.machine)).cloned().collect();
            col.push(provider_add(&own, &clis, open, window, cx));
        } else {
            col.push(
                div()
                    .flex()
                    .border_b(px(l.w2))
                    .border_color(l.line2)
                    .child(
                        kit::button("add-provider", Btn::Row, true, &l)
                            .aria_label("Add provider")
                            .on_click(move |_, _, cx| {
                                open.update(cx, |o, cx| {
                                    o.0 = true;
                                    cx.notify();
                                })
                            })
                            .child(div().text_color(l.ink2).child("Add provider")),
                    )
                    .into_any_element(),
            );
        }
    }
    kit::pane_scroll("providers", None, div().flex().flex_col().children(col), window, cx)
}

/// A provider (T3 Code's provider card, laid flat): its CLI, each of its accounts on a line, and the
/// models they offer; Add account for a provider that keeps logins in homes makes one at the core,
/// for every machine, and starts its sign-in on its row.
fn provider_section(s: &Section, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let step = Beat::step(cx);
    let adding = act::act(format!("add-account-{}", s.key), window, cx);
    let (pending, error) = {
        let a = adding.read(cx);
        (a.pending, a.error.clone())
    };
    let label = if s.provider == "acp" { s.key.clone() } else { provider_label(&s.provider) };
    let action = is_login_provider(&s.provider).then(|| {
        let (provider, sign_in) = (s.provider.clone(), s.cli.as_ref().is_some_and(|c| !c.version.is_empty()));
        kit::press(kit::button(eid(format!("add-account-{}", s.key)), Btn::Flat, !pending, &l), !pending, move |_, _, cx| {
            let task = model(cx).update(cx, |m, cx| m.add_account(&provider, sign_in, cx));
            let task = act::then_accounts(task, cx);
            act::settle(&adding, task, |_, _| {}, cx);
        })
        .when(pending, |d| d.child(kit::spin(step, &l)))
        .aria_label("Add account").child("Add account")
        .into_any_element()
    });
    let mut rows: Vec<AnyElement> = vec![];
    if let Some(c) = &s.cli {
        rows.push(provider_cli(&s.key, c, W48, window, cx));
    }
    for r in &s.rows {
        rows.push(account_row(r, W48, window, cx));
    }
    if let Some(e) = error {
        rows.push(action_error(&e, &l));
    }
    if !s.models.is_empty() {
        rows.push(provider_models(&s.key, &s.models, window, cx));
    }
    kit::group(label, action, rows, &l)
}

/// A provider's CLI on the core's machine (T3 Code's runtime row): its version, or Install when it's
/// missing and Switch can install it.
fn provider_cli(scope: &str, cli: &CliView, w: f32, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let installing = act::act(format!("cli-{scope}-{}", cli.provider), window, cx);
    let (pending, error) = {
        let a = installing.read(cx);
        (a.pending, a.error.clone())
    };
    let missing = cli.command.is_empty();
    let words = if !cli.version.is_empty() {
        cli.version.clone()
    } else if missing {
        "Missing".into()
    } else {
        "Unavailable".into()
    };
    let provider = cli.provider.clone();
    kit::setting("CLI", w, &l)
        .child(
            kit::controls()
                .child(kit::data(div()).min_w_0().truncate().text_color(l.ink).child(words))
                .when(missing && cli.installable, |d| {
                    d.child(
                        kit::press(kit::button(eid(format!("cli-{scope}-{provider}-install")), Btn::Key, !pending, &l), !pending, move |_, _, cx| act::account(&installing, format!("/auth/cli/{}/install", urlencode(&provider)), json!({}), cx))
                            .aria_label(if pending { "Installing" } else { "Install" }).child(if pending { "Installing" } else { "Install" }),
                    )
                })
                .when(missing && !cli.installable, |d| d.child(kit::ui(div()).text_color(l.ink).child("Manual install")))
                .when_some(error, |d, e| d.child(action_error(&e, &l))),
        )
        .into_any_element()
}

/// How an account stands, as a mark (needs you, stopped, not as expected), its words under the
/// pointer.
fn standing_mark(id: &str, s: &Standing, l: &Look) -> Option<AnyElement> {
    let size = l.z(12.);
    let glyph = match s.mark? {
        Mark::Hand => marks::hand(size, l).into_any_element(),
        Mark::Stop => marks::stop(size, l).into_any_element(),
        Mark::Warn => marks::warn(size, l).into_any_element(),
    };
    Some(div().id(eid(format!("standing-{id}"))).flex().flex_none().child(glyph).tooltip(crate::band::tip(s.words.clone())).into_any_element())
}

/// An account on its line under its provider (T3 Code's account row): its label, how it stands and
/// how much of its limit it has used; for an account added here, its sign-in and Remove, which asks
/// first.
fn account_row(r: &Row, w: f32, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let id = r.account.id.clone();
    let removing = act::act(format!("account-remove-{id}"), window, cx);
    let (pending, error) = {
        let a = removing.read(cx);
        (a.pending, a.error.clone())
    };
    let mut end = div().ml_auto().flex().flex_wrap().items_center().justify_end().gap(u(8.));
    if r.account.added {
        let ready = r.cli.as_ref().is_some_and(|c| !c.version.is_empty());
        end = end.children(sign_in(&r.account, ready, window, cx));
        let at = id.clone();
        end = end.child(kit::confirm(format!("account-remove-{id}"), "Remove", &format!("Remove {}?", r.label), !pending, move |_, cx| act::account_action(&removing, &at, "remove", json!({}), cx), window, cx));
    }
    kit::setting(r.label.clone(), w, &l)
        .child(
            kit::controls()
                .children(standing_mark(&id, &r.standing, &l))
                .child(kit::ui(div()).min_w_0().truncate().text_color(l.ink).child(r.standing.words.clone()))
                .when_some(r.standing.used, |d, used| d.child(kit::data(div()).text_color(l.ink).child(format!("{used}%"))))
                .child(end)
                .when_some(error, |d, e| d.child(action_error(&e, &l))),
        )
        .into_any_element()
}

fn start_label(starting: bool, signed_in: bool) -> &'static str {
    if starting {
        "Starting"
    } else if signed_in {
        "Change account"
    } else {
        "Sign in"
    }
}

/// An account added here, signed in from here, on its row (T3 Code's account row): Sign in opens the
/// provider's sign-in page in the browser. Claude's page gives a code back, typed in the field under
/// it; a device sign-in (Codex's, FX's) shows its code here to type on the page, and is done when
/// the page has it. Signed in, Change account or Sign out.
fn sign_in(account: &AccountView, ready: bool, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    let l = Look::get(cx);
    let id = account.id.clone();
    let starting = act::act(format!("account-start-{id}"), window, cx);
    let cancelling = act::act(format!("account-cancel-{id}"), window, cx);
    let signing_out = act::act(format!("account-signout-{id}"), window, cx);
    let (s, c, o) = (starting.read(cx), cancelling.read(cx), signing_out.read(cx));
    let busy = s.pending || c.pending || o.pending;
    let error = s.error.clone().or_else(|| c.error.clone()).or_else(|| o.error.clone());
    let start_pending = s.pending;
    let signed_in = matches!(account.status.as_str(), "connected" | "limited");
    let mut out: Vec<AnyElement> = vec![];
    match &account.flow {
        None => {
            let on = !busy && ready;
            let at = id.clone();
            out.push(
                kit::press(kit::button(eid(format!("account-start-{id}")), if signed_in { Btn::Key } else { Btn::Go }, on, &l), on, move |_, _, cx| act::account_action(&starting, &at, "start", json!({}), cx))
                    .aria_label(start_label(start_pending, signed_in))
                    .child(start_label(start_pending, signed_in))
                    .into_any_element(),
            );
        }
        Some(flow) => {
            let url = flow.url.clone();
            out.push(kit::button(eid(format!("account-open-{id}")), Btn::Key, true, &l).on_click(move |_, _, cx| cx.open_url(&url)).aria_label("Open browser").child("Open browser").into_any_element());
            let (at, flow_id) = (id.clone(), flow.flow_id.clone());
            out.push(
                kit::press(kit::button(eid(format!("account-cancel-{id}")), Btn::Flat, !busy, &l), !busy, move |_, _, cx| act::account_action(&cancelling, &at, "cancel", json!({ "flowId": flow_id }), cx))
                    .aria_label("Cancel").child("Cancel")
                    .into_any_element(),
            );
            if flow.code.is_empty() {
                out.push(completion(account, flow, window, cx));
            }
        }
    }
    if signed_in && account.flow.is_none() {
        let on = !busy && ready;
        let at = id.clone();
        out.push(kit::press(kit::button(eid(format!("account-signout-{id}")), Btn::Key, on, &l), on, move |_, _, cx| act::account_action(&signing_out, &at, "signout", json!({}), cx)).aria_label("Sign out").child("Sign out").into_any_element());
    }
    if let Some(flow) = account.flow.as_ref().filter(|f| !f.code.is_empty()) {
        out.push(kit::data(div()).text_color(l.ink).child(kit::selectable(format!("code-{}", account.id), flow.code.clone(), window, cx)).into_any_element());
    }
    if let Some(e) = error {
        out.push(action_error(&e, &l));
    }
    out
}

/// The code a sign-in page gives back, typed here once and never kept: Continue hands it to the
/// core.
fn completion(account: &AccountView, flow: &AccountFlow, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let key = format!("{}-{}", account.id, flow.flow_id);
    let completing = act::act(format!("account-complete-{key}"), window, cx);
    let input = window.use_keyed_state(eid(format!("account-code-{key}")), cx, |window, cx| {
        Input::new(
            InputOptions::default().kind(TextFieldKind::Password).placeholder("Code").field_style(TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() }),
            window,
            cx,
        )
    });
    let (pending, error) = {
        let a = completing.read(cx);
        (a.pending, a.error.clone())
    };
    let (id, flow_id) = (account.id.clone(), flow.flow_id.clone());
    let submit = {
        let (input, completing) = (input.clone(), completing.clone());
        move |window: &mut Window, cx: &mut App| {
            if completing.read(cx).pending {
                return;
            }
            let code = input.read(cx).get_value().trim().to_string();
            input.update(cx, |i, cx| {
                i.clear(ChangeOptions::default(), window, cx);
            });
            act::account_action(&completing, &id, "complete", json!({ "flowId": flow_id, "code": code }), cx);
        }
    };
    let enter = submit.clone();
    div()
        .flex()
        .min_w_0()
        .w_full()
        .flex_wrap()
        .items_center()
        .gap(u(8.))
        .on_key_down(move |e: &KeyDownEvent, window, cx| {
            if e.keystroke.key == "enter" {
                enter(window, cx);
                cx.stop_propagation();
            }
        })
        .child(
            div()
                .flex()
                .flex_1()
                .min_w_0()
                .h(u(22.))
                .items_center()
                .px(u(6.))
                .text_size(u(13.))
                .line_height(u(16.))
                .text_color(l.ink)
                .child(Input::root(&input, cx).aria_label(format!("{} sign-in code", account.id)).w_full()),
        )
        .child(kit::press(kit::button(eid(format!("account-continue-{key}")), Btn::Go, !pending, &l), !pending, move |_, window, cx| submit(window, cx)).aria_label("Continue").child("Continue"))
        .when_some(error, |d, e| d.child(action_error(&e, &l)))
        .into_any_element()
}

/// The models an account offers (T3 Code's models section): how many, Find past eight, a line each,
/// in a list that stops at sixteen lines and scrolls.
fn provider_models(key: &str, models: &[String], window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let find = (models.len() > 8).then(|| kit::field(eid(format!("models-find-{key}")), "", "Find…", window, cx));
    let q = find.as_ref().map(|f| f.read(cx).get_value().trim().to_lowercase()).unwrap_or_default();
    let field = find.map(|f| {
        div()
            .flex()
            .h(u(36.))
            .items_center()
            .px(u(8.))
            .border_b(px(l.w2))
            .border_color(l.line2)
            .text_size(u(13.))
            .line_height(u(16.))
            .text_color(l.ink)
            .child(Input::root(&f, cx).aria_label("Find a model").w_full())
    });
    let shown = models.iter().filter(|m| q.is_empty() || m.to_lowercase().contains(&q));
    div()
        .flex()
        .flex_col()
        .child(
            kit::ui(div())
                .flex()
                .h(u(24.))
                .items_center()
                .gap(u(8.))
                .px(u(8.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(l.ink)
                .border_b(px(l.w2))
                .border_color(l.line2)
                .child("Models")
                .child(kit::caption(div()).ml_auto().font_weight(FontWeight::NORMAL).text_color(l.ink3).child(models.len().to_string())),
        )
        .children(field)
        .child({
            // Each model's name selects as a page's words (`.selectable`), ⌘C copying it.
            let names: Vec<String> = shown.cloned().collect();
            let list_key = key.to_string();
            kit::selecting(format!("models-{key}"), window, cx, move |sel, _, _| {
                div()
                    .id(eid(format!("models-{list_key}")))
                    .flex()
                    .flex_col()
                    .max_h(u(384.))
                    .overflow_y_scroll()
                    .children(names.iter().enumerate().map(|(i, m)| {
                        kit::ui(div())
                            .flex()
                            .h(u(24.))
                            .flex_none()
                            .items_center()
                            .px(u(8.))
                            .text_color(l.ink)
                            .border_b(px(l.w2))
                            .border_color(l.line2)
                            .child(div().min_w_0().truncate().child(crate::select::SelText::new(eid(format!("model-{list_key}-{i}")), (i as u64, 0), sel, m.clone(), None)))
                    }))
                    .into_any_element()
            })
        })
        .into_any_element()
}

/// A registry agent's value among the providers.
const AGENT: &str = "acp:";

/// What's picked in Add provider; nothing picked yet follows the first that can be added.
#[derive(Default)]
struct AddForm {
    provider: Option<String>,
    distribution: Option<String>,
}

fn agent_of(provider: &str, agents: &[RegistryAgent]) -> Option<RegistryAgent> {
    provider.strip_prefix(AGENT).and_then(|id| agents.iter().find(|a| a.id == id)).cloned()
}

/// Add provider (T3 Code's add-provider steps, on one pane), for one not set up on the core's
/// machine yet: a subscription, its own login added, with the CLI it runs on; or an agent from the
/// ACP Registry and how it's installed. More accounts of a provider are added in its section.
fn provider_add(accounts: &[AccountView], clis: &[CliView], open: Entity<AddOpen>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let step = Beat::step(cx);
    let registry = queries::registry(cx);
    let registry_error = registry.error.clone();
    let registry = registry.data.map(|r| (*r).clone()).unwrap_or_default();
    let adding = act::act("provider-add", window, cx);
    let form = window.use_keyed_state(eid("provider-add-form"), cx, |_, _| AddForm::default());
    let subscriptions: Vec<&str> = SUBSCRIPTIONS.iter().copied().filter(|s| *s != "acp" && !accounts.iter().any(|a| a.provider == *s)).collect();
    let agents: Vec<RegistryAgent> = registry.into_iter().filter(|a| !accounts.iter().any(|x| x.id == format!("acp-{}", a.id))).collect();
    let f = form.read(cx);
    let provider = f.provider.clone().unwrap_or_else(|| subscriptions.first().map(|s| s.to_string()).unwrap_or_default());
    let distribution = f.distribution.clone().unwrap_or_default();
    let adding_of = |provider: &str, distribution: &str| -> Option<Adding> {
        if let Some(a) = agent_of(provider, &agents) {
            return Some(Adding::Agent { agent_id: a.id, version: a.version, distribution: distribution.to_string() });
        }
        subscriptions.iter().find(|s| **s == provider).map(|s| Adding::Provider { provider: s.to_string() })
    };
    let can = adding_of(&provider, "").is_some();
    let next = adding_of(&provider, &distribution);
    let agent = agent_of(&provider, &agents);
    let cli = clis.iter().find(|c| c.provider == provider);
    let (pending, error) = {
        let a = adding.read(cx);
        (a.pending, a.error.clone().or(registry_error))
    };
    let mut options: Vec<Opt> = subscriptions.iter().map(|s| Opt::new(*s, launch_label(s).unwrap_or(s))).collect();
    options.extend(agents.iter().map(|a| Opt::new(format!("{AGENT}{}", a.id), format!("{} {}", a.name, a.version)).in_group("ACP Registry")));
    let (pick_form, pick_agents) = (form.clone(), agents.clone());
    let pick = kit::pick(
        "provider-add-provider",
        "Provider",
        options,
        &provider,
        true,
        move |next, _, cx| {
            let d = agent_of(next, &pick_agents).and_then(|a| a.distributions.first().cloned()).unwrap_or_default();
            pick_form.update(cx, |f, cx| {
                f.provider = Some(next.to_string());
                f.distribution = Some(d);
                cx.notify();
            })
        },
        window,
        cx,
    );
    let mut rows: Vec<AnyElement> = vec![kit::setting("Provider", W48, &l).child(kit::controls().child(pick)).into_any_element()];
    if let Some(agent) = &agent {
        let dist_form = form.clone();
        let select = kit::select(
            "provider-add-distribution",
            "Distribution",
            agent.distributions.iter().map(|d| Opt::new(d.clone(), d.clone())).collect(),
            &distribution,
            true,
            move |d, _, cx| {
                dist_form.update(cx, |f, cx| {
                    f.distribution = Some(d.to_string());
                    cx.notify();
                })
            },
            window,
            cx,
        );
        rows.push(kit::setting("Distribution", W48, &l).child(kit::controls().child(select)).into_any_element());
    }
    if let Some(c) = cli {
        rows.push(provider_cli("add", c, W48, window, cx));
    }
    let on = can && !pending;
    let close = open.clone();
    rows.push(
        kit::setting("", W48, &l)
            .child(
                kit::controls()
                    .child(
                        kit::press(kit::button("provider-add-go", Btn::Go, on, &l), on, move |_, _, cx| {
                            if let Some(next) = next.clone() {
                                let close = close.clone();
                                let task = model(cx).update(cx, |m, cx| m.add_provider(next, cx));
                                let task = act::then_accounts(task, cx);
                                act::settle(
                                    &adding,
                                    task,
                                    move |_, cx| {
                                        close.update(cx, |o, cx| {
                                            o.0 = false;
                                            cx.notify();
                                        })
                                    },
                                    cx,
                                );
                            }
                        })
                        .when(pending, |d| d.child(kit::spin(step, &l)))
                        .aria_label(if agent.is_some() { "Install" } else { "Add" }).child(if agent.is_some() { "Install" } else { "Add" }),
                    )
                    .when_some(error, |d, e| d.child(action_error(&e, &l))),
            )
            .into_any_element(),
    );
    let cancel = kit::button("provider-add-cancel", Btn::Flat, true, &l)
        .on_click(move |_, _, cx| {
            open.update(cx, |o, cx| {
                o.0 = false;
                cx.notify();
            })
        })
        .aria_label("Cancel").child("Cancel")
        .into_any_element();
    kit::group("Add provider", Some(cancel), rows, &l)
}
