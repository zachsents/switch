//! Every command and write the window sends, as one typed API on `Model` (with the chat's own in
//! `model.rs`: `post_message`, `read`, `react`, `edit_message`, `retry`, `stop`, `steer`, `forget`): the desktop's
//! `mutations.ts`, `item-mutations.ts`, `models.ts`, `providers.ts`, `accounts.ts`, and the views'
//! own (`devices.ts`, `extensions.ts`, `connections.ts`, `set-mutation.ts`, `widgets/call.ts`).
//! Each payload is a typed struct, so what doesn't match its command's schema can't be built; what
//! the window shows at once is put in the brain first, and put back where the brain says no. Each
//! returns a task that resolves with the seq (or the answer) or the reason, for a view's pending
//! and error states.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::HashMap;

use base64::Engine;
use gpui::{Context, Task};
use serde::Serialize;
use serde_json::{Value, json};

use crate::brain::HOME;
use crate::files::{Chosen, Upload};
use crate::items::{ActionItem, Call};
use crate::model::Model;
use crate::net::{Answer, Net};
use crate::outbox::{self, Entry, now_ms};
use crate::queries::{self, ModelsView, NamedProfile, Roles};

/// A stretch of a text the user dictated rather than typed: where it starts, in code points, and its
/// words as they stand in the text.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct Dictated {
    pub start: f64,
    pub text: String,
}

/// The palette's commands, each with what it changes on screen before the brain answers.
#[derive(Clone, Debug)]
pub enum Act {
    /// `parent` none is the top level.
    Create { id: String, name: String, parent: Option<String>, about: Option<String> },
    Archive { id: String },
    Unarchive { id: String },
    Rename { id: String, name: String },
    Move { id: String, parent: Option<String> },
    /// The latest exchange in `from` becomes a new space inside it.
    Split { id: String, from: String, name: Option<String> },
    Reopen { id: String },
}

impl Act {
    fn name(&self) -> &'static str {
        match self {
            Act::Create { .. } => "space.create",
            Act::Archive { .. } => "space.archive",
            Act::Unarchive { .. } => "space.unarchive",
            Act::Rename { .. } => "space.rename",
            Act::Move { .. } => "space.move",
            Act::Split { .. } => "space.split",
            Act::Reopen { .. } => "item.reopen",
        }
    }

    fn payload(&self) -> Value {
        match self {
            Act::Create { id, name, parent, about } => {
                let mut p = json!({ "id": id, "name": name, "parent": parent });
                if let Some(a) = about {
                    p["about"] = json!(a);
                }
                p
            }
            Act::Archive { id } | Act::Unarchive { id } | Act::Reopen { id } => json!({ "id": id }),
            Act::Rename { id, name } => json!({ "id": id, "name": name }),
            Act::Move { id, parent } => json!({ "id": id, "parent": parent }),
            Act::Split { id, from, name } => {
                let mut p = json!({ "id": id, "from": from });
                if let Some(n) = name {
                    p["name"] = json!(n);
                }
                p
            }
        }
    }
}

/// An answer to an item: Approve or Decline, the option picked, the words typed, each draft as
/// approved, and which drafts the user changed.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ItemAnswer {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drafts: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAs {
    Done,
    Dismissed,
}

/// What the user did with an item, held a moment for Undo before it goes.
#[derive(Clone, Debug)]
pub enum Done {
    Answer(ItemAnswer),
    Close { id: String, status: CloseAs },
}

impl Done {
    /// The command it is, as kept in the outbox while it's held.
    pub fn command(&self) -> (&'static str, Value) {
        match self {
            Done::Answer(a) => ("item.answer", serde_json::to_value(a).unwrap_or_default()),
            Done::Close { id, status } => ("item.close", json!({ "id": id, "status": status })),
        }
    }
}

/// Adding a provider on the core's machine: a provider's own account, a named account in a home of
/// its own, or an agent from the ACP Registry, installed.
#[derive(Clone, Debug)]
pub enum Adding {
    Account { provider: String, id: String },
    Provider { provider: String },
    Agent { agent_id: String, version: String, distribution: String },
}

/// A profile kept: in place of `previous` (renamed too), or new.
#[derive(Clone, Debug, Serialize)]
pub struct SaveProfile {
    pub name: String,
    pub roles: Roles,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

/// The link an iPhone pairs by.
#[derive(Clone, Debug)]
pub struct Offer {
    pub link: String,
    pub until: f64,
    pub made: f64,
}

/// What a tool's answer said went wrong, when it did.
fn tool_error(answer: &Value) -> Option<String> {
    (answer.get("isError") == Some(&Value::Bool(true))).then(|| {
        answer.get("content").and_then(|c| c.get(0)).and_then(|c| c.get("text")).and_then(Value::as_str).unwrap_or("Didn't go through").to_string()
    })
}

/// What a route said when it said no: its own words (`{ error }` or plain), else `fallback`.
fn refusal(a: &Answer, fallback: &str) -> String {
    let text = a.text();
    if text.is_empty() { fallback.into() } else { text }
}

/// What a provider route said when it said no (`{ error }`), else "Didn't go through".
fn failure(a: &Answer) -> String {
    a.json().get("error").and_then(Value::as_str).unwrap_or("Didn't go through").to_string()
}

async fn joined(job: tokio::task::JoinHandle<Result<Answer, String>>) -> Result<Answer, String> {
    job.await.unwrap_or_else(|_| Err("Can't reach the core".into()))
}

/// Seals `secret` to a sealed ask's key, bound to its item and use: HPKE base mode, single shot,
/// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (switch-ext-kit's `seal`).
fn seal(key: &str, item: &str, use_: &str, secret: &str) -> Result<Value, String> {
    use hpke::{Deserializable, Kem as _, OpModeS, Serializable, aead::AesGcm256, kdf::HkdfSha256, kem::X25519HkdfSha256};
    let b64 = base64::engine::general_purpose::STANDARD;
    let raw = b64.decode(key).map_err(|_| "It isn't sealed")?;
    let recipient = <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(&raw).map_err(|_| "It isn't sealed")?;
    let mut info = b"switch-sealed-v1".to_vec();
    info.push(0);
    info.extend(item.as_bytes());
    info.push(0);
    info.extend(use_.as_bytes());
    let mut rng = rand::rng();
    let (enc, ct) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, X25519HkdfSha256, _>(&OpModeS::Base, &recipient, &info, secret.as_bytes(), &[], &mut rng)
        .map_err(|_| "Didn't seal")?;
    let _ = X25519HkdfSha256::KEM_ID;
    Ok(json!({ "enc": b64.encode(enc.to_bytes()), "ct": b64.encode(ct) }))
}

impl Model {
    /// A command over the socket, kept on this Mac until the brain answers, as a task; under `id`
    /// when given, so a resend is the same command.
    pub fn send(&self, name: &str, payload: Value, id: Option<String>, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let rx = cx.global::<Net>().command(id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()), name, payload);
        cx.background_executor().spawn(async move { rx.await.unwrap_or_else(|_| Err("Didn't go through".into())) })
    }

    /// UI analytics and reports: best effort, never a word on screen.
    pub fn emit(&self, event: &str, payload: Value, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let rx = cx.global::<Net>().emit(event, payload, None);
        cx.background_executor().spawn(async move { rx.await.unwrap_or_else(|_| Err("Didn't go through".into())) })
    }

    fn http(&self, job: tokio::task::JoinHandle<Result<Answer, String>>, fallback: &'static str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        cx.background_executor().spawn(async move {
            let a = joined(job).await?;
            if a.ok() { Ok(a.json()) } else { Err(refusal(&a, fallback)) }
        })
    }

    /// A message the core said no to, back in its box and out of the chat.
    pub fn restore(&mut self, id: &str, place: &str) {
        outbox::restore(id, place);
    }

    /// Chosen files, each kept here and uploading at once (once), so its chip shows how it's going.
    pub fn choose(&mut self, files: Vec<Chosen>, cx: &mut Context<Self>) -> Vec<Chosen> {
        for c in &files {
            // One up or going up already (its draft back after an edit) isn't sent again: the
            // desktop's upload query is the file's, by its id.
            if !matches!(self.uploads.get(&c.id), Some(Upload::Up(_) | Upload::Going)) {
                self.upload(c.clone(), 2, cx);
            }
        }
        files
    }

    /// A chosen file's upload: tried three times (again after 1 s, then 2 s, as the desktop's query
    /// retries), its bytes read from disk as they go up.
    fn upload(&mut self, c: Chosen, tries: u32, cx: &mut Context<Self>) {
        self.uploads.insert(c.id.clone(), Upload::Going);
        let net = cx.global::<Net>().clone();
        let job = {
            let (c, net) = (c.clone(), net.clone());
            cx.global::<Net>().rt.spawn(async move {
                let a = net.auth().ok_or(crate::files::UploadError::Later("Can't reach the core".into()))?;
                crate::files::upload(&net.client(), &a.core, &a.token, &c.id, &c.name, &c.kind).await
            })
        };
        cx.spawn(async move |this, cx| {
            let got = match job.await {
                Ok(got) => got,
                Err(_) => Err(crate::files::UploadError::Later("Didn't upload".into())),
            };
            let failed = got.is_err();
            if failed && tries > 0 {
                let wait = if tries == 2 { 1 } else { 2 };
                cx.background_executor().timer(std::time::Duration::from_secs(wait)).await;
                this.update(cx, |m, cx| m.upload(c, tries - 1, cx)).ok();
                return;
            }
            this.update(cx, |m, cx| {
                let state = match got {
                    Ok(a) => Upload::Up(a),
                    Err(e) => Upload::Failed { reason: e.reason().into(), refused: matches!(e, crate::files::UploadError::Refused(_)) },
                };
                m.uploads.insert(c.id.clone(), state);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A palette command: its change shows at once, and is undone where the brain says no
    /// (whatever landed meanwhile stays).
    pub fn act(&mut self, act: Act, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let id = match &act {
            Act::Reopen { .. } => HOME.to_string(),
            Act::Create { id, .. } | Act::Archive { id } | Act::Unarchive { id } | Act::Rename { id, .. } | Act::Move { id, .. } | Act::Split { id, .. } => id.clone(),
        };
        let was = self.brain.spaces.get(&id).cloned();
        match &act {
            Act::Create { id, name, parent, .. } => self.brain.made_space(id, name, Some(parent.as_deref().unwrap_or(HOME))),
            Act::Split { id, from, name } => self.brain.made_space(id, name.as_deref().unwrap_or_default(), Some(from)),
            Act::Archive { id } | Act::Unarchive { id } => {
                if let Some(s) = self.brain.spaces.get_mut(id) {
                    s.archived = matches!(act, Act::Archive { .. });
                }
            }
            Act::Rename { id, name } => {
                if let Some(s) = self.brain.spaces.get_mut(id) {
                    s.name = name.trim().to_string();
                }
            }
            Act::Move { id, parent } => {
                if let Some(s) = self.brain.spaces.get_mut(id) {
                    s.parent = Some(parent.clone().unwrap_or_else(|| HOME.into()));
                }
            }
            // It comes back whole with `item.reopened`.
            Act::Reopen { .. } => {}
        }
        self.brain.version += 1;
        self.refresh();
        cx.notify();
        let made = matches!(act, Act::Create { .. } | Act::Split { .. });
        let task = self.send(act.name(), act.payload(), None, cx);
        cx.spawn(async move |this, cx| {
            let got = task.await;
            if got.is_err() {
                this.update(cx, |m, cx| {
                    if made {
                        m.brain.spaces.remove(&id);
                    } else if let Some(s) = was {
                        m.brain.spaces.insert(s.id.clone(), s);
                    }
                    m.brain.version += 1;
                    m.refresh();
                    cx.notify();
                })
                .ok();
            }
            got
        })
    }

    /// The user's own words for a memory.
    pub fn edit_memory(&self, id: &str, description: &str, body: &str, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let task = self.send("memory.edit", json!({ "id": id, "description": description, "body": body }), None, cx);
        cx.spawn(async move |_, cx| {
            let got = task.await;
            if got.is_ok() {
                cx.update(|cx| queries::invalidate("memories", cx));
            }
            got
        })
    }

    /// A preference set in the brain, for every client; it shows at once.
    pub fn set_pref(&mut self, key: &str, value: Value, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        self.brain.prefs.insert(key.into(), value.clone());
        self.brain.version += 1;
        self.refresh();
        cx.notify();
        self.send("pref.set", json!({ "key": key, "value": value }), None, cx)
    }

    /// What the user did with an item, kept at once and due in `ms` (Undo drops it first); under
    /// `id`, so a resend after a relaunch is the same command.
    pub fn hold(&self, id: &str, done: &Done, ms: u64) {
        let (name, payload) = done.command();
        outbox::keep(Entry { due: Some(now_ms() + ms as f64), ..Entry::command(id, name, payload) });
    }

    /// Undo: what was held goes nowhere.
    pub fn unhold(&self, id: &str) {
        outbox::drop(id, false);
    }

    /// What was held, sent now under its id.
    pub fn done(&self, id: &str, done: &Done, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let (name, payload) = done.command();
        self.send(name, payload, Some(id.into()), cx)
    }

    /// The user's own version of an item's drafts, saved as he types: not an approval.
    pub fn edit_item(&self, id: &str, item: &str, drafts: HashMap<String, String>, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        self.send("item.edit", json!({ "id": item, "drafts": drafts }), Some(id.into()), cx)
    }

    /// An edit kept on this Mac at once, due to be sent in `ms`; under `id`, it replaces.
    pub fn keep_edit(&self, id: &str, item: &str, drafts: &HashMap<String, String>, ms: u64) {
        outbox::keep(Entry { due: Some(now_ms() + ms as f64), ..Entry::command(id, "item.edit", json!({ "id": item, "drafts": drafts })) });
    }

    /// An item's edit kept here and not yet answered by the brain, the newest: its id and drafts.
    pub fn kept_edit(&self, item: &str) -> Option<(String, HashMap<String, String>)> {
        let k = outbox::latest("item.edit", |p| p.get("id").and_then(Value::as_str) == Some(item))?;
        let drafts = serde_json::from_value(k.payload.get("drafts")?.clone()).ok()?;
        Some((k.id, drafts))
    }

    /// Its card opened: the core brings each draft's copy (an email draft) and the card to one version.
    pub fn item_drafts(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        if outbox::quiet() {
            return Task::ready(Ok(Value::Null));
        }
        let job = cx.global::<Net>().send_http(reqwest::Method::POST, format!("/items/{}/drafts", urlencode(id)), None);
        self.http(job, "Didn't go through", cx)
    }

    pub fn reopen(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        self.send("item.reopen", json!({ "id": id }), None, cx)
    }

    /// Words on an item, to the work that raised it: a message in its space that names the item.
    pub fn reply_on(&self, space: &str, text: &str, item: &str, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        self.send("message.post", json!({ "space": space, "text": text, "item": item }), None, cx)
    }

    /// A sealed answer: sealed here to the item's one-time key, and only the sealed bytes leave, to
    /// the core, which hands them to the extension that asked. Nothing of the secret is kept, and
    /// it's never sent again.
    pub fn answer_sealed(&self, item: &ActionItem, secret: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let Some(s) = &item.sealed else { return Task::ready(Err("It isn't sealed".into())) };
        let sealed = match seal(&s.key, &item.id, &s.usage, secret) {
            Ok(v) => v,
            Err(e) => return Task::ready(Err(e)),
        };
        let job = cx.global::<Net>().post(format!("/items/{}/sealed", urlencode(&item.id)), &sealed);
        self.http(job, "Didn't go through", cx)
    }

    /// An extension's tool, through the brain's `/widgets`: its MCP result.
    pub fn call_tool(&self, app: &str, tool: &str, args: Value, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let args = if args.is_null() { json!({}) } else { args };
        let job = cx.global::<Net>().post(format!("/widgets/{app}/{tool}"), &args);
        // An answer that isn't JSON is as good as none.
        cx.background_executor().spawn(async move { serde_json::from_slice(&joined(job).await?.body).map_err(|_| "Can't reach the core".to_string()) })
    }

    /// An app's tool for a write: its answer, or what it said went wrong.
    pub fn call_checked(&self, app: &str, tool: &str, args: Value, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let call = self.call_tool(app, tool, args, cx);
        cx.background_executor().spawn(async move {
            let answer = call.await.map_err(|_| "Can't reach the core".to_string())?;
            match tool_error(&answer) {
                Some(e) => Err(e),
                None => Ok(answer),
            }
        })
    }

    /// What a Pick's Set calls: the extension's tool for it, with what it's always given.
    pub fn widget_set(&self, call: &Call, values: HashMap<String, String>, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let mut args = call.args.as_object().cloned().unwrap_or_default();
        for (k, v) in values {
            args.insert(k, Value::String(v));
        }
        self.call_checked(&call.app, &call.tool, Value::Object(args), cx)
    }

    pub fn install_extension(&self, source: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.call_checked("extensions", "install", json!({ "source": source }), cx)
    }

    pub fn update_extension(&self, extension: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.call_checked("extensions", "update", json!({ "extension": extension }), cx)
    }

    pub fn remove_extension(&self, extension: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.call_checked("extensions", "remove", json!({ "extension": extension }), cx)
    }

    /// Whether a connection still works.
    pub fn verify_connection(&self, provider: &str, account: Option<&str>, cx: &mut Context<Self>) -> Task<Result<bool, String>> {
        let mut p = json!({ "provider": provider });
        if let Some(a) = account {
            p["account"] = json!(a);
        }
        let call = self.call_checked("connections", "verify", p, cx);
        cx.background_executor().spawn(async move {
            call.await?
                .pointer("/structuredContent/connected")
                .and_then(Value::as_bool)
                .ok_or_else(|| "Could not verify the connection. Try again.".to_string())
        })
    }

    pub fn disconnect(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.call_checked("connections", "disconnect", json!({ "id": id }), cx)
    }

    /// Approving, denying or revoking a credential on the core's /auth routes.
    pub fn credential(&self, route: &str, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let job = cx.global::<Net>().post(format!("/auth/{route}"), &json!({ "id": id }));
        self.http(job, "Didn't go through", cx)
    }

    pub fn approve(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.credential("approve", id, cx)
    }

    pub fn deny(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.credential("deny", id, cx)
    }

    pub fn revoke(&self, id: &str, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        self.credential("revoke", id, cx)
    }

    /// The link an iPhone pairs by: this core's address and a one-time offer.
    pub fn offer(&self, cx: &mut Context<Self>) -> Task<Result<Offer, String>> {
        let job = cx.global::<Net>().post("/auth/offer", &json!({ "scopes": ["client"] }));
        let asked = self.http(job, "Didn't go through", cx);
        cx.background_executor().spawn(async move {
            let v = asked.await?;
            let (offer, core) = (v["offer"].as_str().unwrap_or_default(), v["core"].as_str().unwrap_or_default());
            let link = format!("switchboard://pair?core={}&offer={}", urlencode(core), urlencode(offer));
            Ok(Offer { link, until: v["until"].as_f64().unwrap_or(0.), made: now_ms() })
        })
    }

    /// The model profile the agent runs on, shown at once.
    pub fn select_profile(&self, name: &str, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let n = name.to_string();
        self.optimistic_models(move |v| v.active = n, "profile.select", json!({ "name": name }), cx)
    }

    /// A profile kept, in place of what it was (renamed too) or new; a name that's taken, the core
    /// refuses, so it shows nothing.
    pub fn save_profile(&self, p: SaveProfile, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let payload = serde_json::to_value(&p).unwrap_or_default();
        self.optimistic_models(
            move |v| {
                if v.profiles.iter().any(|x| x.name == p.name && Some(&x.name) != p.previous.as_ref()) {
                    return;
                }
                let was = p.previous.clone().unwrap_or_else(|| p.name.clone());
                if v.active.as_str() == p.previous.as_deref().unwrap_or("\u{0}") {
                    v.active = p.name.clone();
                }
                v.profiles.retain(|x| x.name != was);
                v.profiles.push(NamedProfile { name: p.name.clone(), roles: p.roles.clone() });
                v.profiles.sort_by(|a, b| a.name.cmp(&b.name));
            },
            "profile.save",
            payload,
            cx,
        )
    }

    pub fn delete_profile(&self, name: &str, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let n = name.to_string();
        self.optimistic_models(move |v| v.profiles.retain(|p| p.name != n), "profile.delete", json!({ "name": name }), cx)
    }

    /// A change to the model profiles shown at once, put back if the core refuses it, and read
    /// again once it's through (without holding it up: /models asks every provider first).
    fn optimistic_models(&self, change: impl FnOnce(&mut ModelsView), name: &str, payload: Value, cx: &mut Context<Self>) -> Task<Result<u64, String>> {
        let before = queries::data::<ModelsView>(queries::MODELS, cx);
        if let Some(b) = &before {
            let mut next = (**b).clone();
            change(&mut next);
            queries::set::<ModelsView>(queries::MODELS, next, cx);
        }
        let task = self.send(name, payload, None, cx);
        cx.spawn(async move |_, cx| {
            let got = task.await;
            cx.update(|cx| {
                if got.is_err()
                    && let Some(b) = before
                {
                    queries::set::<ModelsView>(queries::MODELS, (*b).clone(), cx);
                }
                queries::invalidate(queries::MODELS, cx);
            });
            got
        })
    }

    /// A provider route; a body as JSON.
    fn provider_request(&self, route: &str, body: Option<Value>, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let net = cx.global::<Net>();
        let job = match body {
            Some(b) => net.post(route, &b),
            None => net.get(route),
        };
        cx.background_executor().spawn(async move {
            let a = joined(job).await?;
            if a.ok() { Ok(a.json()) } else { Err(failure(&a)) }
        })
    }

    /// An account route (OAuth stays on private HTTP); what failed says only the core's words.
    pub fn account_request(&self, route: &str, body: Option<Value>, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        let net = cx.global::<Net>();
        let job = match body {
            Some(b) => net.post(route, &b),
            None => net.get(route),
        };
        cx.background_executor().spawn(async move {
            let a = job.await.unwrap_or_else(|_| Err(String::new())).map_err(|_| "Accounts connection failed".to_string())?;
            if !a.ok() {
                return Err(a.json().get("error").and_then(Value::as_str).unwrap_or("Account operation failed").to_string());
            }
            Ok(a.json())
        })
    }

    /// Adds it; the accounts are read again before it settles, so what's added can be picked at
    /// once; the catalog and the registry after. The account it made, by id.
    pub fn add_provider(&self, adding: Adding, cx: &mut Context<Self>) -> Task<Result<String, String>> {
        let (task, made) = match &adding {
            Adding::Account { provider, id } => (self.account_request("/auth/accounts", Some(json!({ "provider": provider, "id": id })), cx), id.clone()),
            Adding::Provider { provider } => (self.provider_request("/providers/add", Some(json!({ "provider": provider })), cx), provider.clone()),
            Adding::Agent { agent_id, version, distribution } => (
                self.provider_request("/providers/registry/install", Some(json!({ "agentId": agent_id, "version": version, "distribution": distribution })), cx),
                format!("acp-{agent_id}"),
            ),
        };
        cx.spawn(async move |_, cx| {
            let got = task.await;
            let accounts = cx.update(|cx| {
                queries::invalidate(queries::MODELS, cx);
                queries::invalidate(queries::REGISTRY, cx);
                queries::refetch(queries::ACCOUNTS, cx)
            });
            accounts.await;
            got.map(|_| made)
        })
    }

    /// An account added, by an id the core makes, and its sign-in started when its CLI is there.
    pub fn add_account(&self, provider: &str, sign_in: bool, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let added = self.account_request("/auth/accounts", Some(json!({ "provider": provider })), cx);
        cx.spawn(async move |this, cx| {
            let got: Result<(), String> = async {
                let v = added.await?;
                let id = v.get("id").and_then(Value::as_str).ok_or("Account operation failed")?.to_string();
                if sign_in {
                    let start = this.update(cx, |m, cx| m.account_request(&format!("/auth/accounts/{}/start", urlencode(&id)), Some(json!({})), cx)).map_err(|_| "Account operation failed")?;
                    start.await?;
                }
                Ok(())
            }
            .await;
            let accounts = cx.update(|cx| {
                queries::invalidate(queries::MODELS, cx);
                queries::refetch(queries::ACCOUNTS, cx)
            });
            accounts.await;
            got
        })
    }
}

/// A path segment, escaped.
pub fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")
}

/// The message box can send: some words, or files, or both (forms.ts `messageForm`).
pub fn can_post(text: &str, files: usize) -> bool {
    !text.trim().is_empty() || files > 0
}

/// The steer box and an item's reply can send: some words (forms.ts `wordsForm`, `replyForm`).
pub fn has_words(text: &str) -> bool {
    !text.trim().is_empty()
}

/// A provider's failure, useful without callback addresses or credential values (safe-error.ts).
pub fn safe_error(message: &str) -> String {
    use std::sync::OnceLock;
    if message == "No google client" {
        return "Google connection is not configured on the server. Add a compatible Google OAuth client, then try Connect again.".into();
    }
    static RES: OnceLock<[regex_lite::Regex; 4]> = OnceLock::new();
    let [url, bearer, field, long] = RES.get_or_init(|| {
        [
            regex_lite::Regex::new(r#"(?i)https?://[^\s<>"']+"#).expect("re"),
            regex_lite::Regex::new(r"(?i)\bBearer\s+\S+").expect("re"),
            regex_lite::Regex::new(
                r#"(?i)\b(?P<field>["']?(?:(?:access|refresh|id)[_-]?token|token|secret|client[_-]?secret|api[_-]?key|authorization|password|code)["']?)\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)"#,
            )
            .expect("re"),
            regex_lite::Regex::new(r"[A-Za-z0-9_+/=-]{48,}").expect("re"),
        ]
    });
    let s = url.replace_all(message, "[URL hidden]");
    let s = bearer.replace_all(&s, "Bearer [hidden]");
    let s = field.replace_all(&s, "${field}=[hidden]");
    let s = long.replace_all(&s, "[hidden]");
    let cut = String::from_utf16_lossy(&s.encode_utf16().take(400).collect::<Vec<u16>>());
    if cut.is_empty() { "The action failed. Try again or check the connection in Settings.".into() } else { cut }
}

