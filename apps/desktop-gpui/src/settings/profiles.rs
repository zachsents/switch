//! Profiles (the desktop's `settings/profiles.tsx`, with `profile-section.tsx`, `profile-form.tsx`
//! and `role-choice.tsx`): each a mapping of the brain's roles to a provider, a model and an account,
//! mixed as it likes; the one in use picked at the top, each one's roles under its name, to change
//! in place. New starts from the one in use; Duplicate and Edit open one in edit in its place.

use std::rc::Rc;

use gpui::{AnyElement, App, Entity, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Styled, Window, div, prelude::*, px};
use ui_sdk::components::input::Input;

use super::accounts::{account_labels, labeled};
use super::act::{self, Act, eid, error_row};
use super::parts::action_error;
use super::role_choices::{EDITABLE, account_choices, copy_name, key_of, model_choices, provider_label, role_get, role_label, role_with};
use crate::kit::{self, Btn, Opt};
use crate::look::{Look, u};
use crate::model::model;
use crate::mutations::SaveProfile;
use crate::net::Net;
use crate::queries::{self, Capability, ModelChoice, ModelsView, NamedProfile, QueryState, Roles};

/// The labels' width, `w-32`.
const W32: f32 = 128.;

const CHOICE_PROVIDERS: [&str; 13] = ["gateway", "claude-code", "codex", "antigravity", "fx", "workers-ai", "cursor", "opencode", "grok", "kiro", "pi", "muse", "acp"];

/// A name as the core takes it: 1 to 80 long, counted as UTF-16.
fn name_ok(s: &str) -> bool {
    (1..=80).contains(&s.encode_utf16().count())
}

/// Whether a profile reads as one (`NamedProfile`'s schema): the form can be saved.
fn profile_ok(p: &NamedProfile) -> bool {
    name_ok(&p.name) && EDITABLE.iter().map(|r| role_get(&p.roles, r)).all(|c| CHOICE_PROVIDERS.contains(&c.provider.as_str()) && name_ok(&c.id))
}

/// The profile in edit, as it was when opened (what's kept meanwhile doesn't close it), and whether
/// it's a new one made from it.
struct Editing(Option<(NamedProfile, bool)>);

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let ready = cx.global::<Net>().core().is_some();
    let query = if ready { queries::models(cx) } else { QueryState { data: None, error: None, fetching: false } };
    let (error, fetching) = (query.error.clone(), query.fetching);
    let body: Vec<AnyElement> = match query.data {
        Some(view) => loaded((*view).clone(), window, cx),
        None => {
            let row = div().flex().min_h(u(36.)).flex_wrap().items_center().gap(u(8.)).px(u(8.)).py(u(6.)).border_b(px(l.w2)).border_color(l.line2);
            let row = match error {
                Some(e) => {
                    let on = !fetching && ready;
                    row.child(action_error(&e, &l)).child(
                        kit::press(kit::button("profiles-retry", Btn::Key, on, &l), on, |_, _, cx| queries::invalidate(queries::MODELS, cx)).aria_label("Retry").child("Retry"),
                    )
                }
                None => row.child(kit::ui(div()).text_color(l.ink2).child("Loading")),
            };
            vec![row.into_any_element()]
        }
    };
    kit::pane_scroll("profiles", None, div().flex().flex_col().children(body), window, cx)
}

fn set_editing(editing: &Entity<Editing>, to: Option<(NamedProfile, bool)>, cx: &mut App) {
    editing.update(cx, |e, cx| {
        e.0 = to;
        cx.notify();
    });
}

fn loaded(view: ModelsView, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    let l = Look::get(cx);
    let selecting = act::act("profiles-select", window, cx);
    let removing = act::act("profiles-remove", window, cx);
    let editing = window.use_keyed_state(eid("profiles-editing"), cx, |_, _| Editing(None));
    let active = view.profiles.iter().find(|p| p.name == view.active).or(view.profiles.first()).cloned();
    let (error, removing_pending) = {
        let (s, r) = (selecting.read(cx), removing.read(cx));
        (s.error.clone().or_else(|| r.error.clone()), r.pending)
    };
    let names: Vec<(&str, &str)> = view.profiles.iter().map(|p| (p.name.as_str(), p.name.as_str())).collect();
    let in_use = kit::setting("In use", W32, &l).child(
        kit::controls()
            .when_some(active.as_ref(), |d, a| d.child(kit::segmented("profile-in-use", "Profile in use", &names, &a.name, &l, move |name, _, cx| {
                let task = model(cx).update(cx, |m, cx| m.select_profile(name, cx));
                act::settle(&selecting, task, |_, _| {}, cx);
            }, window, cx)))
            .child(div().flex_1())
            .when_some(active.clone(), |d, a| {
                let editing = editing.clone();
                d.child(kit::button("profile-new", Btn::Flat, true, &l).on_click(move |_, _, cx| set_editing(&editing, Some((a.clone(), true)), cx)).aria_label("New").child("New"))
            }),
    );
    let mut out: Vec<AnyElement> = vec![in_use.into_any_element()];
    if let Some(e) = error {
        out.push(error_row(&e, &l));
    }
    let open = editing.read(cx).0.clone();
    if let Some((p, true)) = &open {
        out.push(profile_form(p, true, &view, editing.clone(), window, cx));
    }
    for p in &view.profiles {
        match &open {
            Some((e, false)) if e.name == p.name => out.push(profile_form(e, false, &view, editing.clone(), window, cx)),
            _ => out.push(profile_section(p, active.as_ref().is_some_and(|a| a.name == p.name), &view.accounts, removing_pending, &editing, &removing, window, cx)),
        }
    }
    out
}

/// A profile under its name (T3 Code's text generation model, a role a line): a change keeps at
/// once. Duplicate and Edit open it in edit; Remove asks first, and the one in use has none.
#[allow(clippy::too_many_arguments)]
fn profile_section(p: &NamedProfile, active: bool, accounts: &[Capability], removing_pending: bool, editing: &Entity<Editing>, removing: &Entity<Act>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let name = p.name.clone();
    let saving = act::act(format!("profile-save-{name}"), window, cx);
    let remove = (!active).then(|| {
        let (removing, name) = (removing.clone(), name.clone());
        kit::confirm(format!("profile-remove-{name}"), "Remove", &format!("Remove {name}?"), !removing_pending, move |_, cx| {
            let task = model(cx).update(cx, |m, cx| m.delete_profile(&name, cx));
            act::settle(&removing, task, |_, _| {}, cx);
        }, window, cx)
    });
    let (dup, edit) = (editing.clone(), editing.clone());
    let (dup_p, edit_p) = (p.clone(), p.clone());
    let action = div()
        .flex()
        .items_center()
        .gap(u(6.))
        .child(kit::button(eid(format!("profile-duplicate-{name}")), Btn::Flat, true, &l).on_click(move |_, _, cx| set_editing(&dup, Some((dup_p.clone(), true)), cx)).aria_label("Duplicate").child("Duplicate"))
        .child(kit::button(eid(format!("profile-edit-{name}")), Btn::Flat, true, &l).on_click(move |_, _, cx| set_editing(&edit, Some((edit_p.clone(), false)), cx)).aria_label("Edit").child("Edit"))
        .children(remove)
        .into_any_element();
    let mut rows: Vec<AnyElement> = vec![];
    for role in EDITABLE {
        let (saving, name, roles) = (saving.clone(), name.clone(), p.roles.clone());
        let change: Rc<dyn Fn(ModelChoice, &mut App)> = Rc::new(move |choice, cx| {
            let task = model(cx).update(cx, |m, cx| m.save_profile(SaveProfile { name: name.clone(), roles: role_with(&roles, role, choice), previous: Some(name.clone()) }, cx));
            act::settle(&saving, task, |_, _| {}, cx);
        });
        let choice = role_choice(&format!("profile-{}", p.name), role, role_get(&p.roles, role), accounts, change, window, cx);
        rows.push(kit::setting(role_label(role), W32, &l).child(kit::controls().children(choice)).into_any_element());
    }
    if let Some(e) = saving.read(cx).error.clone() {
        rows.push(error_row(&e, &l));
    }
    kit::group(p.name.clone(), Some(action), rows, &l)
}

/// One role's model, picked under its provider (T3 Code's model picker, by provider), and the
/// account it runs on: Auto, or one subscription, by its label. A Gateway model runs on no account.
fn role_choice(scope: &str, role: &'static str, value: &ModelChoice, accounts: &[Capability], on_change: Rc<dyn Fn(ModelChoice, &mut App)>, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    let models = model_choices(role, accounts, value);
    let labels = account_labels(&labeled(accounts));
    let options: Vec<Opt> = models.iter().map(|m| Opt::new(key_of(m), m.id.clone()).in_group(provider_label(&m.provider))).collect();
    let pick_change = on_change.clone();
    let mut out = vec![kit::pick(
        format!("{scope}-{role}-model"),
        format!("{} model", super::role_choices::role_label(role)),
        options,
        &key_of(value),
        true,
        move |key, _, cx| {
            if let Some(picked) = models.iter().find(|m| key_of(m) == key) {
                pick_change(picked.clone(), cx);
            }
        },
        window,
        cx,
    )];
    if value.provider != "gateway" {
        let mut options = vec![Opt::new("", "Auto")];
        options.extend(account_choices(role, value, accounts).into_iter().map(|host| {
            let label = labels.get(&host).cloned().unwrap_or_else(|| host.clone());
            Opt::new(host, label)
        }));
        let (provider, id) = (value.provider.clone(), value.id.clone());
        out.push(kit::select(
            format!("{scope}-{role}-account"),
            format!("{} account", super::role_choices::role_label(role)),
            options,
            value.account.as_deref().unwrap_or(""),
            true,
            move |account, _, cx| on_change(ModelChoice { provider: provider.clone(), id: id.clone(), account: (!account.is_empty()).then(|| account.to_string()) }, cx),
            window,
            cx,
        ));
    }
    out
}

/// A profile's roles while it's in edit.
struct FormRoles(Roles);

/// A profile in edit: its name and each role's model and account. New and Duplicate start from a
/// copy of another; Save keeps it, a rename included.
fn profile_form(profile: &NamedProfile, creating: bool, view: &ModelsView, editing: Entity<Editing>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let key = format!("{}:{creating}", profile.name);
    let saving = act::act(format!("profile-form-{key}"), window, cx);
    let names: Vec<String> = view.profiles.iter().map(|p| p.name.clone()).collect();
    let start = if creating { copy_name(&profile.name, &names) } else { profile.name.clone() };
    let name_field = kit::field(eid(format!("profile-form-name-{key}")), &start, "", window, cx);
    let start_roles = profile.roles.clone();
    let roles = window.use_keyed_state(eid(format!("profile-form-roles-{key}")), cx, move |_, _| FormRoles(start_roles));
    let current = roles.read(cx).0.clone();
    let (pending, error) = {
        let a = saving.read(cx);
        (a.pending, a.error.clone())
    };
    let can = profile_ok(&NamedProfile { name: name_field.read(cx).get_value().to_string(), roles: current.clone() });
    let previous = (!creating).then(|| profile.name.clone());
    let submit = {
        let (name_field, roles, saving, editing) = (name_field.clone(), roles.clone(), saving.clone(), editing.clone());
        move |cx: &mut App| {
            let value = NamedProfile { name: name_field.read(cx).get_value().to_string(), roles: roles.read(cx).0.clone() };
            if !profile_ok(&value) || saving.read(cx).pending {
                return;
            }
            let editing = editing.clone();
            let task = model(cx).update(cx, |m, cx| m.save_profile(SaveProfile { name: value.name, roles: value.roles, previous: previous.clone() }, cx));
            act::settle(&saving, task, move |_, cx| set_editing(&editing, None, cx), cx);
        }
    };
    let enter = submit.clone();
    let mut rows: Vec<AnyElement> = vec![
        kit::setting("Name", W32, &l)
            .child(
                kit::controls().child(
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
                        .on_key_down(move |e: &KeyDownEvent, _, cx| {
                            if e.keystroke.key == "enter" {
                                enter(cx);
                                cx.stop_propagation();
                            }
                        })
                        .child(Input::root(&name_field, cx).aria_label("Profile name").w_full()),
                ),
            )
            .into_any_element(),
    ];
    for role in EDITABLE {
        let held = roles.clone();
        let change: Rc<dyn Fn(ModelChoice, &mut App)> = Rc::new(move |choice, cx| {
            held.update(cx, |r, cx| {
                r.0 = role_with(&r.0, role, choice);
                cx.notify();
            })
        });
        let choice = role_choice(&format!("profile-form-{key}"), role, role_get(&current, role), &view.accounts, change, window, cx);
        rows.push(kit::setting(role_label(role), W32, &l).child(kit::controls().children(choice)).into_any_element());
    }
    let on = can && !pending;
    rows.push(
        kit::setting("", W32, &l)
            .child(
                kit::controls()
                    .child(kit::press(kit::button(eid(format!("profile-form-save-{key}")), Btn::Go, on, &l), on, move |_, _, cx| submit(cx)).aria_label("Save").child("Save"))
                    .child(kit::button(eid(format!("profile-form-cancel-{key}")), Btn::Flat, true, &l).on_click(move |_, _, cx| set_editing(&editing, None, cx)).aria_label("Cancel").child("Cancel"))
                    .when_some(error, |d, e| d.child(action_error(&e, &l))),
            )
            .into_any_element(),
    );
    kit::group(if creating { "New profile" } else { "Edit profile" }, None, rows, &l)
}
