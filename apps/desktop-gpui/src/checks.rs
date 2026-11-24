//! Payloads checked against their commands' own schemas before they go (the desktop's
//! `mutations.ts` `valid`), for the fields those schemas constrain past their type: what fails
//! never leaves.

use serde_json::Value;

/// The providers a model profile's role may name (core/profiles.ts `ModelChoice`).
const PROVIDERS: &[&str] = &["gateway", "claude-code", "codex", "antigravity", "fx", "workers-ai", "cursor", "opencode", "grok", "kiro", "pi", "muse", "acp"];

/// Whether `p` reads as command `command`'s payload; what didn't read, when it doesn't.
pub fn checked(command: &str, p: &Value) -> Result<(), String> {
    let bad = |what: &str| Err(format!("Didn't read: {what}"));
    let string = |v: Option<&Value>| v.is_some_and(Value::is_string);
    let number = |v: Option<&Value>| v.is_some_and(|n| n.as_f64().is_some_and(f64::is_finite));
    let optional = |v: Option<&Value>, ok: &dyn Fn(&Value) -> bool| v.is_none_or(|x| ok(x));
    match command {
        "message.post" => {
            if !string(p.get("space")) || !string(p.get("text")) {
                return bad("space and text");
            }
            let atts = p.get("attachments").map(|a| a.as_array().is_some_and(|a| a.iter().all(|f| f.get("blob").and_then(Value::as_str).and_then(crate::brain::hash_of).is_some_and(|h| Some(h.as_str()) == f["blob"].as_str()) && string(f.get("name")) && string(f.get("type")) && number(f.get("size")))));
            if atts == Some(false) {
                return bad("attachments");
            }
            if !optional(p.get("dictated"), &|d| d.as_array().is_some_and(|d| d.iter().all(|x| number(x.get("start")) && string(x.get("text"))))) {
                return bad("dictated");
            }
            if !optional(p.get("replyTo"), &|r| {
                r.as_array().is_some_and(|r| {
                    r.iter().all(|x| match x.get("kind").and_then(Value::as_str) {
                        Some("quote") => number(x.get("seq")) && string(x.get("text")) && optional(x.get("reply"), &Value::is_string),
                        Some("ask") => string(x.get("id")) && optional(x.get("reply"), &Value::is_string),
                        _ => false,
                    })
                })
            }) {
                return bad("replyTo");
            }
            Ok(())
        }
        "message.react" => {
            let r = p.get("reaction");
            let ok = r.is_some_and(|r| r.is_null() || crate::brain::reaction_of(r).is_some());
            if !number(p.get("seq")) || !ok || !optional(p.get("quote"), &|q| string(q.get("text"))) {
                return bad("reaction");
            }
            Ok(())
        }
        "thread.steer" => {
            if !string(p.get("thread")) || !string(p.get("text")) || !optional(p.get("dictated"), &|d| d.as_array().is_some_and(|d| d.iter().all(|x| number(x.get("start")) && string(x.get("text"))))) {
                return bad("steer");
            }
            Ok(())
        }
        "message.edit" | "space.read" => {
            if !number(p.get("seq")) {
                return bad("seq");
            }
            Ok(())
        }
        "profile.save" | "profile.select" | "profile.delete" => {
            let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
            if !(1..=80).contains(&name.chars().count()) {
                return bad("name");
            }
            if let Some(roles) = p.get("roles") {
                let ok = ["turn", "triage", "gate", "decision", "browse"].iter().all(|r| roles.get(*r).is_some_and(|c| c.get("provider").and_then(Value::as_str).is_some_and(|v| PROVIDERS.contains(&v)) && c.get("id").and_then(Value::as_str).is_some_and(|i| (1..=80).contains(&i.chars().count()))));
                if !ok {
                    return bad("roles");
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
