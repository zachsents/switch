//! Provider accounts as Settings lists them (the desktop's `settings/accounts.ts`,
//! `use-providers.ts`, the core's `accountLabels` and the models package's providers): in
//! providers' order, each provider's own account first, then by name; how each stands; each one's
//! label; and the sections they make, a provider each (a registry agent one of its own), with its
//! CLI, its accounts and the models they offer.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::queries::{AccountView, Capability, CliView};

/// The subscriptions a turn can run on, in providers' order.
pub const SUBSCRIPTIONS: [&str; 11] = ["claude", "codex", "antigravity", "fx", "cursor", "opencode", "grok", "kiro", "pi", "muse", "acp"];

/// The providers whose accounts Switch adds, any number, each in a home of its own.
const LOGIN_PROVIDERS: [&str; 3] = ["claude", "codex", "fx"];

/// Whether accounts of `provider` can be added.
pub fn is_login_provider(provider: &str) -> bool {
    LOGIN_PROVIDERS.contains(&provider)
}

/// Each provider's name (`PROVIDER_LAUNCHES`' labels).
const LAUNCH_LABELS: [(&str, &str); 11] = [
    ("claude", "Claude"),
    ("codex", "Codex"),
    ("cursor", "Cursor"),
    ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"),
    ("grok", "Grok"),
    ("fx", "FX"),
    ("kiro", "Kiro"),
    ("pi", "Pi"),
    ("muse", "Muse"),
    ("acp", "ACP"),
];

pub fn launch_label(provider: &str) -> Option<&'static str> {
    LAUNCH_LABELS.iter().find(|(id, _)| *id == provider).map(|(_, l)| *l)
}

/// `localeCompare` for ids: letters alike whatever their case, a lowercase one first.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// Its own name: another machine's accounts are `<machine>:<name>`.
pub fn login_of(a: &AccountView) -> &str {
    a.id.strip_prefix(&format!("{}:", a.machine)).unwrap_or(&a.id)
}

fn rank(a: &AccountView) -> usize {
    SUBSCRIPTIONS.iter().position(|s| *s == a.provider).unwrap_or(SUBSCRIPTIONS.len())
}

/// In providers' order, each provider's own account first, then by name.
pub fn ordered(accounts: &[AccountView]) -> Vec<AccountView> {
    let mut out = accounts.to_vec();
    out.sort_by(|a, b| rank(a).cmp(&rank(b)).then((login_of(a) != a.provider).cmp(&(login_of(b) != b.provider))).then_with(|| locale_cmp(&a.id, &b.id)));
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Hand,
    Stop,
    Warn,
}

/// How an account stands: needs you (signed out, or a sign-in under way), stopped (at a usage
/// limit), or not as expected (its CLI missing, its provider unreachable); else connected, with how
/// much of its limit it has used.
#[derive(Clone, Debug, PartialEq)]
pub struct Standing {
    pub mark: Option<Mark>,
    pub words: String,
    /// Percent of its limit used, while it can run.
    pub used: Option<i64>,
}

fn or(s: &str, fallback: &str) -> String {
    if s.is_empty() { fallback.to_string() } else { s.to_string() }
}

pub fn standing_of(account: &AccountView, capability: Option<&Capability>, cli: Option<&CliView>) -> Standing {
    // `Math.round`: halves up.
    let used = (account.used * 100. + 0.5).floor() as i64;
    let s = |mark, words: String, used| Standing { mark, words, used };
    if cli.is_some_and(|c| c.command.is_empty()) {
        return s(Some(Mark::Warn), "CLI missing".into(), None);
    }
    match account.status.as_str() {
        "pending" => return s(Some(Mark::Hand), "Pending".into(), None),
        "signed-out" => return s(Some(Mark::Hand), "Signed out".into(), None),
        "limited" => return s(Some(Mark::Stop), or(&account.problem, "Limited"), Some(used)),
        _ => {}
    }
    let Some(c) = capability else {
        return s(None, "Connected".into(), Some(used));
    };
    if !c.available {
        return s(Some(Mark::Warn), or(&c.problem, "Unavailable"), None);
    }
    s(None, or(&c.problem, "Connected"), Some(used))
}

/// An account to label: its id, its provider, the email its login reports.
pub struct Labeled {
    pub host: String,
    pub provider: String,
    pub email: Option<String>,
}

fn own(a: &Labeled) -> bool {
    a.host == a.provider || a.host.ends_with(&format!(":{}", a.provider))
}

fn provider_name(a: &Labeled) -> String {
    if a.provider == "acp" { a.host.clone() } else { launch_label(&a.provider).map(str::to_string).unwrap_or_else(|| a.provider.clone()) }
}

/// Each account's label by its id: the email its login reports, else its provider's name, numbered
/// past the provider's first ("Codex", "Codex 2"), its own login first.
pub fn account_labels(accounts: &[Labeled]) -> HashMap<String, String> {
    let mut sorted: Vec<&Labeled> = accounts.iter().collect();
    sorted.sort_by(|a, b| own(b).cmp(&own(a)).then_with(|| locale_cmp(&a.host, &b.host)));
    let mut labels = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for a in sorted {
        let name = provider_name(a);
        let n = counts.get(&name).copied().unwrap_or(0) + 1;
        counts.insert(name.clone(), n);
        if !labels.contains_key(&a.host) {
            let numbered = if n == 1 { name } else { format!("{name} {n}") };
            labels.insert(a.host.clone(), a.email.clone().filter(|e| !e.is_empty()).unwrap_or(numbered));
        }
    }
    labels
}

/// The catalog's accounts as labels take them.
pub fn labeled(capabilities: &[Capability]) -> Vec<Labeled> {
    capabilities.iter().map(|c| Labeled { host: c.host.clone(), provider: c.provider.clone(), email: c.email.clone() }).collect()
}

/// An account on its line: its label, its CLI, how it stands.
#[derive(Clone)]
pub struct Row {
    pub account: AccountView,
    pub label: String,
    pub cli: Option<CliView>,
    pub standing: Standing,
}

/// A provider's section: its CLI, its accounts and the models they offer.
#[derive(Clone)]
pub struct Section {
    pub key: String,
    pub provider: String,
    pub cli: Option<CliView>,
    pub rows: Vec<Row>,
    pub models: Vec<String>,
}

/// Its provider's section: a registry agent's own.
fn section_of(a: &AccountView) -> &str {
    if a.provider == "acp" { &a.id } else { &a.provider }
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for i in items {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// The providers in order, each with its CLI, its accounts (each once, shown by the email its login
/// reports) and the models they offer.
pub fn sections(accounts: &[AccountView], clis: &[CliView], capabilities: &[Capability]) -> Vec<Section> {
    let cap = |id: &str| capabilities.iter().find(|c| c.host == id);
    let labels = account_labels(&accounts.iter().map(|a| Labeled { host: a.id.clone(), provider: a.provider.clone(), email: cap(&a.id).and_then(|c| c.email.clone()) }).collect::<Vec<_>>());
    let rows: Vec<Row> = ordered(accounts)
        .into_iter()
        .map(|account| {
            let cli = clis.iter().find(|c| c.provider == account.provider).cloned();
            let label = labels.get(&account.id).cloned().unwrap_or_else(|| account.id.clone());
            let standing = standing_of(&account, cap(&account.id), cli.as_ref());
            Row { account, label, cli, standing }
        })
        .collect();
    unique(rows.iter().map(|r| section_of(&r.account).to_string()))
        .into_iter()
        .map(|key| {
            let own: Vec<Row> = rows.iter().filter(|r| section_of(&r.account) == key).cloned().collect();
            let models = unique(own.iter().flat_map(|r| cap(&r.account.id).map(|c| c.models.clone()).unwrap_or_default()));
            Section {
                provider: own.first().map(|r| r.account.provider.clone()).unwrap_or_else(|| key.clone()),
                cli: own.iter().find_map(|r| r.cli.clone()),
                key,
                rows: own,
                models,
            }
        })
        .collect()
}
