//! Files shared from the iPhone's share sheet (the core's `draft.ts`, `draft.shared`): into the
//! draft being written on this Mac when the core names it, as a paste's files join it. The box in
//! front takes them (the composer while it's up, else the main window's page), or Home's when the
//! user is at no Mac. Each file's bytes come down from the blobs, kept as a pasted file's are and
//! already up under their blob, so its chip draws from here and nothing goes up again.

use gpui::App;
use serde_json::Value;

use crate::brain::{Attachment, Event};
use crate::files::{Chosen, Upload, type_of};
use crate::model::model;
use crate::net::Net;

/// A share for the box in front older than this when it's heard (a resume after an update) joins
/// none: it was meant for the draft being written then. One for Home's waits longer, for the Mac to
/// wake.
const FRESH_MS: f64 = 10. * 60_000.;
const HOME_FRESH_MS: f64 = 12. * 3_600_000.;

/// The live events' `draft.shared` for this Mac (or for any, when no Mac was named), heard as the
/// model folds them in.
pub fn heard(events: &[Event], cx: &mut App) {
    let now = crate::outbox::now_ms();
    for e in events.iter().filter(|e| e.kind == "draft.shared") {
        let p = &e.payload;
        let machine = p.get("machine").and_then(Value::as_str);
        if machine.is_some_and(|m| m != crate::terminal::mac()) {
            continue;
        }
        let home = machine.is_none() || p.get("home") == Some(&Value::Bool(true));
        if now - e.time > if home { HOME_FRESH_MS } else { FRESH_MS } {
            continue;
        }
        let files: Vec<Attachment> = p.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(attachment).collect();
        // After the model has folded them in: taking them updates it.
        let id = e.id.clone();
        cx.defer(move |cx| take(&id, files, home, cx));
    }
}

fn attachment(v: &Value) -> Option<Attachment> {
    let blob = crate::brain::hash_of(v.get("blob")?.as_str()?)?;
    let name = v.get("name")?.as_str()?.to_string();
    let kind = type_of(&name, v.get("type").and_then(Value::as_str).unwrap_or_default());
    Some(Attachment { blob, name, kind, size: v.get("size").and_then(Value::as_f64).unwrap_or(0.) })
}

/// Its files kept here under ids of the event's own, so one heard again (a relaunch, a resume)
/// joins no box twice.
fn take(event: &str, files: Vec<Attachment>, home: bool, cx: &mut App) {
    let net = cx.global::<Net>().clone();
    let Some(auth) = net.auth() else { return };
    let tag: String = event.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let mut chosen = vec![];
    for (n, a) in files.into_iter().enumerate() {
        let id = format!("shared-{tag}-{n}");
        if crate::outbox::file_path(&id).exists() {
            continue;
        }
        crate::files::keep_blob(&net.rt, net.client(), auth.core.clone(), auth.token.clone(), &id, &a.blob);
        let c = Chosen { id: id.clone(), name: a.name.clone(), kind: a.kind.clone(), size: a.size };
        model(cx).update(cx, |m, _| m.uploads.insert(id.clone(), Upload::Up(a.clone())));
        // Its link under the blob once its bytes are in, as a file sent from here has.
        cx.background_executor()
            .spawn(async move {
                crate::files::kept(&id).await;
                crate::own::up(&a.blob, &id, &a.name);
            })
            .detach();
        chosen.push(c);
    }
    if chosen.is_empty() {
        return;
    }
    let chosen = if home { chosen } else {
        match crate::composer::take_shared(chosen, cx) {
            Ok(()) => return,
            Err(back) => back,
        }
    };
    let Some(main) = crate::platform::lifecycle::main_window(cx).and_then(|w| w.downcast::<crate::app::Root>()) else { return };
    let _ = main.update(cx, |root, window, cx| root.take_shared(chosen, home, window, cx));
}
