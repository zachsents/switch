//! What a profile's roles can run on (the desktop's `settings/role-choices.ts`). Chat runs on any
//! model a signed-in subscription offers; triage, gate, decision and browse on those of
//! subscriptions that complete, and on Gateway's models for each. An account pins a role to one
//! subscription; none (Auto) spreads it across every account that can serve it. Pictures run on
//! Gateway's image models only.

use super::accounts::launch_label;
use crate::queries::{Capability, ModelChoice, Roles};

/// The roles a profile maps, in order, and their names.
pub const EDITABLE: [&str; 6] = ["turn", "triage", "gate", "decision", "browse", "image"];

pub fn role_label(role: &str) -> &'static str {
    match role {
        "turn" => "Chat",
        "triage" => "Triage",
        "gate" => "Gate",
        "decision" => "Decision",
        "browse" => "Browse",
        _ => "Image",
    }
}

/// A role's model in a profile.
pub fn role_get<'a>(roles: &'a Roles, role: &str) -> &'a ModelChoice {
    match role {
        "turn" => &roles.turn,
        "triage" => &roles.triage,
        "gate" => &roles.gate,
        "decision" => &roles.decision,
        "browse" => &roles.browse,
        _ => &roles.image,
    }
}

/// The roles with one role's model changed.
pub fn role_with(roles: &Roles, role: &str, c: ModelChoice) -> Roles {
    let mut r = roles.clone();
    match role {
        "turn" => r.turn = c,
        "triage" => r.triage = c,
        "gate" => r.gate = c,
        "decision" => r.decision = c,
        "browse" => r.browse = c,
        _ => r.image = c,
    }
    r
}

/// A provider's name: a subscription's, Claude Code's as Claude's, the Gateway's.
pub fn provider_label(provider: &str) -> String {
    match provider {
        "claude-code" => "Claude".into(),
        "gateway" => "Gateway".into(),
        p => launch_label(p).map(str::to_string).unwrap_or_else(|| p.to_string()),
    }
}

fn serves(role: &str, a: &Capability) -> bool {
    role != "image" && a.available && (role == "turn" || a.completion == Some(true))
}

const COMPLETION_MODELS: [&str; 3] = ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"];
const IMAGE_MODELS: [&str; 15] = [
    "openai/gpt-image-2.6-sunburst",
    "openai/gpt-image-2.6-flare",
    "openai/gpt-image-1-mini",
    "google/gemini-3-pro-image",
    "google/gemini-3.1-flash-image",
    "google/gemini-3.1-flash-lite-image",
    "bfl/flux-3-image",
    "bfl/flux-3-image-klein",
    "bfl/flux-kontext-max",
    "bytedance/seedream-5.5",
    "recraft/recraft-v4.1",
    "recraft/recraft-v4.1-pro",
    "spacexai/grok-imagine-image-2.0",
    "microsoft/mai-image-2.7",
    "meta/muse-image-1.0",
];
const DECISION_MODELS: [&str; 2] = ["openai/gpt-6-luna-decisions", "typesafe-ai/jev"];
const BROWSE_MODELS: [&str; 2] = ["openai/gpt-6-luna-decisions", "typesafe-ai/jev"];

fn gateway_models(role: &str) -> &'static [&'static str] {
    match role {
        "turn" => &[],
        "triage" | "gate" => &COMPLETION_MODELS,
        "decision" => &DECISION_MODELS,
        "browse" => &BROWSE_MODELS,
        _ => &IMAGE_MODELS,
    }
}

/// A choice's key in a list.
pub fn key_of(c: &ModelChoice) -> String {
    format!("{}:{}", c.provider, c.id)
}

/// Every model a role can run on, by provider; the current one too, offered or not.
pub fn model_choices(role: &str, accounts: &[Capability], current: &ModelChoice) -> Vec<ModelChoice> {
    let choice = |provider: &str, id: &str| ModelChoice { provider: provider.to_string(), id: id.to_string(), account: None };
    let offered = accounts.iter().filter(|a| serves(role, a)).flat_map(|a| a.models.iter().map(move |id| choice(if a.provider == "claude" { "claude-code" } else { &a.provider }, id)));
    let gateway = gateway_models(role).iter().map(|id| choice("gateway", id));
    let mut out: Vec<ModelChoice> = vec![];
    for m in offered.chain(gateway).chain([choice(&current.provider, &current.id)]) {
        if !out.iter().any(|o| key_of(o) == key_of(&m)) {
            out.push(m);
        }
    }
    out
}

/// The accounts that can serve a role's model; the one it's pinned to too.
pub fn account_choices(role: &str, choice: &ModelChoice, accounts: &[Capability]) -> Vec<String> {
    let provider = if choice.provider == "claude-code" { "claude" } else { &choice.provider };
    let able = accounts.iter().filter(|a| a.provider == provider && serves(role, a) && a.models.contains(&choice.id)).map(|a| a.host.clone());
    let mut out: Vec<String> = vec![];
    for h in able.chain(choice.account.clone()) {
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// A new profile's name from another's: "claude copy", then "claude copy 2" and on.
pub fn copy_name(name: &str, profiles: &[String]) -> String {
    let base = format!("{name} copy");
    let mut candidate = base.clone();
    let mut n = 2;
    while profiles.contains(&candidate) {
        candidate = format!("{base} {n}");
        n += 1;
    }
    candidate
}
