//! Setup, for a Mac running the core this app carries (platform::standalone): what a first run
//! takes, on one page, each step a line with its state and the button that does it. Developer
//! tools (the python3 and git extensions run on), Claude (Providers' sign-in), this Mac's name (the
//! core's `machine`, the core restarted), extensions to add (the folders of `extensions/` in the
//! build's public repo, `SWITCH_EXTENSIONS_REPO`, but those `SWITCH_EXTENSIONS_HIDE` names), accounts
//! (Connections' cards) and, once the browser extension is in, its Chrome Web Store listing, with
//! Chrome's Load unpacked beside it until the listing is live. It opens by
//! itself at launch until Done.

use std::path::PathBuf;
use std::process::Command;

use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, prelude::*};
use serde_json::Value;

use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::model::model;
use crate::nav::Beat;
use crate::settings::calls::{act, land, mounted};
use crate::settings::parts::{data, line, notice, section};

/// The public repo whose `extensions/` folders Setup offers, as owner/repo.
const REPO: Option<&str> = option_env!("SWITCH_EXTENSIONS_REPO");
const HIDE: Option<&str> = option_env!("SWITCH_EXTENSIONS_HIDE");

fn dir() -> PathBuf {
    crate::platform::helpers::home().join(".switch")
}

fn done_mark() -> PathBuf {
    dir().join("setup-done")
}

/// Setup belongs in Settings: this Mac runs the core the app carries.
pub fn shown() -> bool {
    crate::platform::standalone::carried().is_some() && crate::platform::standalone::ours()
}

/// Settings opens at Setup by itself until it's done.
pub fn open_if_new(cx: &mut App) {
    if shown() && !done_mark().exists() && !crate::outbox::quiet() {
        super::open("setup", cx);
    }
}

fn tools_in() -> bool {
    Command::new("/usr/bin/xcode-select").arg("-p").output().is_ok_and(|o| o.status.success())
}

fn machine() -> String {
    std::fs::read_to_string(dir().join("config.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("machine").and_then(Value::as_str).map(str::to_string)).unwrap_or_default()
}

/// The name written into the core's config, the core restarted to take it.
fn name_mac(name: &str) -> Result<(), String> {
    let at = dir().join("config.json");
    let mut v: Value = std::fs::read_to_string(&at).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    v["machine"] = Value::String(name.to_string());
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    crate::platform::helpers::write_atomic(&at, text.as_bytes(), Some(0o600)).map_err(|e| e.to_string())?;
    crate::platform::standalone::restart();
    Ok(())
}

/// The browser extension's listing in the Chrome Web Store, as its `ids.json` names it.
fn store_url(folder: &std::path::Path) -> Option<String> {
    let ids: Value = serde_json::from_slice(&std::fs::read(folder.join("ids.json")).ok()?).ok()?;
    let id = ids.get("store")?.as_str().filter(|s| !s.is_empty())?;
    Some(format!("https://chromewebstore.google.com/detail/{id}"))
}

/// The browser extension's folder for Chrome's Load unpacked, once it's installed.
fn chrome_folder() -> Option<PathBuf> {
    let pkg = dir().join("extensions/browser/pkg/node_modules");
    std::fs::read_dir(&pkg).ok()?.flatten().map(|d| d.path().join("extension")).find(|p| p.join("manifest.json").exists())
}

#[derive(Clone, Debug)]
struct Offered {
    /// Its folder under extensions/.
    folder: String,
    /// The extension's name, as its manifest says.
    name: String,
    about: String,
}

#[derive(Default)]
struct Page {
    tools: Option<bool>,
    offered: Option<Result<Vec<Offered>, String>>,
    adding: Option<String>,
    error: Option<String>,
    named: Option<String>,
}

/// The repo's extensions: its `extensions/` folders (GitHub's contents API), each with its
/// package.json's manifest, but those hidden.
fn offered(cx: &mut App) -> gpui::Task<Result<Vec<Offered>, String>> {
    let Some(repo) = REPO.filter(|r| !r.is_empty()).map(str::to_string) else { return gpui::Task::ready(Ok(Vec::new())) };
    let net = cx.global::<crate::net::Net>().clone();
    let hide: Vec<String> = HIDE.unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let job = net.rt.spawn(async move {
        let http = reqwest::Client::builder().user_agent("switchboard").build().map_err(|e| e.to_string())?;
        let list = format!("https://api.github.com/repos/{repo}/contents/extensions");
        let all: Vec<Value> = http.get(list).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let folders: Vec<String> = all
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("dir"))
            .filter_map(|e| e.get("name").and_then(Value::as_str).map(str::to_string))
            .filter(|n| !hide.contains(n))
            .collect();
        let reads = folders.into_iter().map(|folder| {
            let (http, url) = (http.clone(), format!("https://raw.githubusercontent.com/{repo}/HEAD/extensions/{folder}/package.json"));
            async move {
                let pkg: Value = http.get(url).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
                let name = pkg.get("extension")?.get("name")?.as_str()?.to_string();
                let about = pkg.get("description").and_then(Value::as_str).unwrap_or("").to_string();
                Some(Offered { folder, name, about })
            }
        });
        let mut list: Vec<Offered> = futures::future::join_all(reads).await.into_iter().flatten().collect();
        list.sort_by(|a, b| a.folder.cmp(&b.folder));
        Ok::<_, String>(list)
    });
    cx.background_executor().spawn(async move { job.await.unwrap_or_else(|e| Err(e.to_string())) })
}

fn step(label: &'static str, state: impl Into<gpui::SharedString>, l: &Look) -> gpui::Div {
    line(l).child(div().w(u(120.)).flex_none().child(label)).child(data(state, None, l)).child(div().ml_auto())
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (page, fresh) = mounted("setup-page", window, cx, |_| Page::default());
    if fresh {
        let p = page.clone();
        land(&page, cx.background_executor().spawn(async move { Ok::<_, String>(tools_in()) }), |p, got, _| p.tools = got.ok(), cx);
        let task = offered(cx);
        land(&p, task, |p, got, _| p.offered = Some(got), cx);
    }
    let name = kit::field("setup-machine", &machine(), "Name", window, cx);
    let p = page.read(cx);
    let (tools, adding, error, named) = (p.tools, p.adding.clone(), p.error.clone(), p.named.clone());
    let list = p.offered.clone();

    let accounts = crate::queries::accounts(cx);
    let claude = accounts.data.as_ref().is_some_and(|a| a.accounts.iter().any(|x| x.provider == "claude" && matches!(x.status.as_str(), "connected" | "limited")));
    let installed: Vec<String> = model(cx).read(cx).brain.extension_info.values().map(|x| x.name.clone()).collect();
    let source = format!("github:{}", REPO.unwrap_or(""));

    let mut rows: Vec<AnyElement> = Vec::new();
    // Developer tools: python3 and git, which extensions run on.
    rows.push(
        step("Developer tools", match tools { Some(true) => "Installed", Some(false) => "Missing", None => "" }, &l)
            .when(tools == Some(false), |d| {
                let pg = page.clone();
                d.child(kit::press(kit::button("setup-tools", Btn::Go, true, &l), true, move |_, _, cx| {
                    let _ = Command::new("/usr/bin/xcode-select").arg("--install").spawn();
                    pg.update(cx, |p, cx| {
                        p.tools = None;
                        cx.notify();
                    });
                })
                .aria_label("Install").child("Install"))
            })
            .into_any_element(),
    );
    rows.push(
        step("Claude", if claude { "Signed in" } else { "Signed out" }, &l)
            .child(kit::press(kit::button("setup-claude", if claude { Btn::Key } else { Btn::Go }, true, &l), true, |_, _, cx| super::open("providers", cx)).aria_label("Providers").child("Providers"))
            .into_any_element(),
    );
    {
        let (pg, nm) = (page.clone(), name.clone());
        rows.push(
            line(&l)
                .child(div().w(u(120.)).flex_none().child("This Mac"))
                .child(div().flex_1().min_w_0().child(gpui::Styled::w_full(ui_sdk::components::input::Input::root(&name, cx).aria_label("Name"))))
                .when_some(named, |d, n| d.child(data(n, None, &l)))
                .child(kit::press(kit::button("setup-name", Btn::Key, true, &l), true, move |_, _, cx| {
                    let v = nm.read(cx).get_value().trim().to_string();
                    if v.is_empty() {
                        return;
                    }
                    let job = cx.background_executor().spawn(async move { name_mac(&v).map(|_| v) });
                    land(&pg, job, |p, got, _| match got {
                        Ok(_) => p.named = Some("Saved".into()),
                        Err(e) => p.error = Some(e),
                    }, cx);
                })
                .aria_label("Save").child("Save"))
                .into_any_element(),
        );
    }
    rows.push(
        step("Accounts", "", &l)
            .child(kit::press(kit::button("setup-accounts", Btn::Key, true, &l), true, |_, _, cx| super::open("connections", cx)).aria_label("Connections").child("Connections"))
            .into_any_element(),
    );

    let extensions: Vec<AnyElement> = match list {
        None => vec![line(&l).child(kit::spin(Beat::step(cx), &l)).into_any_element()],
        Some(Err(e)) => vec![notice(e, &l).into_any_element()],
        Some(Ok(list)) if list.is_empty() => vec![line(&l).text_color(l.ink3).child("None").into_any_element()],
        Some(Ok(list)) => list
            .into_iter()
            .map(|o| {
                let short = o.folder.clone();
                let has = installed.contains(&o.name);
                let busy = adding.as_deref() == Some(short.as_str());
                let (source, path) = (source.clone(), format!("extensions/{short}"));
                let on = !has && adding.is_none();
                let pg = page.clone();
                line(&l)
                    .id(ElementId::Name(format!("setup-ext-{short}").into()))
                    .child(div().w(u(120.)).flex_none().child(short.clone()))
                    .child(div().flex_1().min_w_0().truncate().text_color(l.ink3).child(o.about.clone()))
                    .child(if has {
                        data("Added", None, &l).into_any_element()
                    } else {
                        kit::press(kit::button(ElementId::Name(format!("setup-add-{short}").into()), Btn::Go, on, &l), on, move |_, _, cx| {
                            let (s, at, f) = (source.clone(), path.clone(), short.clone());
                            pg.update(cx, |p, cx| {
                                p.adding = Some(f);
                                p.error = None;
                                cx.notify();
                            });
                            act(&pg, move |m, cx| m.install_extension_at(&s, &at, cx), |p, got, _| {
                                p.adding = None;
                                p.error = got.err();
                            }, cx);
                        })
                        .when(busy, |d| d.child(kit::spin(Beat::step(cx), &l)))
                        .aria_label("Add")
                        .child("Add")
                        .into_any_element()
                    })
                    .into_any_element()
            })
            .collect(),
    };

    // Chrome: the browser extension's own part, from the Chrome Web Store, or loaded unpacked until
    // its listing is live.
    let chrome: Vec<AnyElement> = match chrome_folder() {
        None => Vec::new(),
        Some(folder) => {
            let f = folder.clone();
            let mut rows: Vec<AnyElement> = Vec::new();
            if let Some(url) = store_url(&folder) {
                rows.push(
                    step("", "Chrome Web Store", &l)
                        .child(kit::press(kit::button("setup-chrome-store", Btn::Go, true, &l), true, move |_, _, _| {
                            let _ = Command::new("/usr/bin/open").args(["-a", "Google Chrome", &url]).spawn();
                        })
                        .aria_label("Add to Chrome").child("Add to Chrome"))
                        .into_any_element(),
                );
                rows.push(step("", "Or", &l).into_any_element());
            }
            rows.extend([
                step("1", "chrome://extensions", &l)
                    .child(kit::press(kit::button("setup-chrome-open", Btn::Key, true, &l), true, |_, _, _| {
                        let _ = Command::new("/usr/bin/open").args(["-a", "Google Chrome", "chrome://extensions"]).spawn();
                    })
                    .aria_label("Open").child("Open"))
                    .into_any_element(),
                step("2", "Developer mode on", &l).into_any_element(),
                step("3", "Load unpacked", &l)
                    .child(kit::press(kit::button("setup-chrome-folder", Btn::Key, true, &l), true, move |_, _, _| {
                        let _ = Command::new("/usr/bin/open").arg("-R").arg(&f).spawn();
                    })
                    .aria_label("Show folder").child("Show folder"))
                    .into_any_element(),
                step("", folder.to_string_lossy().to_string(), &l).into_any_element(),
            ]);
            rows
        }
    };

    let finish = kit::press(kit::button("setup-done", Btn::Go, true, &l), true, |_, window, _| {
        let _ = crate::platform::helpers::write_atomic(&done_mark(), b"", None);
        window.remove_window();
    })
    .aria_label("Done")
    .child("Done");

    let body = div()
        .flex()
        .flex_col()
        .when_some(error, |d, e| d.child(notice(e, &l)))
        .child(section("Setup", None, rows, &l))
        .child(section("Extensions", None, extensions, &l))
        .when(!chrome.is_empty(), |d| d.child(section("Chrome", None, chrome, &l)))
        .child(line(&l).child(div().ml_auto()).child(finish));
    kit::pane_scroll("setup", None, body, window, cx)
}
